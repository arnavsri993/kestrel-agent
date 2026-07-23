import type { RendererBridge } from "@kestrel/shared-types";

declare global {
  interface Window {
    kestrel: RendererBridge;
  }
}

export {};
