import { describe, expect, it, vi } from "vitest";
import {
	installMacFileIconCrashGuard,
	type FileIconApi,
} from "./mac-file-icon-guard";

function fileIconApi() {
	const getFileIcon = vi.fn(async (_path: string, options?: { size: string }) =>
		options?.size ?? "default",
	);
	return {
		api: { getFileIcon } as FileIconApi<string>,
		getFileIcon,
	};
}

describe("macOS file icon crash guard", () => {
	it("downgrades the native-crashing large request on macOS", async () => {
		const { api, getFileIcon } = fileIconApi();
		installMacFileIconCrashGuard(api, "darwin");

		await expect(
			api.getFileIcon("/Applications/Kestrel.app", { size: "large" }),
		).resolves.toBe("normal");
		expect(getFileIcon).toHaveBeenCalledWith("/Applications/Kestrel.app", {
			size: "normal",
		});
	});

	it("preserves supported icon sizes and omitted options", async () => {
		const { api, getFileIcon } = fileIconApi();
		installMacFileIconCrashGuard(api, "darwin");

		await expect(
			api.getFileIcon("/tmp/example.txt", { size: "small" }),
		).resolves.toBe("small");
		await expect(api.getFileIcon("/tmp/example.txt")).resolves.toBe("default");
		expect(getFileIcon).toHaveBeenNthCalledWith(1, "/tmp/example.txt", {
			size: "small",
		});
		expect(getFileIcon).toHaveBeenNthCalledWith(2, "/tmp/example.txt", undefined);
	});

	it("leaves non-macOS implementations unchanged", async () => {
		const { api, getFileIcon } = fileIconApi();
		installMacFileIconCrashGuard(api, "linux");

		await expect(
			api.getFileIcon("/tmp/example.txt", { size: "large" }),
		).resolves.toBe("large");
		expect(api.getFileIcon).toBe(getFileIcon);
	});

	it("installs only once", async () => {
		const { api, getFileIcon } = fileIconApi();
		installMacFileIconCrashGuard(api, "darwin");
		const guarded = api.getFileIcon;
		installMacFileIconCrashGuard(api, "darwin");

		expect(api.getFileIcon).toBe(guarded);
		await api.getFileIcon("/tmp/example.txt", { size: "large" });
		expect(getFileIcon).toHaveBeenCalledTimes(1);
	});
});
