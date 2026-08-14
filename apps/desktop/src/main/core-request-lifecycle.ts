import type { CoreRequest } from "@kestrel/shared-types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const AGENT_REQUEST_TIMEOUT_MS = 30 * 60_000;
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 125_000;

export function coreRequestTimeoutMs(request: CoreRequest): number {
	if (
		request.type === "runtime-run-agent" ||
		request.type === "runtime-resume-agent" ||
		request.type === "runtime-retry-agent" ||
		request.type === "runtime-call-tool" ||
		request.type === "orchestration-delegate" ||
		request.type === "pet-install" ||
		request.type === "pet-hatch-drafts" ||
		request.type === "pet-hatch-complete"
	)
		return AGENT_REQUEST_TIMEOUT_MS;
	if (request.type === "media-transcribe")
		return TRANSCRIPTION_REQUEST_TIMEOUT_MS;
	return DEFAULT_REQUEST_TIMEOUT_MS;
}

export function timedOutAgentStreamId(
	request: CoreRequest,
): string | undefined {
	if (
		request.type === "runtime-run-agent" ||
		request.type === "runtime-resume-agent" ||
		request.type === "runtime-retry-agent"
	)
		return request.streamId;
	return undefined;
}
