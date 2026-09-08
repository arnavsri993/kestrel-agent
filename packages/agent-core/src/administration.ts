import { createHash, createPublicKey, verify } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentRuntime, RuntimeHook } from "./runtime";

export type MigrationProduct = "openclaw" | "hermes" | "codex" | "claude-code";
export type MigrationCategory =
	| "instructions"
	| "settings"
	| "memory"
	| "skill"
	| "agent";
export type MigrationReviewKind =
	| "automation"
	| "channel-binding"
	| "acp-binding"
	| "plugin"
	| "plugin-load-path";

export interface MigrationSource {
	product: MigrationProduct;
	root: string;
}

export interface MigrationItem {
	product: MigrationProduct;
	category: MigrationCategory;
	sourceRoot: string;
	sourcePath: string;
	destinationPath: string;
	bytes: number;
	sha256: string;
	status: "ready" | "conflict";
}

export interface MigrationPlan {
	createdAt: string;
	targetRoot: string;
	items: MigrationItem[];
	warnings: string[];
	translations: MigrationTranslation[];
	reviewItems: MigrationReviewItem[];
}

export interface MigrationTranslation {
	product: MigrationProduct;
	sourceRoot: string;
	sourcePath: string;
	sourceSha256: string;
	destinationPath: string;
	values: Record<string, string | number | boolean>;
	sha256: string;
}

/**
 * A source-only inventory entry. It deliberately contains no configuration
 * values, credentials, payloads, or executable paths; it exists solely to
 * make a person review a consequential OpenClaw setting before recreating it
 * through Kestrel's own approval and credential boundaries.
 */
export interface MigrationReviewItem {
	product: MigrationProduct;
	sourcePath: string;
	kind: MigrationReviewKind;
	count: number;
	status: "review-required";
}

const relevantNames = new Map<string, MigrationCategory>([
	["AGENTS.md", "instructions"],
	["CLAUDE.md", "instructions"],
	["HERMES.md", "instructions"],
	["openclaw.json", "settings"],
	["settings.json", "settings"],
	["config.json", "settings"],
	["config.toml", "settings"],
	["config.yaml", "settings"],
	["config.yml", "settings"],
	["SKILL.md", "skill"],
]);
const MAX_MIGRATION_FILE_BYTES = 1_000_000;

function contained(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function categoryFor(path: string): MigrationCategory | undefined {
	const direct = relevantNames.get(basename(path));
	if (direct) return direct;
	const normalized = path.split(sep).join("/").toLowerCase();
	if (normalized.includes("/memory/") || normalized.includes("/memories/"))
		return "memory";
	if (normalized.includes("/agents/") && path.endsWith(".md")) return "agent";
	return undefined;
}

function walk(root: string, maximumFiles = 2_000, maximumDepth = 8): string[] {
	const output: string[] = [];
	const queue = [{ path: root, depth: 0 }];
	while (queue.length && output.length < maximumFiles) {
		const current = queue.shift()!;
		for (const entry of readdirSync(current.path, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = join(current.path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && current.depth < maximumDepth)
				queue.push({ path, depth: current.depth + 1 });
			else if (entry.isFile()) output.push(path);
			if (output.length >= maximumFiles) break;
		}
	}
	return output;
}

function scalar(value: string): string | number | boolean {
	const normalized = value.trim().replace(/,$/, "");
	if (/^(true|false)$/i.test(normalized))
		return normalized.toLowerCase() === "true";
	if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
	return normalized.replace(/^['"]|['"]$/g, "");
}

function flattenedSettings(data: Buffer): Record<string, unknown> {
	const text = data.toString("utf8");
	try {
		const parsed = JSON.parse(text) as unknown;
		const output: Record<string, unknown> = {};
		const visit = (value: unknown, prefix = "") => {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				if (prefix) output[prefix] = value;
				return;
			}
			for (const [key, item] of Object.entries(
				value as Record<string, unknown>,
			))
				visit(item, prefix ? `${prefix}.${key}` : key);
		};
		visit(parsed);
		return output;
	} catch {
		const output: Record<string, unknown> = {};
		let section = "";
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.replace(/\s+#.*$/, "").trim();
			const heading = line.match(/^\[([^\]]+)\]$/);
			if (heading) {
				section = heading[1]!;
				continue;
			}
			const pair = line.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/);
			if (pair)
				output[section ? `${section}.${pair[1]}` : pair[1]!] = scalar(pair[2]!);
		}
		return output;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function values(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const item = record(value);
	return item ? Object.values(item) : [];
}

function stringValues(value: unknown): string[] {
	return values(value).filter(
		(item): item is string => typeof item === "string",
	);
}

function isOpenClawCronStore(sourcePath: string): boolean {
	const normalized = sourcePath.split(sep).join("/").toLowerCase();
	return normalized === "cron/jobs.json" || normalized.endsWith("/cron/jobs.json");
}

function openClawReviewItems(
	sourcePath: string,
	data: Buffer,
): MigrationReviewItem[] {
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = record(JSON.parse(data.toString("utf8")));
	} catch {
		return [];
	}
	if (!parsed) return [];
	const create = (kind: MigrationReviewKind, count: number) =>
		count > 0
			? [
					{
						product: "openclaw" as const,
						sourcePath,
						kind,
						count,
						status: "review-required" as const,
					},
				]
			: [];
	if (isOpenClawCronStore(sourcePath))
		return create("automation", values(parsed.jobs).length);
	if (basename(sourcePath).toLowerCase() !== "openclaw.json") return [];

	const reviewItems: MigrationReviewItem[] = [];
	const cron = record(parsed.cron);
	reviewItems.push(...create("automation", values(cron?.jobs).length));
	const bindings = values(parsed.bindings);
	const acpBindings = bindings.filter((binding) => {
		const item = record(binding);
		return item?.type === "acp" || record(item?.match)?.type === "acp";
	});
	reviewItems.push(
		...create("acp-binding", acpBindings.length),
		...create("channel-binding", bindings.length - acpBindings.length),
	);
	const plugins = record(parsed.plugins);
	const entries = record(plugins?.entries);
	const pluginIds = new Set([
		...stringValues(plugins?.allow),
		...stringValues(plugins?.deny),
		...Object.keys(entries ?? {}),
	]);
	const slots = record(plugins?.slots);
	// A global loading switch and slot selections can grant a plugin authority
	// even when no allow/deny/entry id is present. Count only the decisions, not
	// their values, so the dry run prompts review without exposing configuration.
	const pluginDecisionCount =
		pluginIds.size +
		(typeof plugins?.enabled === "boolean" ? 1 : 0) +
		stringValues(slots).length;
	reviewItems.push(...create("plugin", pluginDecisionCount));
	const load = record(plugins?.load);
	reviewItems.push(
		...create("plugin-load-path", stringValues(load?.paths).length),
	);
	return reviewItems;
}

function translationFor(
	product: MigrationProduct,
	sourceRoot: string,
	sourcePath: string,
	destinationPath: string,
	data: Buffer,
): MigrationTranslation | undefined {
	const settings = flattenedSettings(data);
	const keys = Object.entries(settings)
		.filter(
			([key, value]) =>
				!/(api.?key|token|secret|password|credential)/i.test(key) &&
				["string", "number", "boolean"].includes(typeof value),
		)
		.map(([key]) => key);
	const has = (...patterns: RegExp[]) =>
		keys.some((key) => patterns.some((pattern) => pattern.test(key)));
	const values: Record<string, string | number | boolean> = {};
	// Reference-product settings cannot safely become Kestrel settings. Keep only
	// fixed capability signals: arbitrary scalar values may be credentials even
	// when their key looks harmless (for example, a hostile `model` value).
	if (has(/(^|\.)model$/i, /default.?model/i)) values.hasPreferredModel = true;
	if (has(/approval/i, /permission.?mode/i))
		values.hasApprovalConfiguration = true;
	if (has(/sandbox/i, /isolation/i)) values.hasSandboxConfiguration = true;
	if (has(/reasoning/i, /thinking/i)) values.hasReasoningConfiguration = true;
	if (has(/(^|\.)mcp([_.]|$)/i)) values.hasMcpConfiguration = true;
	if (has(/memory|memories/i)) values.hasMemoryConfiguration = true;
	if (Object.keys(values).length === 0) return undefined;
	const payload =
		JSON.stringify(
			{ schemaVersion: 1, sourceProduct: product, sourcePath, values },
			null,
			2,
		) + "\n";
	return {
		product,
		sourceRoot,
		sourcePath,
		sourceSha256: createHash("sha256").update(data).digest("hex"),
		destinationPath,
		values,
		sha256: createHash("sha256").update(payload).digest("hex"),
	};
}

function translationDestination(
	product: MigrationProduct,
	sourcePath: string,
): string {
	return join(
		"imports",
		product,
		".translated",
		`${sourcePath.replace(/[\\/]/g, "--")}.json`,
	);
}

function sameTranslation(
	actual: MigrationTranslation,
	expected: MigrationTranslation,
): boolean {
	return (
		actual.product === expected.product &&
		actual.sourceRoot === expected.sourceRoot &&
		actual.sourcePath === expected.sourcePath &&
		actual.sourceSha256 === expected.sourceSha256 &&
		actual.destinationPath === expected.destinationPath &&
		actual.sha256 === expected.sha256 &&
		JSON.stringify(actual.values) === JSON.stringify(expected.values)
	);
}

export class MigrationManager {
	constructor(private readonly now: () => Date = () => new Date()) {}

	plan(sources: MigrationSource[], targetRoot: string): MigrationPlan {
		const target = resolve(targetRoot);
		const items: MigrationItem[] = [];
		const warnings: string[] = [];
		const translations: MigrationTranslation[] = [];
		const reviewItems: MigrationReviewItem[] = [];
		for (const source of sources) {
			if (!existsSync(source.root) || !statSync(source.root).isDirectory()) {
				warnings.push(`${source.product}: source directory was not found.`);
				continue;
			}
			const root = realpathSync(source.root);
			for (const path of walk(root)) {
				const canonical = realpathSync(path);
				if (!contained(root, canonical)) continue;
				const category = categoryFor(canonical);
				const sourcePath = relative(root, canonical);
				const reviewOnly =
					source.product === "openclaw" && isOpenClawCronStore(sourcePath);
				if (!category && !reviewOnly) continue;
				const size = statSync(canonical).size;
				if (size > MAX_MIGRATION_FILE_BYTES) {
					warnings.push(
						`${source.product}: skipped ${relative(root, canonical)} because it exceeds 1 MB.`,
					);
					continue;
				}
				const data = readFileSync(canonical);
				if (data.includes(0)) {
					warnings.push(
						`${source.product}: skipped binary file ${relative(root, canonical)}.`,
					);
					continue;
				}
				if (source.product === "openclaw")
					reviewItems.push(...openClawReviewItems(sourcePath, data));
				if (category === "settings") {
					const translated = translationFor(
						source.product,
						root,
						sourcePath,
						translationDestination(source.product, sourcePath),
						data,
					);
					if (translated) translations.push(translated);
					else
						warnings.push(
							`${source.product}: ${sourcePath} had no recognized non-secret settings to translate.`,
						);
					warnings.push(
						`${source.product}: ${sourcePath} is reviewed for non-secret settings only; raw settings files are never imported.`,
					);
					continue;
				}
				if (reviewOnly) continue;
				if (!category) continue;
				const destinationPath = join("imports", source.product, sourcePath);
				items.push({
					product: source.product,
					category,
					sourceRoot: root,
					sourcePath,
					destinationPath,
					bytes: size,
					sha256: createHash("sha256").update(data).digest("hex"),
					status: existsSync(resolve(target, destinationPath))
						? "conflict"
						: "ready",
				});
			}
		}
		reviewItems.sort((left, right) =>
			left.sourcePath.localeCompare(right.sourcePath),
		);
		return {
			createdAt: this.now().toISOString(),
			targetRoot: target,
			items,
			warnings,
			translations,
			reviewItems,
		};
	}

	apply(
		plan: MigrationPlan,
		options: { approved: boolean; overwrite?: boolean },
	): { imported: string[]; skipped: string[] } {
		if (!options.approved)
			throw new Error("Migration import requires explicit approval.");
		const target = resolve(plan.targetRoot);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		const imported: string[] = [];
		const skipped: string[] = [];
		for (const item of plan.items) {
			if (item.category === "settings")
				throw new Error("Migration plans may not import raw settings files.");
			const sourceRoot = realpathSync(item.sourceRoot);
			const source = realpathSync(resolve(sourceRoot, item.sourcePath));
			if (!contained(sourceRoot, source))
				throw new Error("Migration source escaped its declared root.");
			const destination = resolve(target, item.destinationPath);
			if (!contained(target, destination))
				throw new Error("Migration destination escaped its target root.");
			const sourceMetadata = statSync(source);
			if (
				!sourceMetadata.isFile() ||
				sourceMetadata.size > MAX_MIGRATION_FILE_BYTES
			)
				throw new Error(
					`Migration source changed after planning: ${item.sourcePath}`,
				);
			const data = readFileSync(source);
			if (data.byteLength > MAX_MIGRATION_FILE_BYTES)
				throw new Error(
					`Migration source changed after planning: ${item.sourcePath}`,
				);
			const checksum = createHash("sha256").update(data).digest("hex");
			if (checksum !== item.sha256)
				throw new Error(
					`Migration source changed after planning: ${item.sourcePath}`,
				);
			if (existsSync(destination) && !options.overwrite) {
				skipped.push(item.destinationPath);
				continue;
			}
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			writeFileSync(destination, data, { mode: 0o600 });
			imported.push(item.destinationPath);
		}
		for (const translation of plan.translations ?? []) {
			if (!translation.sourceRoot || !translation.sourceSha256)
				throw new Error(
					"Migration translation is missing the source integrity record.",
				);
			const sourceRoot = realpathSync(translation.sourceRoot);
			const source = realpathSync(
				resolve(sourceRoot, translation.sourcePath),
			);
			if (!contained(sourceRoot, source))
				throw new Error("Migration translation source escaped its declared root.");
			const sourceMetadata = statSync(source);
			if (
				!sourceMetadata.isFile() ||
				sourceMetadata.size > MAX_MIGRATION_FILE_BYTES
			)
				throw new Error(
					`Migration source changed after planning: ${translation.sourcePath}`,
				);
			const sourceData = readFileSync(source);
			if (
				sourceData.byteLength > MAX_MIGRATION_FILE_BYTES ||
				createHash("sha256").update(sourceData).digest("hex") !==
					translation.sourceSha256
			)
				throw new Error(
					`Migration source changed after planning: ${translation.sourcePath}`,
				);
			const expected = translationFor(
				translation.product,
				sourceRoot,
				translation.sourcePath,
				translationDestination(translation.product, translation.sourcePath),
				sourceData,
			);
			if (!expected || !sameTranslation(translation, expected))
				throw new Error(
					`Migration translation changed after planning: ${translation.sourcePath}`,
				);
			const destination = resolve(target, expected.destinationPath);
			if (!contained(target, destination))
				throw new Error(
					"Migration translation destination escaped its target root.",
				);
			const payload =
				JSON.stringify(
					{
						schemaVersion: 1,
						sourceProduct: expected.product,
						sourcePath: expected.sourcePath,
						values: expected.values,
					},
					null,
					2,
				) + "\n";
			if (
				createHash("sha256").update(payload).digest("hex") !==
				expected.sha256
			)
				throw new Error(
					`Migration translation changed after planning: ${expected.sourcePath}`,
				);
			if (existsSync(destination) && !options.overwrite) {
				skipped.push(expected.destinationPath);
				continue;
			}
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			writeFileSync(destination, payload, { mode: 0o600 });
			imported.push(expected.destinationPath);
		}
		return { imported, skipped };
	}
}

export interface ManagedPolicy {
	organizationId: string;
	version: number;
	allowedProviders?: string[];
	allowedTools?: string[];
	deniedTools: string[];
	maximumWorkers: number;
	retentionDays?: number;
	analyticsEnabled?: boolean;
	sso?: {
		issuer: string;
		audience: string;
		publicKeyPem: string;
		allowedDomains?: string[];
	};
	updatedAt: string;
}

export interface OrganizationMember {
	externalId: string;
	email: string;
	displayName: string;
	role: "member" | "admin";
	active: boolean;
	updatedAt: string;
}
export interface OrganizationIdentity {
	subject: string;
	email: string;
	role: OrganizationMember["role"];
	issuer: string;
	expiresAt: string;
}

const MAX_ORGANIZATION_MEMBER_EXTERNAL_ID_LENGTH = 500;
const MAX_ORGANIZATION_MEMBER_EMAIL_LENGTH = 320;
const MAX_ORGANIZATION_MEMBER_DISPLAY_NAME_LENGTH = 200;

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function loadSignedManagedPolicy(
	envelopePath: string,
	publicKeyPath: string,
): Omit<ManagedPolicy, "updatedAt"> {
	const envelopeMetadata = lstatSync(envelopePath);
	const keyMetadata = lstatSync(publicKeyPath);
	if (
		!envelopeMetadata.isFile() ||
		envelopeMetadata.isSymbolicLink() ||
		envelopeMetadata.size > 1_000_000 ||
		(envelopeMetadata.mode & 0o077) !== 0
	)
		throw new Error(
			"Managed policy envelope must be an owner-only regular file no larger than 1 MB.",
		);
	if (
		!keyMetadata.isFile() ||
		keyMetadata.isSymbolicLink() ||
		keyMetadata.size > 100_000
	)
		throw new Error(
			"Managed policy public key must be a bounded regular file.",
		);
	let envelope: {
		algorithm?: unknown;
		policy?: unknown;
		signatureBase64?: unknown;
	};
	try {
		const parsed = JSON.parse(
			readFileSync(realpathSync(envelopePath), "utf8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error();
		envelope = parsed as {
			algorithm?: unknown;
			policy?: unknown;
			signatureBase64?: unknown;
		};
	} catch {
		throw new Error("Managed policy signature envelope is invalid.");
	}
	if (
		envelope.algorithm !== "Ed25519" ||
		!envelope.policy ||
		typeof envelope.policy !== "object" ||
		typeof envelope.signatureBase64 !== "string"
	)
		throw new Error("Managed policy signature envelope is invalid.");
	const signature = Buffer.from(envelope.signatureBase64, "base64");
	if (
		signature.byteLength !== 64 ||
		signature.toString("base64") !== envelope.signatureBase64
	)
		throw new Error("Managed policy signature is invalid.");
	const payload = envelope.policy as Omit<ManagedPolicy, "updatedAt">;
	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		publicKey = createPublicKey(readFileSync(realpathSync(publicKeyPath)));
	} catch {
		throw new Error("Managed policy public key is invalid.");
	}
	if (!verify(null, Buffer.from(canonical(payload)), publicKey, signature))
		throw new Error("Managed policy signature verification failed.");
	return payload;
}

export class ManagedPolicyStore {
	private readonly key = "enterprise.managed-policy";
	private readonly membersKey = "enterprise.members";
	constructor(
		private readonly database: KestrelDatabase,
		private readonly now: () => Date = () => new Date(),
	) {}

	get(): ManagedPolicy | undefined {
		return this.database.getPrivateState<ManagedPolicy>(this.key);
	}

	set(policy: Omit<ManagedPolicy, "updatedAt">): ManagedPolicy {
		if (!policy.organizationId.trim())
			throw new Error("Managed policy requires an organization ID.");
		if (!Number.isInteger(policy.version) || policy.version < 1)
			throw new Error("Managed policy version must be a positive integer.");
		if (
			!Number.isInteger(policy.maximumWorkers) ||
			policy.maximumWorkers < 1 ||
			policy.maximumWorkers > 64
		)
			throw new Error("maximumWorkers must be between 1 and 64.");
		if (
			policy.retentionDays !== undefined &&
			(!Number.isInteger(policy.retentionDays) ||
				policy.retentionDays < 1 ||
				policy.retentionDays > 3_650)
		)
			throw new Error("retentionDays must be between 1 and 3650.");
		if (policy.sso) {
			if (
				!URL.canParse(policy.sso.issuer) ||
				!policy.sso.issuer.startsWith("https://") ||
				!policy.sso.audience.trim()
			)
				throw new Error("Managed SSO issuer or audience is invalid.");
			try {
				createPublicKey(policy.sso.publicKeyPem);
			} catch {
				throw new Error("Managed SSO public key is invalid.");
			}
		}
		const normalized = {
			...policy,
			deniedTools: [...new Set(policy.deniedTools)],
		};
		const current = this.get();
		if (current && policy.version <= current.version) {
			const { updatedAt: _updatedAt, ...currentPolicy } = current;
			if (
				policy.version === current.version &&
				canonical(normalized) === canonical(currentPolicy)
			)
				return current;
			throw new Error("Managed policy updates require a newer version.");
		}
		const stored = {
			...normalized,
			updatedAt: this.now().toISOString(),
		};
		this.database.setPrivateState(this.key, stored);
		return stored;
	}

	assertProviderAllowed(providerId: string): void {
		const allowed = this.get()?.allowedProviders;
		if (allowed && !allowed.includes(providerId))
			throw new Error(`Provider ${providerId} is blocked by managed policy.`);
	}

	analytics() {
		if (this.get()?.analyticsEnabled === false)
			throw new Error("Organization analytics are disabled by policy.");
		return this.database.organizationAnalytics();
	}

	enforceRetention(): {
		cutoff: string;
		deleted: ReturnType<KestrelDatabase["enforceRetention"]>;
	} {
		const days = this.get()?.retentionDays;
		if (!days) throw new Error("Organization retention is not configured.");
		const cutoff = new Date(
			this.now().getTime() - days * 86_400_000,
		).toISOString();
		return { cutoff, deleted: this.database.enforceRetention(cutoff) };
	}

	listMembers(): OrganizationMember[] {
		const stored = this.database.getPrivateState<unknown>(this.membersKey);
		return Array.isArray(stored) ? (stored as OrganizationMember[]) : [];
	}

	provisionMember(
		input: Omit<OrganizationMember, "active" | "updatedAt"> & {
			active?: boolean;
		},
	): OrganizationMember {
		if (!this.get()) throw new Error("Organization policy is not configured.");
		if (
			typeof input.externalId !== "string" ||
			typeof input.email !== "string" ||
			typeof input.displayName !== "string" ||
			!input.externalId.trim() ||
			input.externalId.length > MAX_ORGANIZATION_MEMBER_EXTERNAL_ID_LENGTH ||
			input.email.length > MAX_ORGANIZATION_MEMBER_EMAIL_LENGTH ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
			!input.displayName.trim() ||
			input.displayName.length > MAX_ORGANIZATION_MEMBER_DISPLAY_NAME_LENGTH ||
			!["member", "admin"].includes(input.role) ||
			(input.active !== undefined && typeof input.active !== "boolean")
		)
			throw new Error("Organization member is invalid.");
		const members = this.listMembers();
		const existing = members.find(
			(member) => member.externalId === input.externalId,
		);
		const member: OrganizationMember = {
			externalId: input.externalId,
			email: input.email.toLowerCase(),
			displayName: input.displayName,
			role: input.role,
			active: input.active ?? true,
			updatedAt: this.now().toISOString(),
		};
		this.database.setPrivateState(this.membersKey, [
			...members.filter(
				(candidate) =>
					candidate.externalId !== input.externalId &&
					candidate.email !== member.email,
			),
			member,
		]);
		return existing ? { ...member } : member;
	}

	deactivateMember(externalId: string): OrganizationMember {
		const member = this.listMembers().find(
			(candidate) => candidate.externalId === externalId,
		);
		if (!member) throw new Error("Organization member not found.");
		return this.provisionMember({ ...member, active: false });
	}

	verifyIdentityToken(token: string): OrganizationIdentity {
		const policy = this.get();
		if (!policy?.sso) throw new Error("Managed SSO is not configured.");
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => !part))
			throw new Error("SSO identity token is malformed.");
		let header: Record<string, unknown>;
		let payload: Record<string, unknown>;
		try {
			header = JSON.parse(
				Buffer.from(parts[0]!, "base64url").toString("utf8"),
			) as Record<string, unknown>;
			payload = JSON.parse(
				Buffer.from(parts[1]!, "base64url").toString("utf8"),
			) as Record<string, unknown>;
		} catch {
			throw new Error("SSO identity token is malformed.");
		}
		if (
			header.alg !== "EdDSA" ||
			!verify(
				null,
				Buffer.from(`${parts[0]}.${parts[1]}`),
				createPublicKey(policy.sso.publicKeyPem),
				Buffer.from(parts[2]!, "base64url"),
			)
		)
			throw new Error("SSO identity signature verification failed.");
		const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (
			payload.iss !== policy.sso.issuer ||
			!audience.includes(policy.sso.audience) ||
			typeof payload.sub !== "string" ||
			typeof payload.email !== "string" ||
			typeof payload.exp !== "number" ||
			payload.exp * 1_000 <= this.now().getTime()
		)
			throw new Error("SSO identity claims are invalid or expired.");
		const subject = payload.sub as string;
		const email = (payload.email as string).toLowerCase();
		const expires = payload.exp as number;
		const domain = email.split("@")[1];
		if (
			policy.sso.allowedDomains?.length &&
			(!domain || !policy.sso.allowedDomains.includes(domain))
		)
			throw new Error("SSO email domain is not allowed.");
		const member = this.listMembers().find(
			(candidate) =>
				candidate.externalId === subject &&
				candidate.email === email &&
				candidate.active,
		);
		if (!member)
			throw new Error("SSO identity is not an active provisioned member.");
		return {
			subject: member.externalId,
			email: member.email,
			role: member.role,
			issuer: policy.sso.issuer,
			expiresAt: new Date(expires * 1_000).toISOString(),
		};
	}

	runtimeHook(): RuntimeHook {
		return {
			id: "enterprise-managed-tool-policy",
			event: "pre_tool",
			run: ({ tool }) => {
				const policy = this.get();
				if (!policy) return {};
				if (policy.deniedTools.includes(tool.name))
					return {
						blocked: true,
						reason: `Tool ${tool.name} is denied by organization policy.`,
					};
				if (policy.allowedTools && !policy.allowedTools.includes(tool.name))
					return {
						blocked: true,
						reason: `Tool ${tool.name} is outside the organization allowlist.`,
					};
				return {};
			},
		};
	}
}

export function installManagedPolicy(
	runtime: AgentRuntime,
	store: ManagedPolicyStore,
): void {
	runtime.registerHook(store.runtimeHook());
}
