// Home images and reviewed history payloads remain inside the authenticated
// extension worker. They never enter the native messaging/Core pipe.
export function nativeRendererFrameLimit(type: string): number {
	if (["browser-update-settings", "browser-plan-home-settings-import"].includes(type)) return 8 * 1024 * 1024;
	// The schema limits history data to 1 MiB. Leave room for its request
	// envelope without widening unrelated renderer or Core requests.
	if (type === "browser-plan-history-import") return 2 * 1024 * 1024;
	return 768 * 1024;
}
export function nativeRendererFrameFits(serialized: string, type: string): boolean {
	const limit = nativeRendererFrameLimit(type);
	return serialized.length <= limit && new TextEncoder().encode(serialized).byteLength <= (limit > 768 * 1024 ? limit : 1_000_000);
}
