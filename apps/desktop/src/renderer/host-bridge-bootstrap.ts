import { installNativeRendererBridge } from "./install-renderer-bridge";

// This first dependency runs before application modules evaluate.
installNativeRendererBridge(window);
