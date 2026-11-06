import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageNativeChromiumArtifact } from "./native-package-stage.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-package-test-")));
	roots.push(root);
	const tempRoot = join(root, ".tmp"), destinationRoot = join(root, "release", "native-mac-arm64");
	const destinationApp = join(destinationRoot, "Kestrel.app"), liveDefault = join(tempRoot, "native-chromium-host", "Kestrel.app");
	await mkdir(liveDefault, { recursive: true }); await writeFile(join(liveDefault, "LIVE-DEFAULT"), "keep");
	await mkdir(destinationApp, { recursive: true }); await writeFile(join(destinationApp, "OLD-RELEASE"), "keep-old");
	const build = async output => {
		await mkdir(join(output, "Kestrel.app", "Contents", "MacOS"), { recursive: true });
		await writeFile(join(output, "Kestrel.app", "Contents", "MacOS", "Kestrel"), "generated-native-app");
		return join(output, "Kestrel.app");
	};
	return { root, tempRoot, destinationRoot, destinationApp, liveDefault, build,
		copy: (source, destination) => cp(source, destination, { recursive: true }),
		ops: { mkdir, rename, rm } };
}

async function marker(path, name) { return readFile(join(path, name), "utf8"); }

describe("native packaging stage safety", () => {
	it("builds in a unique stage, leaves the live default untouched, and adopts only the digest-verified copy", async () => {
		const value = await fixture(); let buildOutput;
		const destination = await packageNativeChromiumArtifact({ ...value,
			build: async output => { buildOutput = output; return value.build(output); },
		});
		expect(destination).toBe(value.destinationApp);
		expect(buildOutput).toMatch(new RegExp(`${value.root}/\\.tmp/native-package-stage-[^/]+/build$`));
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
		expect(await marker(value.destinationApp, "Contents/MacOS/Kestrel")).toBe("generated-native-app");
		await expect(marker(value.destinationApp, "OLD-RELEASE")).rejects.toThrow();
	});

	it.each(["build", "copy", "adoption"])("preserves the existing release artifact after %s failure", async failure => {
		const value = await fixture();
		const ops = failure === "adoption" ? {
			...value.ops,
			rename: async (source, destination) => {
				if (destination === value.destinationApp && source.endsWith("/package/Kestrel.app")) throw new Error("generated adoption failure");
				return rename(source, destination);
			},
		} : value.ops;
		await expect(packageNativeChromiumArtifact({ ...value,
			build: failure === "build" ? async () => { throw new Error("generated build failure"); } : value.build,
			copy: failure === "copy" ? async () => { throw new Error("generated copy failure"); } : value.copy,
			ops,
		})).rejects.toThrow(`generated ${failure} failure`);
		expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
		expect(await lstat(value.destinationApp)).toBeDefined();
	});

	it("refuses a corrupted copy before moving the prior release", async () => {
		const value = await fixture();
		await expect(packageNativeChromiumArtifact({ ...value, copy: async (source, destination) => {
			await value.copy(source, destination);
			await writeFile(join(destination, "Contents/MacOS/Kestrel"), "generated-corruption");
		} })).rejects.toThrow(/digest/);
		expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
	});

	it("restores the prior release when adoption verification detects corruption", async () => {
		const value = await fixture();
		await expect(packageNativeChromiumArtifact({ ...value, ops: { ...value.ops, rename: async (source, destination) => {
			await rename(source, destination);
			if (destination === value.destinationApp && source.endsWith("/package/Kestrel.app"))
				await writeFile(join(destination, "Contents/MacOS/Kestrel"), "generated-corruption");
		} } })).rejects.toThrow(/digest/);
		expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
	});

	it("refuses a builder that returns the live development app", async () => {
		const value = await fixture();
		await expect(packageNativeChromiumArtifact({ ...value, build: async () => value.liveDefault })).rejects.toThrow(/dedicated staged/);
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
		expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
	});

	it.each([false, true])("attempts rollback even when failed-candidate cleanup throws (removed=%s)", async removed => {
		const value = await fixture();
		let failure;
		try {
			await packageNativeChromiumArtifact({ ...value, ops: { ...value.ops,
				rename: async (source, destination) => {
					await rename(source, destination);
					if (destination === value.destinationApp && source.endsWith("/package/Kestrel.app"))
						await writeFile(join(destination, "Contents/MacOS/Kestrel"), "generated-corruption");
				},
				rm: async (path, options) => {
					if (path === value.destinationApp) {
						if (removed) await rm(path, options);
						throw new Error("generated candidate removal failure");
					}
					return rm(path, options);
				},
			} });
		} catch (error) { failure = error; }
		expect(failure.message).toContain("digest");
		if (removed) {
			expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
		} else {
			const backup = (await readdir(value.destinationRoot)).find(name => name.startsWith(".Kestrel.app.previous-"));
			expect(backup).toBeDefined();
			expect(failure.message).toContain(join(value.destinationRoot, backup));
			expect(await marker(join(value.destinationRoot, backup), "OLD-RELEASE")).toBe("keep-old");
		}
		expect(await marker(value.liveDefault, "LIVE-DEFAULT")).toBe("keep");
	});

	it("preserves the primary failure if temporary stage cleanup also fails", async () => {
		const value = await fixture();
		await expect(packageNativeChromiumArtifact({ ...value,
			build: async () => { throw new Error("generated primary build failure"); },
			ops: { ...value.ops, rm: async path => { throw new Error(`generated staging cleanup failure at ${path}`); } },
		})).rejects.toThrow(/generated primary build failure; temporary package staging cleanup also failed/);
		expect(await marker(value.destinationApp, "OLD-RELEASE")).toBe("keep-old");
	});

	it("rejects a non-directory release root before invoking the builder", async () => {
		const value = await fixture();
		await rm(value.destinationRoot, { recursive: true }); await writeFile(value.destinationRoot, "generated-existing-file");
		let built = false;
		await expect(packageNativeChromiumArtifact({ ...value, build: async output => { built = true; return value.build(output); } })).rejects.toThrow(/real directories/);
		expect(built).toBe(false); expect(await readFile(value.destinationRoot, "utf8")).toBe("generated-existing-file");
	});

	it.each([".tmp", "release"])("refuses a symlinked %s ancestor before building", async unsafeAncestor => {
		const value = await fixture(), outside = join(value.root, "outside");
		await mkdir(outside);
		if (unsafeAncestor === ".tmp") {
			await rm(value.tempRoot, { recursive: true, force: true }); await symlink(outside, value.tempRoot);
		} else {
			await rm(join(value.root, "release"), { recursive: true, force: true }); await symlink(outside, join(value.root, "release"));
		}
		let built = false;
		await expect(packageNativeChromiumArtifact({ ...value, build: async output => { built = true; return value.build(output); } })).rejects.toThrow(/symlink|real directories|escape/i);
		expect(built).toBe(false);
	});
});
