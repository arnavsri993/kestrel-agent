import { generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginInstaller } from "./plugin-installer";
import { PluginRegistry } from "./plugins";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kestrel-plugin-install-"));
	directories.push(root);
	const managedRoot = join(root, "managed");
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const installer = new PluginInstaller({
		managedRoot,
		trustKeys: [{ keyId: "publisher.test", publicKey }],
	});
	const createBundle = (version: string, content: string) => {
		const bundle = join(root, `bundle-${version}`);
		mkdirSync(join(bundle, ".codex-plugin"), { recursive: true });
		mkdirSync(join(bundle, "skills", "example"), { recursive: true });
		writeFileSync(
			join(bundle, ".codex-plugin", "plugin.json"),
			JSON.stringify({
				name: "example",
				version,
				description: "Signed example plugin.",
				skills: "./skills",
			}),
		);
		writeFileSync(
			join(bundle, "skills", "example", "SKILL.md"),
			`---\nname: example\ndescription: Example skill.\n---\n\n${content}\n`,
		);
		const digest = installer.digestForSigning(bundle).digest;
		writeFileSync(
			join(bundle, ".codex-plugin", "signature.json"),
			JSON.stringify({
				algorithm: "ed25519",
				keyId: "publisher.test",
				digest,
				signature: sign(null, Buffer.from(digest, "hex"), privateKey).toString(
					"base64",
				),
			}),
		);
		return bundle;
	};
	return { root, managedRoot, installer, createBundle };
}

describe("signed plugin installer", () => {
	it("installs, atomically updates, removes recoverably, and restores a trusted bundle", () => {
		const { managedRoot, installer, createBundle } = fixture();
		const first = installer.install(createBundle("1.0.0", "First version."));
		expect(first).toMatchObject({
			name: "example",
			version: "1.0.0",
			keyId: "publisher.test",
		});
		expect(
			new PluginRegistry([managedRoot], undefined, [managedRoot]).discover(),
		).toMatchObject([
			{ name: "example", version: "1.0.0", enabled: false, managed: true },
		]);

		const updated = installer.update(createBundle("2.0.0", "Second version."));
		expect(updated).toMatchObject({
			name: "example",
			version: "2.0.0",
			replacedVersion: "1.0.0",
		});
		expect(
			readFileSync(
				join(managedRoot, "example", "skills", "example", "SKILL.md"),
				"utf8",
			),
		).toContain("Second version.");
		expect(new PluginRegistry([managedRoot]).discover()).toMatchObject([
			{ name: "example", version: "2.0.0" },
		]);

		const removed = installer.remove("example");
		expect(removed).toMatchObject({ name: "example", version: "2.0.0" });
		expect(existsSync(join(managedRoot, "example"))).toBe(false);
		expect(existsSync(removed.recoveryPath)).toBe(true);
		expect(new PluginRegistry([managedRoot]).discover()).toEqual([]);

		const restored = installer.restore(removed.recoveryPath);
		expect(restored).toMatchObject({
			name: "example",
			version: "2.0.0",
			installedRoot: join(managedRoot, "example"),
		});
		expect(existsSync(removed.recoveryPath)).toBe(false);
		expect(new PluginRegistry([managedRoot]).discover()).toMatchObject([
			{ name: "example", version: "2.0.0" },
		]);
	});

	it("rejects tampering, untrusted publishers, and symbolic links", () => {
		const { root, managedRoot, installer, createBundle } = fixture();
		const tampered = createBundle("1.0.0", "Signed content.");
		writeFileSync(
			join(tampered, "skills", "example", "SKILL.md"),
			"tampered\n",
		);
		expect(() => installer.inspect(tampered)).toThrow("digest does not match");

		const trusted = createBundle("1.0.1", "Trusted content.");
		const untrusted = new PluginInstaller({
			managedRoot: join(root, "other-managed"),
			trustKeys: [],
		});
		expect(() => untrusted.inspect(trusted)).toThrow("is not trusted");

		symlinkSync("/etc/hosts", join(trusted, "linked-hosts"));
		expect(() => installer.inspect(trusted)).toThrow(
			"cannot contain symbolic links",
		);
	});

	it("rejects invalid bundle safety limits", () => {
		const { managedRoot } = fixture();
		const { publicKey } = generateKeyPairSync("ed25519");
		for (const field of [
			"maximumFiles",
			"maximumTotalBytes",
			"maximumFileBytes",
		] as const) {
			for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				const options: ConstructorParameters<typeof PluginInstaller>[0] = {
					managedRoot,
					trustKeys: [{ keyId: "publisher.test", publicKey }],
					[field]: value,
				};
				expect(() => new PluginInstaller(options)).toThrow(
					"Plugin bundle limits must be positive safe integers",
				);
			}
		}
	});
});
