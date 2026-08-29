import { readBoundedResponseBytes } from "../bounded-http";
import { ModelProviderError } from "./types";

const MAX_PROVIDER_ERROR_BYTES = 64_000;
export const PROVIDER_CONNECT_TIMEOUT_MS = 20_000;

const NETWORK_UNAVAILABLE_CODES = new Set(["ENOTFOUND", "ECONNREFUSED"]);

function providerConnectSignal(callerSignal?: AbortSignal | null): {
	signal: AbortSignal;
	connectTimeoutSignal: AbortSignal;
} {
	const connectTimeoutSignal = AbortSignal.timeout(PROVIDER_CONNECT_TIMEOUT_MS);
	if (!callerSignal) return { signal: connectTimeoutSignal, connectTimeoutSignal };
	return {
		signal: AbortSignal.any([callerSignal, connectTimeoutSignal]),
		connectTimeoutSignal,
	};
}

function isNetworkUnavailableError(error: unknown): boolean {
	for (
		let current: unknown = error;
		current && typeof current === "object";
		current = (current as { cause?: unknown }).cause
	) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && NETWORK_UNAVAILABLE_CODES.has(code))
			return true;
	}
	return false;
}

function providerFetchError(
	error: unknown,
	providerId: string,
	callerSignal: AbortSignal | undefined,
	connectTimeoutSignal: AbortSignal,
): never {
	if (callerSignal?.aborted) throw error;
	if (connectTimeoutSignal.aborted && !callerSignal?.aborted) {
		throw new ModelProviderError(
			`Provider connect timed out after ${PROVIDER_CONNECT_TIMEOUT_MS / 1_000}s.`,
			providerId,
			true,
		);
	}
	if (isNetworkUnavailableError(error)) {
		throw new ModelProviderError(
			"Network unavailable: provider host could not be reached.",
			providerId,
			false,
		);
	}
	throw new ModelProviderError(
		`Provider request failed before a response was received: ${error instanceof Error ? error.message : "network error"}`,
		providerId,
		true,
	);
}

export function parseRetryAfterMs(
	value: string | null,
	nowMs = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	const seconds = Number(normalized);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.trunc(seconds * 1_000);
	const dateMs = Date.parse(normalized);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.max(0, dateMs - nowMs);
}

export interface ServerSentEvent {
	event?: string;
	data: string;
}

export async function readServerSentEvents(
	response: Response,
	providerId: string,
	onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
	if (!response.body)
		throw new ModelProviderError(
			"Provider returned an empty streaming response.",
			providerId,
			true,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		let boundary = buffer.search(/\r?\n\r?\n/);
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
			buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
			let event: string | undefined;
			const data: string[] = [];
			for (const line of block.split(/\r?\n/)) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
			if (data.length > 0)
				onEvent({ ...(event ? { event } : {}), data: data.join("\n") });
			boundary = buffer.search(/\r?\n\r?\n/);
		}
		if (done) break;
	}
}

export async function readNdjson(
	response: Response,
	providerId: string,
	onValue: (value: unknown) => void,
): Promise<void> {
	if (!response.body)
		throw new ModelProviderError(
			"Provider returned an empty streaming response.",
			providerId,
			true,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onValue(JSON.parse(line));
		if (done) break;
	}
	if (buffer.trim()) onValue(JSON.parse(buffer));
}

export async function providerFetch(
	providerId: string,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const { signal, connectTimeoutSignal } = providerConnectSignal(init.signal);
	let response: Response;
	try {
		// Provider requests carry protected credentials. A redirect could move
		// those credentials to a different host, so fail closed instead of
		// following it. Custom provider endpoints still work; their first hop is
		// the explicit endpoint the user configured.
		response = await fetch(url, { ...init, redirect: "error", signal });
	} catch (error) {
		providerFetchError(
			error,
			providerId,
			init.signal ?? undefined,
			connectTimeoutSignal,
		);
	}
	if (!response.ok) {
		let body = "";
		try {
			const bytes = await readBoundedResponseBytes(
				response,
				MAX_PROVIDER_ERROR_BYTES,
				"Provider error response exceeds 64 KB.",
			);
			body = Buffer.from(bytes)
				.toString("utf8")
				.slice(0, 2_000)
				.replace(/[\r\n]+/g, " ");
		} catch {
			body = "error body exceeded the 64 KB safety limit";
		}
		const retryable =
			response.status === 408 ||
			response.status === 409 ||
			response.status === 429 ||
			response.status >= 500;
		throw new ModelProviderError(
			`Provider returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
			providerId,
			retryable,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	}
	return response;
}
