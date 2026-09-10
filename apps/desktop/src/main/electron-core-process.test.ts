import { afterEach, describe, expect, it, vi } from "vitest";
const { fork, nodeProcess } = vi.hoisted(() => ({ fork: vi.fn(), nodeProcess: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork } }));
vi.mock("./node-core-process", () => ({ nodeCoreProcess: nodeProcess }));
import { desktopCoreProcess } from "./electron-core-process";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("desktop core host selection", () => {
	it("keeps packaged desktops on the utility host and filters ambient credentials", () => {
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", "production");
		vi.stubEnv("KESTREL_USE_NODE_CORE", "0");
		vi.stubEnv("OPENAI_API_KEY", "fixture-only");
		const child = {};
		fork.mockReturnValue(child);
		expect(desktopCoreProcess()).toBe(child);
		expect(nodeProcess).not.toHaveBeenCalled();
		const [entry, args, options] = fork.mock.calls[0]!;
		expect(entry).toMatch(/utility\.js$/);
		expect(args).toEqual([]);
		expect(options.serviceName).toBe("Kestrel Agent Core");
		expect(options.env.OPENAI_API_KEY).toBeUndefined();
	});
	it.each(["development", "explicit"])("uses the Node adapter for %s", (mode) => {
		vi.stubEnv("NODE_ENV_ELECTRON_VITE", mode === "development" ? "development" : "production");
		vi.stubEnv("KESTREL_USE_NODE_CORE", mode === "explicit" ? "1" : "0");
		vi.stubEnv("KESTREL_NODE_EXEC_PATH", "/fixture/node");
		vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only");
		const child = {};
		nodeProcess.mockReturnValue(child);
		expect(desktopCoreProcess()).toBe(child);
		expect(fork).not.toHaveBeenCalled();
		const [options] = nodeProcess.mock.calls[0]!;
		expect(options.executable).toBe("/fixture/node");
		expect(options.entryPath).toMatch(/utility\.js$/);
		expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
