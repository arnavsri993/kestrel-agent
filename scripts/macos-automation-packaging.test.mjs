import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	usage: "Kestrel uses System Events for desktop input that you approve.",
	entitlement: true,
	entitlementsReadable: true,
	process: {
		platform: "darwin",
		argv: ["node", "verify.mjs", "/fixture/Kestrel.app"],
		cwd: () => "/fixture",
	},
}));

vi.mock("node:child_process", () => ({ spawnSync: native.spawnSync }));
vi.mock("node:process", () => ({ default: native.process }));
vi.mock("node:module", () => ({
	createRequire: () => () => ({
		verifyAgentCoreSidecar: () => undefined,
		verifyNativeBrowserSidecar: () => undefined,
	}),
}));
vi.mock("./macos-architecture-audit.cjs", () => ({
	auditPackagedMacApp: () => undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		existsSync: () => true,
		statSync: () => ({ isDirectory: () => true, isFile: () => true, size: 1 }),
		readFileSync: (path, ...args) => path.endsWith("app-update.yml")
			? "provider: github\nowner: arnavsri993\nrepo: kestrel-agent\nreleaseType: release\nchannel: latest"
			: actual.readFileSync(path, ...args),
	};
});

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("process", native.process);
	native.usage = "Kestrel uses System Events for desktop input that you approve.";
	native.entitlement = true;
	native.entitlementsReadable = true;
	native.spawnSync.mockReset().mockImplementation((path, args, options) => {
		if (path.endsWith("lipo")) return { status: 0, stdout: "arm64", stderr: "" };
		if (path.endsWith("codesign")) {
			if (args.includes("--xml")) return {
				status: 0,
				stdout: JSON.stringify({ "com.apple.security.automation.apple-events": native.entitlement }),
				stderr: "Executable=/fixture/Kestrel.app/Contents/MacOS/Kestrel",
			};
			return {
				status: 0,
				stdout: "",
				stderr: "Identifier=com.kestrel.desktop.dev\nSignature=adhoc\nTeamIdentifier=not set\nflags=0x10000(runtime)\ncom.apple.security.cs.allow-jit\ncom.apple.security.cs.allow-unsigned-executable-memory\ncom.apple.security.cs.disable-library-validation",
			};
		}
		if (args[0] === "-convert") return {
			status: native.entitlementsReadable ? 0 : 1,
			stdout: options.input,
			stderr: "",
		};
		const key = args[1];
		if (key === "NSAppleEventsUsageDescription") return {
			status: native.usage === undefined ? 1 : 0,
			stdout: native.usage ?? "",
			stderr: "",
		};
		const dev = args.at(-1).includes("Kestrel Helper") || native.process.argv[1].includes("development");
		let bundleId = dev ? "com.kestrel.desktop.dev" : "com.kestrel.desktop";
		const app = args.at(-1);
		if (app.includes("Kestrel Helper")) {
			bundleId += ".helper";
			if (app.includes("(Renderer)")) bundleId += ".Renderer";
			if (app.includes("(GPU)")) bundleId += ".GPU";
			if (app.includes("(Plugin)")) bundleId += ".Plugin";
		}
		return { status: 0, stderr: "", stdout: {
			CFBundleIdentifier: bundleId,
			CFBundleName: "Kestrel",
			CFBundleShortVersionString: "0.1.0",
			LSMinimumSystemVersion: "13.0.0",
			"LSEnvironment.KESTREL_RELEASE_CHANNEL": dev ? "development" : "stable",
		}[key] ?? "" };
	});
});

afterEach(() => vi.unstubAllGlobals());

describe.each(["development", "installable"])("%s macOS Automation verification", (kind) => {
	async function verify() {
		native.process.argv[1] = `verify-${kind}-macos-app.mjs`;
		return kind === "development"
			? import("./verify-development-macos-app.mjs")
			: import("./verify-installable-macos-app.mjs");
	}

	it("inspects main signed entitlements and the actual bundle usage description", async () => {
		await expect(verify()).resolves.toBeDefined();
		expect(native.spawnSync).toHaveBeenCalledWith(
			"/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", "/fixture/Kestrel.app"], expect.any(Object),
		);
		expect(native.spawnSync.mock.calls.filter(([, args]) => args.includes("--xml"))).toHaveLength(1);
	});

	it.each([undefined, false, "true"])("rejects a signed entitlement that is not boolean true (%s)", async (value) => {
		native.entitlement = value;
		await expect(verify()).rejects.toThrow("signed Apple Events entitlement");
	});

	it.each([undefined, "", "   "])("rejects a missing or empty usage description (%s)", async (value) => {
		native.usage = value;
		await expect(verify()).rejects.toThrow(/AppleEventsUsageDescription|usage description is empty/);
	});

	it("fails closed when signed entitlement decoding fails", async () => {
		native.entitlementsReadable = false;
		await expect(verify()).rejects.toThrow("signed entitlements");
	});
});

describe("Automation packaging privilege scope", () => {
	const desktop = resolve(import.meta.dirname, "../apps/desktop");
	it("keeps Automation permission on the main executable only", () => {
		expect(readFileSync(resolve(desktop, "build/entitlements.mac.plist"), "utf8"))
			.toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/);
		for (const name of ["entitlements.mac.inherit.plist", "entitlements.mac.dev.inherit.plist"])
			expect(readFileSync(resolve(desktop, "build", name), "utf8"))
				.not.toContain("com.apple.security.automation.apple-events");
	});
	it.each(["electron-builder.yml", "electron-builder.dev.yml", "electron-builder.installable.yml"])
		("provides a nonempty System Events purpose for %s", (name) => {
			const builder = readFileSync(resolve(desktop, name), "utf8");
			expect(builder).toMatch(/NSAppleEventsUsageDescription:\s*"[^"\n]*System Events[^"\n]*approve[^"\n]*"/);
		});
});
