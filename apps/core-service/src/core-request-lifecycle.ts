import type { CoreRequest } from "@kestrel/shared-types";

export { coreRequestTimeoutMs } from "@kestrel/shared-types";

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
