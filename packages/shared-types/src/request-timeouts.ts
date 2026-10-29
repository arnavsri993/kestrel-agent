// Keep the execution budget shared by Core and every native transport layer.
// Callers validate request payloads separately; this function only chooses a
// deadline from the validated request type.
const AGENT_REQUESTS = new Set([
		"runtime-run-agent", "runtime-resume-agent", "runtime-retry-agent",
		"runtime-call-tool", "orchestration-delegate", "writing-generate",
		"pet-install", "pet-hatch-drafts", "pet-hatch-complete",
	]);
export function coreRequestTimeoutMs<T extends { type: string }>(request: T): number {
	if (AGENT_REQUESTS.has(request.type)) return 30 * 60_000;
	if (request.type === "media-transcribe") return 125_000;
	return 30_000;
}

export function nativeRequestTimeoutMs<T extends { type: string }>(request: T, layer: "broker" | "worker" | "renderer"): number {
	const execution = ["oauth-chatgpt-connect", "provider-account-connect", "oauth-cursor-connect", "oauth-google-connect", "select-workspace-folder"].includes(request.type)
		? 10 * 60_000 : request.type === "local-runtime-bootstrap" ? 90_000 : coreRequestTimeoutMs(request);
	// Core owns execution cancellation. The outer budgets leave room for its
	// response and the worker's bounded 42-second initial connection setup.
	return execution + { broker: 10_000, worker: 55_000, renderer: 60_000 }[layer];
}
