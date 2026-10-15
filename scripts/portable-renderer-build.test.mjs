import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRendererViteConfig } from "../apps/desktop/renderer.vite.config.mjs";

describe("portable renderer Vite configuration", () => {
	it("shares relative base, output, and CSP nonce behavior", () => {
		const config = createRendererViteConfig({
			nonce: "test-renderer-nonce",
			outDir: "/tmp/kestrel-renderer-test-output",
		});
		const noncePlugin = config.plugins.find(
			(plugin) => plugin.name === "kestrel-renderer-csp-nonce",
		);

		expect(config.base).toBe("./");
		expect(config.root).toBe(resolve("apps/desktop/src/renderer"));
		expect(config.build.outDir).toBe("/tmp/kestrel-renderer-test-output");
		expect(config.html.cspNonce).toBe("test-renderer-nonce");
		expect(noncePlugin.transformIndexHtml("<script nonce=\"__KESTREL_RENDERER_CSP_NONCE__\">"))
			.toContain('nonce="test-renderer-nonce"');
	});

	it("rejects Electron imports before they enter the renderer graph", () => {
		const config = createRendererViteConfig();
		const guard = config.plugins.find(
			(plugin) => plugin.name === "kestrel-renderer-no-electron-imports",
		);

		expect(() => guard.resolveId("electron")).toThrow(/cannot import Electron/);
		expect(() => guard.resolveId("electron/clipboard")).toThrow(
			/cannot import Electron/,
		);
		expect(guard.resolveId("react")).toBeNull();
	});
});
