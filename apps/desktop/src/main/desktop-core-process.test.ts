import { afterEach, describe, expect, it, vi } from "vitest";
const { nodeProcess, state } = vi.hoisted(() => ({
	nodeProcess: vi.fn(),
	state: { packaged: false },
}));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("electron", () => ({
	app: { get isPackaged() { return state.packaged; } },
}));
vi.mock("./node-core-process", () => ({ nodeCoreProcess: nodeProcess }));
import {
	desktopCoreProcess,
	packagedAgentCoreSidecar,
} from "./desktop-core-process";

const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(
	process,
	"resourcesPath",
);
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	state.packaged = false;
	if (resourcesPathDescriptor)
		Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
	else Reflect.deleteProperty(process, "resourcesPath");
});
describe("desktop core host selection", () => {
	it("runs packaged desktops in the standalone Node sidecar and filters ambient credentials", () => {
		state.packaged = true;
		Object.defineProperty(process, "resourcesPath", {
			value: "/fixture/resources",
			configurable: true,
		});
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", "production");
		vi.stubEnv("OPENAI_API_KEY", "fixture-only");
		const child = {};
		nodeProcess.mockReturnValue(child);
		expect(desktopCoreProcess()).toBe(child);
		const [options] = nodeProcess.mock.calls[0]!;
		expect(options.executable).toMatch(/agent-core\/node\/bin\/node$/);
		expect(options.entryPath).toMatch(/agent-core\/service\/index\.js$/);
		expect(options.env.OPENAI_API_KEY).toBeUndefined();
	});
	it("uses the Node adapter for development", () => {
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", "development");
		vi.stubEnv("KESTREL_NODE_EXEC_PATH", "/fixture/node");
		vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only");
		const child = {};
		nodeProcess.mockReturnValue(child);
		expect(desktopCoreProcess()).toBe(child);
		const [options] = nodeProcess.mock.calls[0]!;
		expect(options.executable).toBe("/fixture/node");
		expect(options.entryPath).toMatch(/utility\.js$/);
		expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
	});
	it("keeps branded macOS Electron development off the packaged sidecar", () => {
		state.packaged = true;
		Object.defineProperty(process, "resourcesPath", {
			value: "/fixture/resources",
			configurable: true,
		});
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", "development");
		vi.stubEnv("KESTREL_NODE_EXEC_PATH", "/fixture/node");
		const child = {};
		nodeProcess.mockReturnValue(child);
		expect(desktopCoreProcess()).toBe(child);
		const [options] = nodeProcess.mock.calls[0]!;
		expect(options.executable).toBe("/fixture/node");
		expect(options.entryPath).toMatch(/utility\.js$/);
	});
	it("rejects development without a real Node executable instead of using Electron", () => {
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", "development");
		vi.stubEnv("KESTREL_NODE_EXEC_PATH", "");
		expect(() => desktopCoreProcess()).toThrow(
			/Agent Core requires a real Node\.js executable/,
		);
		expect(nodeProcess).not.toHaveBeenCalled();
	});
	it("uses the documented resource layout for packaged Agent Core", () => {
		expect(packagedAgentCoreSidecar("/fixture/resources")).toEqual({
			executable: "/fixture/resources/agent-core/node/bin/node",
			entryPath: "/fixture/resources/agent-core/service/index.js",
		});
	});
});
