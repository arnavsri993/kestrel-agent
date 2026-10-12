import type { RendererBridge, RendererTransport } from "@kestrel/shared-types";

declare global {
	interface Window {
		kestrel: RendererBridge;
		__kestrelHostTransport?: RendererTransport;
	}
}
