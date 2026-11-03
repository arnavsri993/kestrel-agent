import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CommunicationCodeMatch,
	type CommunicationSourceStatus,
	extractLoginCodes,
} from "@kestrel/shared-types";

const SQLITE_PATH = "/usr/bin/sqlite3";
const DEFAULT_DATABASE_PATH = join(homedir(), "Library/Messages/chat.db");
const APPLE_EPOCH_MS = 978_307_200_000;
const LOOKBACK_MS = 30 * 60_000;
const QUERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 2_000_000;

function messageQuery(now: Date): string {
	const milliseconds = now.getTime();
	if (!Number.isSafeInteger(milliseconds) || milliseconds < APPLE_EPOCH_MS + LOOKBACK_MS) throw new Error("Invalid Messages lookup time.");
	const upper = BigInt(milliseconds - APPLE_EPOCH_MS) * 1_000_000n;
	const lower = upper - BigInt(LOOKBACK_MS) * 1_000_000n;
	return `
SELECT
  message.text AS text,
  message.subject AS subject,
  handle.id AS sender,
  message.date AS date
FROM message
LEFT JOIN handle ON handle.ROWID = message.handle_id
WHERE message.text IS NOT NULL
  AND length(message.text) > 0
  AND typeof(message.date) IN ('integer', 'real')
  AND message.date >= ${lower}
  AND message.date <= ${upper}
ORDER BY message.date DESC
LIMIT 100;
`;
}

interface MessageRow {
	text?: unknown;
	subject?: unknown;
	sender?: unknown;
	date?: unknown;
}

interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface MacMessagesSourceOptions {
	databasePath?: string;
	platform?: NodeJS.Platform;
	now?: () => Date;
	runQuery?: (
		file: string,
		args: readonly string[],
		signal?: AbortSignal,
	) => Promise<CommandResult>;
}

export class MacMessagesSource {
	private readonly databasePath: string;
	private readonly platform: NodeJS.Platform;
	private readonly now: () => Date;
	private readonly runQuery: NonNullable<MacMessagesSourceOptions["runQuery"]>;

	constructor(options: MacMessagesSourceOptions = {}) {
		this.databasePath = options.databasePath ?? DEFAULT_DATABASE_PATH;
		this.platform = options.platform ?? process.platform;
		this.now = options.now ?? (() => new Date());
		this.runQuery =
			options.runQuery ??
			((file, args, signal) => new Promise((resolve, reject) => {
				if (signal?.aborted) { reject(new Error("Messages lookup cancelled.")); return; }
				const child = execFile(file, [...args], {
					maxBuffer: MAX_OUTPUT_BYTES,
					timeout: QUERY_TIMEOUT_MS,
					encoding: "utf8",
					...(signal ? { signal } : {}),
				}, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
				let escalation: ReturnType<typeof setTimeout> | undefined;
				const abort = () => {
					// The execFile signal first asks sqlite3 to terminate; bound a
					// non-cooperative helper without affecting any other process.
					escalation = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					}, 500);
					escalation.unref?.();
				};
				const cleanup = () => { if (escalation) clearTimeout(escalation); signal?.removeEventListener("abort", abort); };
				child.once("exit", cleanup); child.once("close", cleanup);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			}));
	}

	status(): CommunicationSourceStatus {
		if (this.platform !== "darwin")
			return {
				id: "mac-messages",
				label: "Messages on this Mac",
				kind: "local",
				state: "unavailable",
				detail: "This local Messages connector is available on macOS only.",
			};
		if (!existsSync(this.databasePath))
			return {
				id: "mac-messages",
				label: "Messages on this Mac",
				kind: "local",
				state: "not_connected",
				detail: "Open Messages once on this Mac, then try again.",
			};
		try {
			accessSync(this.databasePath, constants.R_OK);
			return {
				id: "mac-messages",
				label: "Messages on this Mac",
				kind: "local",
				state: "connected",
				detail: "The Messages file appears readable. Lookup verifies access; attributed-body-only messages are unsupported.",
			};
		} catch {
			return {
				id: "mac-messages",
				label: "Messages on this Mac",
				kind: "local",
				state: "needs_permission",
				detail: "Allow Kestrel access in System Settings → Privacy & Security → Full Disk Access.",
			};
		}
	}

	async searchLoginCodes(signal?: AbortSignal): Promise<{
		matches: CommunicationCodeMatch[];
		status: CommunicationSourceStatus;
	}> {
		const before = this.status();
		if (signal?.aborted) return { matches: [], status: { ...before, state: "unavailable", detail: "Messages lookup was cancelled." } };
		if (before.state !== "connected") return { matches: [], status: before };
		try {
			const lookupAt = this.now();
			const result = await this.runQuery(SQLITE_PATH, [
				"-readonly",
				"-json",
				this.databasePath,
				messageQuery(lookupAt),
			], signal);
			if (signal?.aborted) throw new Error("Messages lookup cancelled.");
			if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) throw new Error("Messages output exceeded its limit.");
			const raw = result.stdout.trim() ? JSON.parse(result.stdout) as unknown : [];
			if (!Array.isArray(raw)) throw new Error("Messages returned invalid data.");
			const matches: CommunicationCodeMatch[] = [];
			for (const value of raw.slice(0, 100)) {
				if (!value || typeof value !== "object") continue;
				const row = value as MessageRow;
				const text = typeof row.text === "string" ? row.text : "";
				const subject =
					typeof row.subject === "string" ? row.subject.slice(0, 500) : "";
				const sender =
					typeof row.sender === "string" ? row.sender.slice(0, 500) : "";
				const codes = extractLoginCodes(`${subject}\n${text}`);
				const receivedAt = messageDate(row.date, lookupAt);
				if (!receivedAt) continue;
				for (const code of codes) {
					matches.push({
						sourceId: "mac-messages",
						sourceLabel: "Messages on this Mac",
						...(sender ? { sender } : {}),
						...(subject ? { subject } : {}),
						code,
						receivedAt: receivedAt.toISOString(),
					});
				}
				if (matches.length >= 5) break;
			}
			return {
				matches: matches.slice(0, 5),
				status: {
					...before,
					state: "connected",
					detail: "Read-only text-message lookup succeeded; attributed-body-only messages are not supported.",
				},
			};
		} catch (error) {
			if (signal?.aborted) return { matches: [], status: { ...before, state: "unavailable", detail: "Messages lookup was cancelled." } };
			const message = error instanceof Error ? error.message : String(error);
			const permissionDenied = /permission|operation not permitted|denied/i.test(
				message,
			);
			return {
				matches: [],
				status: {
					...before,
					state: permissionDenied ? "needs_permission" : "unavailable",
					detail: permissionDenied
						? "Allow Kestrel access in System Settings → Privacy & Security → Full Disk Access."
						: "Kestrel could not read the local Messages database.",
				},
			};
		}
	}
}

function messageDate(value: unknown, now: Date): Date | undefined {
	const raw = Number(value);
	if (!Number.isFinite(raw) || raw <= 0) return undefined;
	const milliseconds =
		raw > 100_000_000_000_000 ? raw / 1_000_000 + APPLE_EPOCH_MS : raw + APPLE_EPOCH_MS;
	if (milliseconds > now.getTime() || milliseconds < now.getTime() - LOOKBACK_MS) return undefined;
	const receivedAt = new Date(milliseconds);
	return Number.isFinite(receivedAt.getTime()) ? receivedAt : undefined;
}
