import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RENDERER_CSP_NONCE_PLACEHOLDER,
	rendererCspNoncePlugin,
	rendererScriptCspDirective,
} from "./renderer-csp-nonce";

describe("renderer CSP nonce plugin", () => {
	it("replaces the nonce placeholder in index.html during transform", () => {
		const nonce = "test-nonce-value";
		const plugin = rendererCspNoncePlugin(nonce);
		const html = readFileSync(
			resolve(__dirname, "../src/renderer/index.html"),
			"utf8",
		);
		const transformed = plugin.transformIndexHtml?.(html, {
			path: "/index.html",
			filename: "index.html",
			server: undefined as never,
			bundle: undefined,
			chunk: undefined,
		});
		expect(transformed).toContain(`'nonce-${nonce}'`);
		expect(transformed).not.toContain(RENDERER_CSP_NONCE_PLACEHOLDER);
		expect(transformed).not.toMatch(/script-src[^;]*'unsafe-inline'/);
	});

	it("builds a script-src directive without unsafe-inline", () => {
		expect(rendererScriptCspDirective("abc123")).toBe(
			"'self' 'nonce-abc123'",
		);
	});
});
