// Home images remain inside the authenticated extension worker. They never
// enter the native messaging/Core pipe, whose smaller limit is unchanged.
export function nativeRendererFrameLimit(type: string): number {
	return ["browser-update-settings", "browser-plan-home-settings-import"].includes(type) ? 8 * 1024 * 1024 : 768 * 1024;
}
export function nativeRendererFrameFits(serialized: string, type: string): boolean {
	const limit = nativeRendererFrameLimit(type);
	return serialized.length <= limit && new TextEncoder().encode(serialized).byteLength <= (["browser-update-settings", "browser-plan-home-settings-import"].includes(type) ? limit : 1_000_000);
}
