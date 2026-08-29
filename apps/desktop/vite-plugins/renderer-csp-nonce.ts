import { randomBytes } from "node:crypto";
import type { Plugin } from "vite";

/** Shared placeholder replaced in index.html and wired to Vite html.cspNonce. */
export const RENDERER_CSP_NONCE_PLACEHOLDER = "__KESTREL_RENDERER_CSP_NONCE__";

export function createRendererCspNonce(): string {
	return randomBytes(16).toString("base64");
}

export function rendererCspNoncePlugin(nonce: string): Plugin {
	return {
		name: "kestrel-renderer-csp-nonce",
		transformIndexHtml(html) {
			return html.replaceAll(RENDERER_CSP_NONCE_PLACEHOLDER, nonce);
		},
	};
}

/** script-src without unsafe-inline; style-src keeps unsafe-inline for Vite HMR/CSS injection. */
export function rendererScriptCspDirective(nonce: string): string {
	return `'self' 'nonce-${nonce}'`;
}
