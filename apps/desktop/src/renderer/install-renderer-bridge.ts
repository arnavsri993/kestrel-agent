import {
	createRendererBridge,
	type RendererBridge,
	type RendererTransport,
} from "@kestrel/shared-types";

interface RendererHost {
	kestrel?: RendererBridge;
	__kestrelHostTransport?: RendererTransport;
}

/** Called before React mounts, only on the native host's trusted shell. */
export function installNativeRendererBridge(host: RendererHost): void {
	const transport = host.__kestrelHostTransport;
	if (!transport) return;
	if (host.kestrel) throw new Error("Kestrel renderer received conflicting host bridges.");
	Object.defineProperty(host, "kestrel", {
		value: createRendererBridge(transport),
		configurable: false,
		enumerable: false,
		writable: false,
	});
	delete host.__kestrelHostTransport;
}
