import { statSync } from "node:fs";
import { z } from "zod";

export const ExternalServicePayloadSchema = z
	.object({
		kind: z.enum(["ask", "open"]),
		paths: z.array(z.string().min(1).max(4_096)).max(8),
		text: z.string().max(20_000).optional(),
	})
	.refine(
		(value) => value.paths.length > 0 || Boolean(value.text?.trim()),
		"An external request must contain text or at least one file.",
	);
export type ExternalServicePayload = z.infer<
	typeof ExternalServicePayloadSchema
>;

export function filePathsFromArgv(
	argv: readonly string[],
	options: {
		defaultApp?: boolean;
		executablePath?: string;
	} = {},
): string[] {
	const defaultApp = options.defaultApp ?? Boolean(process.defaultApp);
	const executablePath = options.executablePath ?? process.execPath;
	// Electron inserts the development entrypoint at argv[1] when it launches as
	// the default app. It is implementation detail, not a user-opened file.
	const candidates = argv.slice(defaultApp ? 2 : 1);
	return [
		...new Set(
			candidates.filter((value) => {
				if (!value.startsWith("/") || value === executablePath) return false;
				try {
					return statSync(value).isFile();
				} catch {
					return false;
				}
			}),
		),
	];
}

export function externalPayloadIdFromDeepLink(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "kestrel:" ||
			url.hostname !== "ask" ||
			url.username ||
			url.password ||
			url.port ||
			url.pathname !== ""
		)
			return undefined;
		const payload = url.searchParams.get("payload") ?? "";
		return /^[a-f0-9-]{36}$/.test(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

export function parseExternalServicePayload(
	value: unknown,
): ExternalServicePayload | undefined {
	const parsed = ExternalServicePayloadSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
