import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type CommunicationCodeMatch,
	type CommunicationSourceStatus,
	extractLoginCodes,
} from "@kestrel/shared-types";

const execFileAsync = promisify(execFile);
const SQLITE_PATH = "/usr/bin/sqlite3";
const DEFAULT_DATABASE_PATH = join(homedir(), "Library/Messages/chat.db");
const MESSAGE_QUERY = `
SELECT
  message.text AS text,
  message.subject AS subject,
  handle.id AS sender,
  message.date AS date
FROM message
LEFT JOIN handle ON handle.ROWID = message.handle_id
WHERE message.text IS NOT NULL
  AND length(message.text) > 0
  AND message.date >= ((strftime('%s','now') - 1800 + 978307200) * 1000000000)
ORDER BY message.date DESC
LIMIT 100;
`;

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
			(async (file, args) => {
				const result = await execFileAsync(file, [...args], {
					maxBuffer: 2_000_000,
					encoding: "utf8",
				});
				return { stdout: result.stdout, stderr: result.stderr };
			});
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
				detail: "Read-only lookup is available when you ask for a code.",
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

	async searchLoginCodes(): Promise<{
		matches: CommunicationCodeMatch[];
		status: CommunicationSourceStatus;
	}> {
		const before = this.status();
		if (before.state !== "connected") return { matches: [], status: before };
		try {
			const result = await this.runQuery(SQLITE_PATH, [
				"-readonly",
				"-json",
				this.databasePath,
				MESSAGE_QUERY,
			]);
			const raw = JSON.parse(result.stdout) as unknown;
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
				const receivedAt = messageDate(row.date, this.now());
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
					detail: "Read-only lookup is available when you ask for a code.",
				},
			};
		} catch (error) {
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
		raw > 100_000_000_000_000 ? raw / 1_000_000 + 978_307_200_000 : raw + 978_307_200_000;
	const receivedAt = new Date(Math.min(milliseconds, now.getTime()));
	return Number.isFinite(receivedAt.getTime()) ? receivedAt : undefined;
}
