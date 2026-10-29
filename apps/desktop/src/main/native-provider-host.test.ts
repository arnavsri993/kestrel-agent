import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeProviderHost } from "./native-provider-host";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-provider-host-")); roots.push(root);
	const environment: NodeJS.ProcessEnv = { KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", OPENAI_API_KEY: "ambient-secret-must-not-import" };
	const reconfigure = vi.fn(async (mutation: () => Promise<unknown>) => mutation());
	const accountStatus = vi.fn(async () => ({ connected: true, accountType: "chatgpt" as const }));
	const options = { root, encryptionKeyBase64: randomBytes(32).toString("base64"), homeDirectory: root, environment,
		reconfigure: <T>(mutation: () => Promise<T>): Promise<T> => reconfigure(mutation) as Promise<T>, accountStatus };
	return { root, options, host: new NativeProviderHost(options), reconfigure };
}

describe("native provider host", () => {
	it("saves protected API accounts and reloads routes without exposing or inheriting credentials", async () => {
		const { root, options, host } = await fixture();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		const secret = "native-host-encrypted-provider-secret";
		const result = await host.handle({ type: "provider-account-create", account: {
			providerId: "openai", adapter: "openai-responses", displayName: "Test API", authTransport: "api_key", enabled: true, apiKey: secret, headers: [],
		} });
		expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain(secret);
		expect(await readFile(join(root, "provider-accounts.json"), "utf8")).not.toContain(secret);
		const config = await new NativeProviderHost(options).runtimeConfiguration();
		expect(config.providerAccounts[0]?.apiKey).toBe(secret);
		expect(JSON.stringify(config)).not.toContain("ambient-secret-must-not-import");
		if (!result.ok || !("providerAccounts" in result) || !result.providerAccounts) throw new Error("Missing account summary");
		await host.handle({ type: "provider-account-remove", accountId: result.providerAccounts[0]!.id });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("does not persist credentials when Core refuses a provider change", async () => {
		const { host, reconfigure } = await fixture();
		reconfigure.mockImplementation(async () => { throw new Error("Active task"); });
		await expect(host.handle({ type: "credential-set", credentialId: "openai", value: "sk-must-not-be-saved" })).rejects.toThrow("Active task");
		const result = await host.handle({ type: "credential-list" });
		expect(result.ok && "credentials" in result && result.credentials.find(item => item.id === "openai")?.configured).toBe(false);
	});

	it("enables, disables and re-enables the vendor route without copying its login or creating a legacy account", async () => {
		const { root, options, host } = await fixture();
		const executable = join(root, "official-codex-fixture"); await writeFile(executable, "fixture\n", { mode: 0o700 });
		options.environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY = "0";
		options.environment.KESTREL_CODEX_PATH = executable;
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: true });
		const [account] = (await new NativeProviderHost(options).runtimeConfiguration()).providerAccounts;
		expect(account).toMatchObject({ id: "native-cli-codex", executable: await realpath(executable), homeDirectory: root, profilePath: join(root, ".codex") });
		const preferences = await readFile(join(root, "native-runtime-preferences.json"), "utf8");
		expect(JSON.parse(preferences)).toEqual({ version: 1, subscriptions: { codex: { enabled: true, path: await realpath(executable) } } });
		expect((await host.subscriptionStatuses()).find(item => item.id === "codex")).toMatchObject({ enabled: true, authenticated: true });
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: false });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: true });
		expect((await host.runtimeConfiguration()).providerAccounts).toHaveLength(1);
		options.environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY = "1";
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("rejects symlinked or public preferences and does not silently reset them", async () => {
		const { root, host } = await fixture();
		const destination = join(root, "preserved.json"); await writeFile(destination, '{"subscriptions":{}}', { mode: 0o600 });
		const preferences = join(root, "native-runtime-preferences.json"); await symlink(destination, preferences);
		await expect(host.runtimeConfiguration()).rejects.toThrow("Existing data was preserved");
		expect(await readFile(destination, "utf8")).toBe('{"subscriptions":{}}');
		await rm(preferences); await writeFile(preferences, '{"subscriptions":{}}', { mode: 0o600 }); await chmod(preferences, 0o644);
		await expect(host.runtimeConfiguration()).rejects.toThrow("Existing data was preserved");
	});

	it("rejects invalid and unrelated host requests before any mutation", async () => {
		const { host, reconfigure } = await fixture();
		expect((await host.handle({ type: "credential-set", credentialId: "arbitrary", value: "secret" })).ok).toBe(false);
		expect((await host.handle({ type: "runtime-run-agent" })).ok).toBe(false);
		expect(reconfigure).not.toHaveBeenCalled();
	});
});
