import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Explicit Electron Application Support → native Chromium durable-profile
 * transfer. Never touches Keychain, cookies, OAuth caches, or the encrypted
 * desktop database. Dry-run first; apply requires approval and defaults to
 * no-overwrite with a recoverable target backup.
 */

export const ELECTRON_NATIVE_TRANSFER_KIND = "electron-native-transfer" as const;
export const ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION = 1 as const;

export type ElectronNativeTransferCategory =
	| "instructions"
	| "skill"
	| "agent"
	| "browser-library"
	| "settings-signal";

export interface ElectronNativeTransferItem {
	category: ElectronNativeTransferCategory;
	sourceRoot: string;
	sourcePath: string;
	destinationPath: string;
	bytes: number;
	sha256: string;
	status: "ready" | "conflict";
	/** Present when apply writes synthesized content instead of a raw copy. */
	payloadSha256?: string;
	payload?: string;
}

export interface ElectronNativeRejectedPath {
	path: string;
	reason: string;
}

export interface ElectronNativeTransferPlan {
	kind: typeof ELECTRON_NATIVE_TRANSFER_KIND;
	schemaVersion: typeof ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION;
	createdAt: string;
	sourceRoot: string;
	targetRoot: string;
	items: ElectronNativeTransferItem[];
	warnings: string[];
	rejected: ElectronNativeRejectedPath[];
}

export interface ElectronNativeTransferResult {
	imported: string[];
	skipped: string[];
	backupRoot: string | null;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_BROWSER_STATE_BYTES = 5_000_000;
const MAX_WALK_FILES = 2_000;
const MAX_WALK_DEPTH = 8;

const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "HERMES.md"]);

const REJECTED_ROOT_NAMES = new Set([
	"database",
	"secure",
	"Cookies",
	"Cookies-journal",
	"Network",
	"Local Storage",
	"Session Storage",
	"IndexedDB",
	"Cache",
	"Code Cache",
	"GPUCache",
	"blob_storage",
	"Service Worker",
	"WebStorage",
	"provider-profiles",
	"composer-attachments",
	"recovery",
]);

const REJECTED_FILE_NAMES = new Set([
	"provider-accounts.json",
	"Cookies",
	"Cookies-journal",
	"Network Persistent State",
	"Trust Tokens",
	"Trust Tokens-journal",
	"Login Data",
	"Login Data-journal",
	"Web Data",
	"Web Data-journal",
	"Preferences",
	"Secure Preferences",
]);

const REJECTED_PATH_PATTERNS = [
	/(^|\/)database(\/|$)/i,
	/(^|\/)secure(\/|$)/i,
	/(^|\/)provider-profiles(\/|$)/i,
	/(^|\/)cookies?/i,
	/(^|\/)keychain/i,
	/(^|\/).*\.sqlite(-journal|-wal|-shm)?$/i,
	/(api.?key|token|secret|password|credential|oauth)/i,
];

function contained(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function walkFiles(
	root: string,
	maximumFiles = MAX_WALK_FILES,
	maximumDepth = MAX_WALK_DEPTH,
): string[] {
	const output: string[] = [];
	const queue = [{ path: root, depth: 0 }];
	while (queue.length && output.length < maximumFiles) {
		const current = queue.shift()!;
		let entries;
		try {
			entries = readdirSync(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = join(current.path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && current.depth < maximumDepth) {
				if (REJECTED_ROOT_NAMES.has(entry.name) && current.depth === 0) continue;
				queue.push({ path, depth: current.depth + 1 });
			} else if (entry.isFile()) output.push(path);
			if (output.length >= maximumFiles) break;
		}
	}
	return output;
}

function shouldRejectSourcePath(sourcePath: string): string | undefined {
	const base = basename(sourcePath);
	if (REJECTED_FILE_NAMES.has(base))
		return "Rejected protected browser or credential store file.";
	for (const pattern of REJECTED_PATH_PATTERNS)
		if (pattern.test(sourcePath))
			return "Rejected credential, cookie, database, or secret-bearing path.";
	return undefined;
}

function categoryFor(sourcePath: string): ElectronNativeTransferCategory | undefined {
	if (INSTRUCTION_NAMES.has(basename(sourcePath))) return "instructions";
	const normalized = sourcePath.split(sep).join("/").toLowerCase();
	if (
		(normalized.startsWith("learned-skills/") ||
			normalized.includes("/learned-skills/")) &&
		basename(sourcePath) === "SKILL.md"
	)
		return "skill";
	if (
		(normalized.startsWith("agents/") || normalized.includes("/agents/")) &&
		sourcePath.endsWith(".md")
	)
		return "agent";
	if (basename(sourcePath) === "runtime-preferences.json") return "settings-signal";
	return undefined;
}

function destinationFor(
	category: ElectronNativeTransferCategory,
	sourcePath: string,
): string {
	if (category === "instructions") return basename(sourcePath);
	if (category === "browser-library") return "browser-library.json";
	if (category === "settings-signal")
		return join(
			"imports",
			"kestrel-electron",
			".translated",
			"runtime-preferences.json",
		);
	if (category === "skill") {
		const index = sourcePath.toLowerCase().indexOf("learned-skills");
		if (index >= 0) return sourcePath.slice(index).replace(/\\/g, "/");
		return join(
			"learned-skills",
			basename(dirname(sourcePath)),
			basename(sourcePath),
		);
	}
	return join("imports", "kestrel-electron", sourcePath);
}

function translateRuntimePreferences(data: Buffer): {
	payload: string;
	values: Record<string, boolean>;
} | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data.toString("utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return undefined;
	const values: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (/(api.?key|token|secret|password|credential)/i.test(key)) continue;
		const lower = key.toLowerCase();
		if (typeof value === "boolean") {
			if (lower.includes("telemetry")) values.hasTelemetryPreference = true;
			if (lower.includes("update")) values.hasUpdatePreference = true;
			if (lower.includes("theme") || lower.includes("appearance"))
				values.hasAppearancePreference = true;
		}
		if (typeof value === "string" && value.length > 0 && value.length < 200) {
			if (lower.includes("model")) values.hasPreferredModel = true;
			if (lower.includes("locale") || lower.includes("language"))
				values.hasLocalePreference = true;
			if (lower.includes("theme") || lower.includes("appearance"))
				values.hasAppearancePreference = true;
		}
	}
	if (Object.keys(values).length === 0) return undefined;
	const payload =
		JSON.stringify(
			{
				schemaVersion: 1,
				sourceProduct: "kestrel-electron",
				sourcePath: "runtime-preferences.json",
				values,
			},
			null,
			2,
		) + "\n";
	return { payload, values };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function convertBrowserLibrary(stateRaw: Buffer): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stateRaw.toString("utf8"));
	} catch {
		return undefined;
	}
	const root = asRecord(parsed);
	if (!root) return undefined;

	const bookmarkFolders = asArray(root.bookmarkFolders)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.filter(
			(entry) =>
				typeof entry.id === "string" &&
				/^bookmark-folder-[a-f0-9-]{36}$/.test(entry.id) &&
				typeof entry.name === "string" &&
				entry.name.length > 0 &&
				entry.name.length <= 80 &&
				typeof entry.createdAt === "string",
		)
		.slice(0, 100)
		.map((entry) => ({
			id: entry.id as string,
			name: entry.name as string,
			createdAt: entry.createdAt as string,
		}));

	const folderIds = new Set(bookmarkFolders.map((folder) => folder.id));

	const bookmarks = asArray(root.bookmarks)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.filter(
			(entry) =>
				typeof entry.id === "string" &&
				/^bookmark-[a-f0-9-]{36}$/.test(entry.id) &&
				typeof entry.url === "string" &&
				isHttpUrl(entry.url) &&
				(entry.url as string).length <= 8_192 &&
				typeof entry.title === "string" &&
				(entry.title as string).length > 0 &&
				typeof entry.createdAt === "string",
		)
		.slice(0, 2_000)
		.map((entry) => {
			const displayMode =
				entry.displayMode === "title" || entry.displayMode === "icon"
					? entry.displayMode
					: "full";
			const folderId =
				typeof entry.folderId === "string" && folderIds.has(entry.folderId)
					? entry.folderId
					: undefined;
			return {
				id: entry.id as string,
				url: entry.url as string,
				title: String(entry.title).slice(0, 500),
				displayMode,
				...(folderId ? { folderId } : {}),
				createdAt: entry.createdAt as string,
			};
		});

	const history = asArray(root.history)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.filter(
			(entry) =>
				typeof entry.id === "string" &&
				/^visit-[a-f0-9-]{36}$/.test(entry.id) &&
				typeof entry.tabId === "string" &&
				/^tab-[a-f0-9-]{36}$/.test(entry.tabId) &&
				typeof entry.url === "string" &&
				isHttpUrl(entry.url) &&
				typeof entry.title === "string" &&
				typeof entry.visitedAt === "string",
		)
		.slice(0, 5_000)
		.map((entry) => ({
			id: entry.id as string,
			tabId: entry.tabId as string,
			url: entry.url as string,
			title: String(entry.title).slice(0, 500) || "Untitled",
			visitedAt: entry.visitedAt as string,
		}));

	const downloads = asArray(root.downloads)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.filter(
			(entry) =>
				typeof entry.id === "string" &&
				/^download-[a-f0-9-]{36}$/.test(entry.id) &&
				typeof entry.filename === "string" &&
				typeof entry.sourceUrl === "string" &&
				isHttpUrl(entry.sourceUrl) &&
				typeof entry.startedAt === "string",
		)
		.slice(0, 500)
		.map((entry) => ({
			id: entry.id as string,
			...(typeof entry.tabId === "string" && /^tab-[a-f0-9-]{36}$/.test(entry.tabId)
				? { tabId: entry.tabId }
				: {}),
			filename: String(entry.filename).slice(0, 255),
			sourceUrl: entry.sourceUrl as string,
			receivedBytes:
				typeof entry.receivedBytes === "number" && entry.receivedBytes >= 0
					? Math.floor(entry.receivedBytes)
					: 0,
			totalBytes:
				typeof entry.totalBytes === "number" && entry.totalBytes >= 0
					? Math.floor(entry.totalBytes)
					: 0,
			status:
				entry.status === "completed" ||
				entry.status === "cancelled" ||
				entry.status === "failed" ||
				entry.status === "blocked" ||
				entry.status === "progressing" ||
				entry.status === "checking"
					? entry.status
					: "completed",
			startedAt: entry.startedAt as string,
			...(typeof entry.completedAt === "string"
				? { completedAt: entry.completedAt }
				: {}),
			// Never claim revealability for Electron filesystem paths.
			canReveal: false,
		}));

	const sitePermissions = asArray(root.sitePermissions)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.filter(
			(entry) =>
				typeof entry.origin === "string" &&
				entry.origin.length > 0 &&
				typeof entry.permission === "string" &&
				(entry.decision === "allow" || entry.decision === "deny") &&
				typeof entry.updatedAt === "string",
		)
		.slice(0, 500)
		.map((entry) => ({
			origin: String(entry.origin).slice(0, 8_192),
			permission: String(entry.permission).slice(0, 80),
			decision: entry.decision as "allow" | "deny",
			updatedAt: entry.updatedAt as string,
		}));

	if (
		bookmarks.length === 0 &&
		bookmarkFolders.length === 0 &&
		history.length === 0 &&
		downloads.length === 0 &&
		sitePermissions.length === 0
	)
		return undefined;

	return (
		JSON.stringify(
			{
				version: 1,
				bookmarks,
				bookmarkFolders,
				history,
				downloads,
				sitePermissions,
			},
			null,
			2,
		) + "\n"
	);
}

function inventoryRejected(sourceRoot: string): ElectronNativeRejectedPath[] {
	const rejected: ElectronNativeRejectedPath[] = [];
	const seen = new Set<string>();
	const note = (path: string, reason: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		rejected.push({ path, reason });
	};
	for (const name of REJECTED_ROOT_NAMES) {
		const path = join(sourceRoot, name);
		if (!existsSync(path)) continue;
		if (name === "database") {
			note(
				"database/",
				"Encrypted desktop database is not transferred; re-auth or a dedicated Keychain path is required.",
			);
			continue;
		}
		if (name === "secure") {
			note(
				"secure/",
				"Secure credential material stays on the Electron profile.",
			);
			continue;
		}
		note(name, "Left on the Electron profile; never copied into native Chromium.");
	}
	for (const name of REJECTED_FILE_NAMES) {
		const path = join(sourceRoot, name);
		if (existsSync(path))
			note(name, "Left on the Electron profile; never copied into native Chromium.");
	}
	return rejected.slice(0, 200);
}

export class ElectronNativeProfileTransfer {
	constructor(private readonly now: () => Date = () => new Date()) {}

	plan(sourceRoot: string, targetRoot: string): ElectronNativeTransferPlan {
		const warnings: string[] = [];
		const items: ElectronNativeTransferItem[] = [];
		if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
			return {
				kind: ELECTRON_NATIVE_TRANSFER_KIND,
				schemaVersion: ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION,
				createdAt: this.now().toISOString(),
				sourceRoot: resolve(sourceRoot),
				targetRoot: resolve(targetRoot),
				items: [],
				warnings: ["kestrel-electron: source directory was not found."],
				rejected: [],
			};
		}
		const source = realpathSync(sourceRoot);
		const target = resolve(targetRoot);
		const rejected = inventoryRejected(source);

		warnings.push(
			"kestrel-electron: credentials, cookies, OAuth caches, and the encrypted database are never transferred.",
		);
		warnings.push(
			"kestrel-electron: apply creates a recoverable target backup and skips conflicts unless overwrite is enabled.",
		);

		const browserStatePath = join(source, "browser", "state.json");
		if (existsSync(browserStatePath) && !lstatSync(browserStatePath).isSymbolicLink()) {
			const size = statSync(browserStatePath).size;
			if (size > MAX_BROWSER_STATE_BYTES) {
				warnings.push(
					"kestrel-electron: skipped browser/state.json because it exceeds the transfer size limit.",
				);
			} else {
				const data = readFileSync(browserStatePath);
				const payload = convertBrowserLibrary(data);
				if (!payload) {
					warnings.push(
						"kestrel-electron: browser/state.json had no transferable bookmarks, history, downloads, or permissions.",
					);
				} else {
					const destinationPath = "browser-library.json";
					items.push({
						category: "browser-library",
						sourceRoot: source,
						sourcePath: join("browser", "state.json"),
						destinationPath,
						bytes: size,
						sha256: sha256(data),
						status: existsSync(resolve(target, destinationPath))
							? "conflict"
							: "ready",
						payload,
						payloadSha256: sha256(payload),
					});
				}
			}
		} else {
			warnings.push(
				"kestrel-electron: no browser/state.json found; browser library will not be seeded.",
			);
		}

		for (const path of walkFiles(source)) {
			let canonical: string;
			try {
				if (lstatSync(path).isSymbolicLink()) continue;
				canonical = realpathSync(path);
			} catch {
				continue;
			}
			if (!contained(source, canonical)) continue;
			const sourcePath = relative(source, canonical);
			if (sourcePath === join("browser", "state.json")) continue;
			const rejection = shouldRejectSourcePath(sourcePath);
			if (rejection) {
				rejected.push({ path: sourcePath, reason: rejection });
				continue;
			}
			const category = categoryFor(sourcePath);
			if (!category) continue;
			const size = statSync(canonical).size;
			if (size > MAX_FILE_BYTES) {
				warnings.push(
					`kestrel-electron: skipped ${sourcePath} because it exceeds 1 MB.`,
				);
				continue;
			}
			const data = readFileSync(canonical);
			if (data.includes(0)) {
				warnings.push(
					`kestrel-electron: skipped binary file ${sourcePath}.`,
				);
				continue;
			}
			if (category === "settings-signal") {
				const translated = translateRuntimePreferences(data);
				if (!translated) {
					warnings.push(
						"kestrel-electron: runtime-preferences.json had no recognized non-secret settings to translate.",
					);
					continue;
				}
				const destinationPath = destinationFor(category, sourcePath);
				items.push({
					category,
					sourceRoot: source,
					sourcePath,
					destinationPath,
					bytes: size,
					sha256: sha256(data),
					status: existsSync(resolve(target, destinationPath))
						? "conflict"
						: "ready",
					payload: translated.payload,
					payloadSha256: sha256(translated.payload),
				});
				warnings.push(
					"kestrel-electron: runtime-preferences.json is reviewed for non-secret signals only; raw settings are never imported.",
				);
				continue;
			}
			const destinationPath = destinationFor(category, sourcePath);
			items.push({
				category,
				sourceRoot: source,
				sourcePath,
				destinationPath,
				bytes: size,
				sha256: sha256(data),
				status: existsSync(resolve(target, destinationPath))
					? "conflict"
					: "ready",
			});
		}

		rejected.sort((left, right) => left.path.localeCompare(right.path));
		items.sort((left, right) =>
			left.destinationPath.localeCompare(right.destinationPath),
		);

		return {
			kind: ELECTRON_NATIVE_TRANSFER_KIND,
			schemaVersion: ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION,
			createdAt: this.now().toISOString(),
			sourceRoot: source,
			targetRoot: target,
			items,
			warnings,
			rejected: rejected.slice(0, 200),
		};
	}

	apply(
		plan: ElectronNativeTransferPlan,
		options: { approved: boolean; overwrite?: boolean },
	): ElectronNativeTransferResult {
		if (!options.approved)
			throw new Error("Electron→native transfer requires explicit approval.");
		if (
			plan.kind !== ELECTRON_NATIVE_TRANSFER_KIND ||
			plan.schemaVersion !== ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION
		)
			throw new Error("Migration plan is not an Electron→native transfer plan.");

		const target = resolve(plan.targetRoot);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		const backupRoot = join(
			target,
			`.transfer-backup-${this.now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
		);
		let backupCreated = false;
		const imported: string[] = [];
		const skipped: string[] = [];

		for (const item of plan.items) {
			const destination = resolve(target, item.destinationPath);
			if (!contained(target, destination))
				throw new Error("Transfer destination escaped its target root.");

			const sourceRoot = realpathSync(item.sourceRoot);
			if (sourceRoot !== realpathSync(plan.sourceRoot))
				throw new Error("Transfer item source root does not match the plan.");
			const source = realpathSync(resolve(sourceRoot, item.sourcePath));
			if (!contained(sourceRoot, source))
				throw new Error("Transfer source escaped its declared root.");
			const sourceMetadata = lstatSync(source);
			if (
				sourceMetadata.isSymbolicLink() ||
				!sourceMetadata.isFile() ||
				sourceMetadata.size >
					(item.category === "browser-library"
						? MAX_BROWSER_STATE_BYTES
						: MAX_FILE_BYTES)
			)
				throw new Error(
					`Transfer source changed after planning: ${item.sourcePath}`,
				);
			const data = readFileSync(source);
			if (sha256(data) !== item.sha256)
				throw new Error(
					`Transfer source changed after planning: ${item.sourcePath}`,
				);

			let payload: Buffer | string;
			if (item.category === "browser-library") {
				const regenerated = convertBrowserLibrary(data);
				if (!regenerated || sha256(regenerated) !== item.payloadSha256)
					throw new Error(
						`Transfer browser library changed after planning: ${item.sourcePath}`,
					);
				payload = regenerated;
			} else if (item.category === "settings-signal") {
				const translated = translateRuntimePreferences(data);
				if (
					!translated ||
					sha256(translated.payload) !== item.payloadSha256 ||
					translated.payload !== item.payload
				)
					throw new Error(
						`Transfer settings signal changed after planning: ${item.sourcePath}`,
					);
				payload = translated.payload;
			} else {
				if (data.includes(0))
					throw new Error(
						`Transfer source became binary after planning: ${item.sourcePath}`,
					);
				payload = data;
			}

			if (existsSync(destination) && !options.overwrite) {
				skipped.push(item.destinationPath);
				continue;
			}
			if (existsSync(destination)) {
				mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
				backupCreated = true;
				const backupDestination = join(backupRoot, item.destinationPath);
				mkdirSync(dirname(backupDestination), { recursive: true, mode: 0o700 });
				copyFileSync(destination, backupDestination);
			}
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			const temporary = `${destination}.tmp-${randomUUID().slice(0, 8)}`;
			writeFileSync(temporary, payload, { mode: 0o600 });
			renameSync(temporary, destination);
			imported.push(item.destinationPath);
		}

		return {
			imported,
			skipped,
			backupRoot: backupCreated ? backupRoot : null,
		};
	}
}

export function isElectronNativeTransferPlan(
	value: unknown,
): value is ElectronNativeTransferPlan {
	const record = asRecord(value);
	return (
		Boolean(record) &&
		record?.kind === ELECTRON_NATIVE_TRANSFER_KIND &&
		record.schemaVersion === ELECTRON_NATIVE_TRANSFER_SCHEMA_VERSION
	);
}
