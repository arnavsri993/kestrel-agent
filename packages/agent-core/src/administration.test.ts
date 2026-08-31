import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import {
	installManagedPolicy,
	loadSignedManagedPolicy,
	ManagedPolicyStore,
	MigrationManager,
} from "./administration";
import { AgentRuntime } from "./runtime";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("reference-product migration", () => {
	it("creates a bounded dry-run plan and applies only after approval", () => {
		const source = mkdtempSync(join(tmpdir(), "kestrel-codex-import-"));
		const target = mkdtempSync(join(tmpdir(), "kestrel-import-target-"));
		directories.push(source, target);
		mkdirSync(join(source, "skills", "review"), { recursive: true });
		writeFileSync(join(source, "AGENTS.md"), "Inspect before editing.\n");
		writeFileSync(
			join(source, "config.toml"),
			"model = 'gpt-test'\napproval_policy = 'on-request'\napi_key = 'must-not-translate'\n",
		);
		writeFileSync(
			join(source, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code.\n---\n",
		);
		writeFileSync(join(source, "ignored.bin"), Buffer.from([0, 1, 2]));
		const manager = new MigrationManager(
			() => new Date("2026-07-22T21:00:00.000Z"),
		);
		const plan = manager.plan([{ product: "codex", root: source }], target);
		expect(plan.items.map((item) => item.category).sort()).toEqual([
			"instructions",
			"skill",
		]);
		expect(plan.translations).toMatchObject([
			{
				product: "codex",
				values: { hasPreferredModel: true, hasApprovalConfiguration: true },
			},
		]);
		expect(JSON.stringify(plan.translations)).not.toContain(
			"must-not-translate",
		);
		expect(plan.warnings).toContain(
			"codex: config.toml is reviewed for non-secret settings only; raw settings files are never imported.",
		);
		expect(() => manager.apply(plan, { approved: false })).toThrow(
			"explicit approval",
		);
		const applied = manager.apply(plan, { approved: true });
		expect(applied.imported).toHaveLength(3);
		expect(
			readFileSync(join(target, "imports", "codex", "AGENTS.md"), "utf8"),
		).toContain("Inspect before editing");
		expect(existsSync(join(target, "imports", "codex", "config.toml"))).toBe(
			false,
		);
		expect(
			JSON.parse(
				readFileSync(
					join(target, plan.translations[0]!.destinationPath),
					"utf8",
				),
			),
		).toMatchObject({
			schemaVersion: 1,
			values: { hasPreferredModel: true, hasApprovalConfiguration: true },
		});
		expect(manager.apply(plan, { approved: true }).skipped).toHaveLength(3);
	});

	it("inventories OpenClaw automations, bindings, and plugins without copying their configuration", () => {
		const source = mkdtempSync(join(tmpdir(), "kestrel-openclaw-import-"));
		const target = mkdtempSync(join(tmpdir(), "kestrel-openclaw-target-"));
		directories.push(source, target);
		mkdirSync(join(source, "cron"), { recursive: true });
		writeFileSync(join(source, "AGENTS.md"), "Keep source data private.\n");
		writeFileSync(
			join(source, "openclaw.json"),
			JSON.stringify({
				model: "openclaw-test-model",
				apiKey: "should-never-appear",
				cron: { jobs: [{ id: "embedded-job", payload: { text: "private" } }] },
				bindings: [
					{ agentId: "main", match: { channel: "discord" } },
					{ type: "acp", agentId: "editor" },
				],
				plugins: {
					enabled: true,
					allow: ["plugin-a"],
					deny: ["plugin-b"],
					entries: {
						"plugin-a": { enabled: true, config: { token: "private" } },
						"plugin-c": { enabled: false },
					},
					slots: {
						memory: "plugin-a",
						contextEngine: "plugin-c",
					},
					load: { paths: ["/private/one", "/private/two"] },
				},
			}),
		);
		writeFileSync(
			join(source, "cron", "jobs.json"),
			JSON.stringify({
				version: 1,
				jobs: [
					{ id: "scheduled-one", payload: { argv: ["private"] } },
					{ id: "scheduled-two", delivery: { webhook: "private" } },
				],
			}),
		);

		const plan = new MigrationManager().plan(
			[{ product: "openclaw", root: source }],
			target,
		);
		expect(plan.items.map((item) => item.sourcePath)).toEqual(["AGENTS.md"]);
		expect(plan.translations).toMatchObject([
			{
				sourcePath: "openclaw.json",
				values: { hasPreferredModel: true },
			},
		]);
		expect(plan.reviewItems).toEqual([
			{
				product: "openclaw",
				sourcePath: "cron/jobs.json",
				kind: "automation",
				count: 2,
				status: "review-required",
			},
			{
				product: "openclaw",
				sourcePath: "openclaw.json",
				kind: "automation",
				count: 1,
				status: "review-required",
			},
			{
				product: "openclaw",
				sourcePath: "openclaw.json",
				kind: "acp-binding",
				count: 1,
				status: "review-required",
			},
			{
				product: "openclaw",
				sourcePath: "openclaw.json",
				kind: "channel-binding",
				count: 1,
				status: "review-required",
			},
			{
				product: "openclaw",
				sourcePath: "openclaw.json",
				kind: "plugin",
				count: 6,
				status: "review-required",
			},
			{
				product: "openclaw",
				sourcePath: "openclaw.json",
				kind: "plugin-load-path",
				count: 2,
				status: "review-required",
			},
		]);
		expect(JSON.stringify(plan)).not.toContain("should-never-appear");
		expect(JSON.stringify(plan)).not.toContain('"private"');

		const result = new MigrationManager().apply(plan, { approved: true });
		expect(result.imported).toHaveLength(2);
		expect(existsSync(join(target, "imports", "openclaw", "openclaw.json"))).toBe(
			false,
		);
		expect(existsSync(join(target, "imports", "openclaw", "cron", "jobs.json"))).toBe(
			false,
		);
	});

	it("rejects raw settings and rechecks the source for a sanitized translation", () => {
		const source = mkdtempSync(join(tmpdir(), "kestrel-settings-import-"));
		const target = mkdtempSync(join(tmpdir(), "kestrel-settings-target-"));
		directories.push(source, target);
		const settingsPath = join(source, "config.toml");
		writeFileSync(
			settingsPath,
			"model = 'sk-source-value-that-must-not-leak'\napi_key = 'private'\n",
		);
		const manager = new MigrationManager();
		const plan = manager.plan([{ product: "codex", root: source }], target);
		expect(plan.items).toEqual([]);
		expect(plan.translations).toHaveLength(1);
		expect(JSON.stringify(plan)).not.toContain("sk-source-value-that-must-not-leak");
		const forged = structuredClone(plan);
		forged.translations[0]!.values = {
			hasPreferredModel: true,
			unsafeSetting: "private",
		};
		const forgedPayload =
			JSON.stringify(
				{
					schemaVersion: 1,
					sourceProduct: forged.translations[0]!.product,
					sourcePath: forged.translations[0]!.sourcePath,
					values: forged.translations[0]!.values,
				},
				null,
				2,
			) + "\n";
		forged.translations[0]!.sha256 = createHash("sha256")
			.update(forgedPayload)
			.digest("hex");
		expect(() => manager.apply(forged, { approved: true })).toThrow(
			"Migration translation changed after planning: config.toml",
		);
		writeFileSync(settingsPath, "model = 'changed'\napi_key = 'private'\n");
		expect(() => manager.apply(plan, { approved: true })).toThrow(
			"Migration source changed after planning: config.toml",
		);

		const rawSettingsPlan = structuredClone(plan);
		rawSettingsPlan.items.push({
			product: "codex",
			category: "settings",
			sourceRoot: source,
			sourcePath: "config.toml",
			destinationPath: "imports/codex/config.toml",
			bytes: 1,
			sha256: "0".repeat(64),
			status: "ready",
		});
		expect(() => manager.apply(rawSettingsPlan, { approved: true })).toThrow(
			"may not import raw settings files",
		);
	});

	it("rejects a migration source that grows beyond the plan limit", () => {
		const source = mkdtempSync(join(tmpdir(), "kestrel-codex-import-large-"));
		const target = mkdtempSync(join(tmpdir(), "kestrel-import-target-large-"));
		directories.push(source, target);
		const sourcePath = join(source, "AGENTS.md");
		writeFileSync(sourcePath, "Inspect before editing.\n");
		const manager = new MigrationManager();
		const plan = manager.plan([{ product: "codex", root: source }], target);
		writeFileSync(sourcePath, Buffer.alloc(1_000_001));

		expect(() => manager.apply(plan, { approved: true })).toThrow(
			"source changed after planning",
		);
	});
});

describe("managed organization policy", () => {
	it("enforces retention, exposes content-free analytics, and verifies provisioned SSO identities", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const now = new Date("2026-07-22T21:00:00.000Z");
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const store = new ManagedPolicyStore(database, () => now);
		store.set({
			organizationId: "org-enterprise",
			version: 1,
			deniedTools: [],
			maximumWorkers: 4,
			retentionDays: 30,
			analyticsEnabled: true,
			sso: {
				issuer: "https://identity.example.test",
				audience: "kestrel",
				publicKeyPem: publicKey
					.export({ type: "spki", format: "pem" })
					.toString(),
				allowedDomains: ["example.test"],
			},
		});
		expect(() =>
			store.set({
				organizationId: "org-enterprise",
				version: 2,
				deniedTools: [],
				maximumWorkers: 4,
				sso: {
					issuer: "https://identity.example.test",
					audience: "kestrel",
					publicKeyPem: "not a public key",
				},
			}),
		).toThrow("Managed SSO public key is invalid.");
		store.provisionMember({
			externalId: "user-1",
			email: "admin@example.test",
			displayName: "Admin",
			role: "admin",
		});
		const encode = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const header = encode({ alg: "EdDSA", typ: "JWT" });
		const payload = encode({
			iss: "https://identity.example.test",
			aud: "kestrel",
			sub: "user-1",
			email: "admin@example.test",
			exp: Math.floor(now.getTime() / 1_000) + 3_600,
		});
		const signature = sign(
			null,
			Buffer.from(`${header}.${payload}`),
			privateKey,
		).toString("base64url");
		expect(
			store.verifyIdentityToken(`${header}.${payload}.${signature}`),
		).toMatchObject({
			subject: "user-1",
			role: "admin",
			email: "admin@example.test",
		});
		expect(() =>
			store.verifyIdentityToken("bm90LWpzb24.eyJub3QiOiJqc29uIn0.signature"),
		).toThrow("SSO identity token is malformed.");
		expect(store.analytics()).toMatchObject({
			sessions: 0,
			modelCalls: 0,
			estimatedCostUsd: 0,
		});
		database.addActivity({
			id: "old",
			title: "Old",
			detail: "expired",
			timestamp: "2026-01-01T00:00:00.000Z",
			status: "verified",
			sourceIds: [],
		});
		database.addActivity({
			id: "new",
			title: "New",
			detail: "retained",
			timestamp: "2026-07-22T20:00:00.000Z",
			status: "verified",
			sourceIds: [],
		});
		expect(store.enforceRetention()).toMatchObject({
			cutoff: "2026-06-22T21:00:00.000Z",
			deleted: { activity: 1 },
		});
		expect(database.listActivity().map((item) => item.id)).toEqual(["new"]);
		expect(store.deactivateMember("user-1").active).toBe(false);
		expect(() =>
			store.verifyIdentityToken(`${header}.${payload}.${signature}`),
		).toThrow("active provisioned member");
		database.close();
	});

	it("bounds organization member identity fields and rejects invalid runtime values", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new ManagedPolicyStore(database);
		store.set({
			organizationId: "org-members",
			version: 1,
			deniedTools: [],
			maximumWorkers: 2,
		});
		const valid = {
			externalId: "user-1",
			email: "user@example.test",
			displayName: "User",
			role: "member" as const,
		};
		expect(() =>
			store.provisionMember({ ...valid, externalId: "x".repeat(501) }),
		).toThrow("invalid");
		expect(() =>
			store.provisionMember({
				...valid,
				email: `${"x".repeat(310)}@example.test`,
			}),
		).toThrow("invalid");
		expect(() =>
			store.provisionMember({ ...valid, displayName: "x".repeat(201) }),
		).toThrow("invalid");
		expect(() =>
			store.provisionMember({ ...valid, role: "owner" as never }),
		).toThrow("invalid");
		expect(() =>
			store.provisionMember({ ...valid, active: "yes" as never }),
		).toThrow("invalid");
		database.close();
	});

	it("persists encrypted versioned policy and blocks tools and providers", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-policy-"));
		directories.push(root);
		writeFileSync(join(root, "README.md"), "private\n");
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new ManagedPolicyStore(
			database,
			() => new Date("2026-07-22T21:00:00.000Z"),
		);
		const policy = {
			organizationId: "org-test",
			version: 1,
			deniedTools: ["workspace.read"],
			allowedProviders: ["local"],
			maximumWorkers: 2,
		};
		const storedPolicy = store.set(policy);
		expect(store.set(policy)).toEqual(storedPolicy);
		expect(() => store.assertProviderAllowed("hosted")).toThrow(
			"blocked by managed policy",
		);
		const runtime = new AgentRuntime(database, [root]);
		installManagedPolicy(runtime, store);
		const session = runtime.createSession({
			title: "Managed",
			workspaceRoot: root,
		});
		const result = await runtime.callTool(session.id, "workspace.read", {
			path: "README.md",
		});
		expect(result).toMatchObject({
			status: "blocked",
			error: expect.stringContaining("organization policy"),
		});
		const ciphertext = database.db
			.prepare(
				"SELECT value_ciphertext FROM private_runtime_state WHERE key = ?",
			)
			.get("enterprise.managed-policy") as { value_ciphertext: string };
		expect(ciphertext.value_ciphertext).not.toContain("org-test");
		expect(() =>
			store.set({
				organizationId: "org-test",
				version: 1,
				deniedTools: [],
				maximumWorkers: 3,
			}),
		).toThrow("newer version");
		expect(existsSync(root)).toBe(true);
		database.close();
	});

	it("recovers when persisted organization members are not an array", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new ManagedPolicyStore(
			database,
			() => new Date("2026-07-22T21:00:00.000Z"),
		);
		store.set({
			organizationId: "org-test",
			version: 1,
			deniedTools: [],
			maximumWorkers: 2,
		});
		database.setPrivateState("enterprise.members", { corrupted: true });
		expect(store.listMembers()).toEqual([]);
		expect(
			store.provisionMember({
				externalId: "user-1",
				email: "user@example.test",
				displayName: "User",
				role: "member",
			}),
		).toMatchObject({ externalId: "user-1" });
		expect(store.listMembers()).toHaveLength(1);
		database.close();
	});

	it("loads only correctly signed monotonic policy envelopes", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-signed-policy-"));
		directories.push(root);
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const policy = {
			allowedProviders: ["local"],
			deniedTools: ["shell.run"],
			maximumWorkers: 2,
			organizationId: "org-signed",
			version: 3,
		};
		const canonical = (value: unknown): string =>
			Array.isArray(value)
				? `[${value.map(canonical).join(",")}]`
				: value && typeof value === "object"
					? `{${Object.entries(value as Record<string, unknown>)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
							.join(",")}}`
					: JSON.stringify(value);
		const envelopePath = join(root, "policy.json");
		const keyPath = join(root, "policy.pub");
		writeFileSync(keyPath, publicKey.export({ type: "spki", format: "pem" }));
		const signatureBase64 = sign(
			null,
			Buffer.from(canonical(policy)),
			privateKey,
		).toString("base64");
		writeFileSync(
			envelopePath,
			JSON.stringify({ algorithm: "Ed25519", policy, signatureBase64 }),
			{ mode: 0o600 },
		);
		expect(loadSignedManagedPolicy(envelopePath, keyPath)).toEqual(policy);
		writeFileSync(envelopePath, "not json", { mode: 0o600 });
		expect(() => loadSignedManagedPolicy(envelopePath, keyPath)).toThrow(
			"Managed policy signature envelope is invalid.",
		);
		writeFileSync(
			envelopePath,
			JSON.stringify({ algorithm: "Ed25519", policy, signatureBase64 }),
			{ mode: 0o600 },
		);
		writeFileSync(keyPath, "not a public key");
		expect(() => loadSignedManagedPolicy(envelopePath, keyPath)).toThrow(
			"Managed policy public key is invalid.",
		);
		writeFileSync(keyPath, publicKey.export({ type: "spki", format: "pem" }));
		writeFileSync(
			envelopePath,
			JSON.stringify({
				algorithm: "Ed25519",
				policy: { ...policy, maximumWorkers: 9 },
				signatureBase64,
			}),
			{ mode: 0o600 },
		);
		expect(() => loadSignedManagedPolicy(envelopePath, keyPath)).toThrow(
			"verification failed",
		);
	});
});
