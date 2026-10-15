import { createRendererBridge } from "@kestrel/shared-types";
import { contextBridge } from "electron";
import { electronRendererTransport } from "./electron-renderer-transport";
import { installFileDropGuard } from "./file-drag";

// The main process enables native NSVisualEffectView vibrancy on macOS shell
// windows and announces it through an additional argument. Mark the document
// before first paint so CSS can swap the rails/chrome from opaque graphite to
// the real OS material (and back under reduced transparency).
const nativeMaterial = process.argv
	.find((arg) => arg.startsWith("--kestrel-native-material="))
	?.split("=")[1];
if (nativeMaterial === "sidebar") {
	const markDocument = () => {
		document.documentElement.dataset.kestrelMaterial = "native";
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", markDocument, { once: true });
	} else {
		markDocument();
	}
}

const bridge = createRendererBridge(electronRendererTransport);

installFileDropGuard(window);

contextBridge.exposeInMainWorld("kestrel", bridge);
