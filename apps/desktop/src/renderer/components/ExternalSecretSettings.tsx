import type {
	BrokeredCredentialSummary,
	ExternalSecretConfiguration,
	ExternalSecretProviderId,
	ExternalSecretProviderStatus,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useState } from "react";

const EMPTY_CONFIGURATION: ExternalSecretConfiguration = {
	version: 1,
	onepassword: {
		enabled: false,
		account: "",
		mappings: {},
		overrideStored: true,
	},
	bitwarden: {
		enabled: false,
		projectId: "",
		serverUrl: "",
		autoInstall: true,
		overrideStored: true,
	},
	command: {
		enabled: false,
		executablePath: "",
		arguments: [],
		timeoutMs: 3_000,
		overrideStored: false,
	},
};

const credentialOptions: Array<{
	id: BrokeredCredentialSummary["id"];
	label: string;
}> = [
	{ id: "openai", label: "OpenAI · primary" },
	{ id: "openai-secondary", label: "OpenAI · backup" },
	{ id: "anthropic", label: "Anthropic · primary" },
	{ id: "anthropic-secondary", label: "Anthropic · backup" },
	{ id: "gemini", label: "Google Gemini" },
	{ id: "brave-search", label: "Brave Search" },
	{ id: "github", label: "GitHub" },
	{ id: "fal", label: "fal media" },
];

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

function OnePasswordSection({
	configuration,
	status,
	update,
	onSave,
	onSync,
	onRemove,
	busy,
	onePasswordToken,
	setOnePasswordToken,
}: {
	configuration: ExternalSecretConfiguration["onepassword"];
	status?: ExternalSecretProviderStatus | undefined;
	update: (values: Partial<ExternalSecretConfiguration["onepassword"]>) => void;
	onSave: () => void;
	onSync: () => void;
	onRemove: () => void;
	busy: string;
	onePasswordToken: string;
	setOnePasswordToken: (token: string) => void;
}) {
	const [mappingId, setMappingId] =
		useState<BrokeredCredentialSummary["id"]>("openai");
	const [mappingReference, setMappingReference] = useState("");

	const mappedCredentials = Object.entries(configuration.mappings) as Array<
		[BrokeredCredentialSummary["id"], string]
	>;

	return (
		<details>
			<summary>
				<span>
					<b>1Password CLI</b>
					<small>{status?.detail ?? "Checking the official CLI…"}</small>
				</span>
				<span
					className={`external-secret-state ${status?.state ?? "needs_setup"}`}
				>
					{status ? status.state.replaceAll("_", " ") : "checking"}
				</span>
			</summary>
			<div className="external-secret-form">
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.enabled}
						onChange={(event) => update({ enabled: event.target.checked })}
					/>
					<span>Resolve mapped credentials at startup</span>
				</label>
				<div className="external-secret-grid">
					<label>
						CLI path{" "}
						<input
							value={configuration.binaryPath ?? ""}
							placeholder="/opt/homebrew/bin/op"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) =>
								update({ binaryPath: event.target.value || undefined })
							}
						/>
					</label>
					<label>
						Account{" "}
						<input
							value={configuration.account}
							placeholder="my.1password.com"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => update({ account: event.target.value })}
						/>
					</label>
					<label className="wide">
						Service-account token{" "}
						<input
							type="password"
							value={onePasswordToken}
							placeholder="Optional replacement; desktop sign-in also works"
							autoComplete="new-password"
							spellCheck={false}
							aria-describedby="onepassword-token-note"
							onChange={(event) => setOnePasswordToken(event.target.value)}
						/>
					</label>
				</div>
				<small id="onepassword-token-note">
					The token is OS-encrypted and never shown again. Kestrel passes it
					only to the official op process.
				</small>
				<div className="external-secret-mapper">
					<label>
						Credential{" "}
						<select
							value={mappingId}
							onChange={(event) =>
								setMappingId(
									event.target.value as BrokeredCredentialSummary["id"],
								)
							}
						>
							{credentialOptions.map((credential) => (
								<option key={credential.id} value={credential.id}>
									{credential.label}
								</option>
							))}
						</select>
					</label>
					<label>
						Secret reference{" "}
						<input
							value={mappingReference}
							placeholder="op://Vault/Item/field"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => setMappingReference(event.target.value)}
						/>
					</label>
					<button
						className="button secondary"
						disabled={!mappingReference.trim()}
						onClick={() => {
							update({
								mappings: {
									...configuration.mappings,
									[mappingId]: mappingReference.trim(),
								},
							});
							setMappingReference("");
						}}
					>
						Add mapping
					</button>
				</div>
				{mappedCredentials.length > 0 && (
					<ul className="external-secret-mappings">
						{mappedCredentials.map(([id, reference]) => (
							<li key={id}>
								<span>
									{credentialOptions.find((option) => option.id === id)
										?.label ?? id}
									<small>{reference}</small>
								</span>
								<button
									className="quiet-link"
									onClick={() => {
										const mappings = { ...configuration.mappings };
										delete mappings[id];
										update({ mappings });
									}}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				)}
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.overrideStored}
						onChange={(event) =>
							update({ overrideStored: event.target.checked })
						}
					/>
					<span>Override matching protected fields</span>
				</label>
				<div className="button-row">
					<button
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={onSave}
					>
						{busy === "save:onepassword" ? "Saving…" : "Save configuration"}
					</button>
					<button
						className="button primary"
						disabled={
							Boolean(busy) ||
							!configuration.enabled ||
							mappedCredentials.length === 0
						}
						onClick={onSync}
					>
						{busy === "sync:onepassword" ? "Verifying…" : "Sync and verify"}
					</button>
					<button
						className="quiet-link"
						disabled={Boolean(busy)}
						onClick={onRemove}
					>
						Remove source
					</button>
				</div>
			</div>
		</details>
	);
}

function BitwardenSection({
	configuration,
	status,
	update,
	onSave,
	onSync,
	onRemove,
	onInstall,
	busy,
	bitwardenToken,
	setBitwardenToken,
}: {
	configuration: ExternalSecretConfiguration["bitwarden"];
	status?: ExternalSecretProviderStatus | undefined;
	update: (values: Partial<ExternalSecretConfiguration["bitwarden"]>) => void;
	onSave: () => void;
	onSync: () => void;
	onRemove: () => void;
	onInstall: () => void;
	busy: string;
	bitwardenToken: string;
	setBitwardenToken: (token: string) => void;
}) {
	return (
		<details>
			<summary>
				<span>
					<b>Bitwarden Secrets Manager</b>
					<small>{status?.detail ?? "Checking the verified bws CLI…"}</small>
				</span>
				<span
					className={`external-secret-state ${status?.state ?? "needs_setup"}`}
				>
					{status ? status.state.replaceAll("_", " ") : "checking"}
				</span>
			</summary>
			<div className="external-secret-form">
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.enabled}
						onChange={(event) => update({ enabled: event.target.checked })}
					/>
					<span>Resolve supported secret names at startup</span>
				</label>
				<div className="external-secret-grid">
					<label>
						Project ID{" "}
						<input
							value={configuration.projectId}
							placeholder="00000000-0000-0000-0000-000000000000"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => update({ projectId: event.target.value })}
						/>
					</label>
					<label>
						Server URL{" "}
						<input
							value={configuration.serverUrl}
							placeholder="Default Bitwarden cloud"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => update({ serverUrl: event.target.value })}
						/>
					</label>
					<label>
						CLI path{" "}
						<input
							value={configuration.binaryPath ?? ""}
							placeholder="Managed install or absolute path"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) =>
								update({ binaryPath: event.target.value || undefined })
							}
						/>
					</label>
					<label>
						Machine-account token{" "}
						<input
							type="password"
							value={bitwardenToken}
							placeholder="Enter or replace token"
							autoComplete="new-password"
							spellCheck={false}
							aria-describedby="bitwarden-token-note"
							onChange={(event) => setBitwardenToken(event.target.value)}
						/>
					</label>
				</div>
				<small id="bitwarden-token-note">
					The token is OS-encrypted. Only names matching supported provider
					fields are accepted from the project.
				</small>
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.autoInstall}
						onChange={(event) => update({ autoInstall: event.target.checked })}
					/>
					<span>Use the pinned, checksum-verified managed CLI</span>
				</label>
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.overrideStored}
						onChange={(event) =>
							update({ overrideStored: event.target.checked })
						}
					/>
					<span>Override matching protected fields</span>
				</label>
				<div className="button-row">
					<button
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={onInstall}
					>
						{busy === "install:bitwarden"
							? "Installing…"
							: status?.managedBinary
								? "Verified CLI installed"
								: "Install verified CLI"}
					</button>
					<button
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={onSave}
					>
						{busy === "save:bitwarden" ? "Saving…" : "Save configuration"}
					</button>
					<button
						className="button primary"
						disabled={
							Boolean(busy) ||
							!configuration.enabled ||
							!configuration.projectId ||
							(!bitwardenToken && status?.state === "needs_setup")
						}
						onClick={onSync}
					>
						{busy === "sync:bitwarden" ? "Verifying…" : "Sync and verify"}
					</button>
					<button
						className="quiet-link"
						disabled={Boolean(busy)}
						onClick={onRemove}
					>
						Remove source
					</button>
				</div>
			</div>
		</details>
	);
}

function CommandSection({
	configuration,
	status,
	update,
	onSave,
	onSync,
	onRemove,
	busy,
}: {
	configuration: ExternalSecretConfiguration["command"];
	status?: ExternalSecretProviderStatus | undefined;
	update: (values: Partial<ExternalSecretConfiguration["command"]>) => void;
	onSave: () => void;
	onSync: () => void;
	onRemove: () => void;
	busy: string;
}) {
	return (
		<details>
			<summary>
				<span>
					<b>Command helper</b>
					<small>
						{status?.detail ?? "Checking the configured executable…"}
					</small>
				</span>
				<span
					className={`external-secret-state ${status?.state ?? "needs_setup"}`}
				>
					{status ? status.state.replaceAll("_", " ") : "checking"}
				</span>
			</summary>
			<div className="external-secret-form">
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.enabled}
						onChange={(event) => update({ enabled: event.target.checked })}
					/>
					<span>Run this exact executable at startup</span>
				</label>
				<div className="external-secret-grid">
					<label className="wide">
						Executable path{" "}
						<input
							value={configuration.executablePath}
							placeholder="/absolute/path/to/helper"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) =>
								update({ executablePath: event.target.value })
							}
						/>
					</label>
					<label className="wide">
						Arguments, one per line{" "}
						<textarea
							value={configuration.arguments.join("\n")}
							placeholder={"get\n--format=env"}
							spellCheck={false}
							onChange={(event) =>
								update({
									arguments: event.target.value.split(/\r?\n/).filter(Boolean),
								})
							}
						/>
					</label>
					<label>
						Timeout in milliseconds{" "}
						<input
							type="number"
							min={250}
							max={10_000}
							step={250}
							value={configuration.timeoutMs}
							onChange={(event) =>
								update({ timeoutMs: Number(event.target.value) })
							}
						/>
					</label>
				</div>
				<small>
					Kestrel does not invoke a shell. The helper receives discrete
					arguments, a minimal environment, a hard timeout, and must print
					supported KEY=VALUE records.
				</small>
				<label className="checkbox-label">
					<input
						type="checkbox"
						checked={configuration.overrideStored}
						onChange={(event) =>
							update({ overrideStored: event.target.checked })
						}
					/>
					<span>Override matching protected fields</span>
				</label>
				<div className="button-row">
					<button
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={onSave}
					>
						{busy === "save:command" ? "Saving…" : "Save configuration"}
					</button>
					<button
						className="button primary"
						disabled={
							Boolean(busy) ||
							!configuration.enabled ||
							!configuration.executablePath
						}
						onClick={onSync}
					>
						{busy === "sync:command" ? "Verifying…" : "Sync and verify"}
					</button>
					<button
						className="quiet-link"
						disabled={Boolean(busy)}
						onClick={onRemove}
					>
						Remove source
					</button>
				</div>
			</div>
		</details>
	);
}

export function ExternalSecretSettings() {
	const [configuration, setConfiguration] =
		useState<ExternalSecretConfiguration>(() =>
			structuredClone(EMPTY_CONFIGURATION),
		);
	const [sources, setSources] = useState<ExternalSecretProviderStatus[]>([]);
	const [onePasswordToken, setOnePasswordToken] = useState("");
	const [bitwardenToken, setBitwardenToken] = useState("");
	const [busy, setBusy] = useState("");
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");

	async function load() {
		const response = await window.kestrel.request({
			type: "external-secret-list",
		});
		if (!response.ok) throw new Error(response.error);
		if ("externalSecretSources" in response) {
			setSources(response.externalSecretSources);
			setConfiguration(response.externalSecretConfiguration);
		}
	}

	useEffect(() => {
		void load().catch((cause) =>
			setError(errorMessage(cause, "External secret status failed.")),
		);
	}, []);

	const sourceById = useMemo(
		() =>
			Object.fromEntries(
				sources.map((source) => [source.id, source]),
			) as Partial<
				Record<ExternalSecretProviderId, ExternalSecretProviderStatus>
			>,
		[sources],
	);

	function update<K extends ExternalSecretProviderId>(
		providerId: K,
		values: Partial<ExternalSecretConfiguration[K]>,
	) {
		setConfiguration((current) => ({
			...current,
			[providerId]: { ...current[providerId], ...values },
		}));
		setNotice("");
		setError("");
	}

	function receive(
		response: Awaited<ReturnType<typeof window.kestrel.request>>,
	) {
		if (!response.ok) throw new Error(response.error);
		if ("externalSecretSources" in response) {
			setSources(response.externalSecretSources);
			setConfiguration(response.externalSecretConfiguration);
		}
	}

	async function save(providerId: ExternalSecretProviderId) {
		setBusy(`save:${providerId}`);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "external-secret-save",
				configuration,
				...(onePasswordToken.trim()
					? { onePasswordToken: onePasswordToken.trim() }
					: {}),
				...(bitwardenToken.trim()
					? { bitwardenToken: bitwardenToken.trim() }
					: {}),
			});
			receive(response);
			setOnePasswordToken("");
			setBitwardenToken("");
			setNotice(
				`${sourceById[providerId]?.label ?? "Source"} configuration saved. Sync to verify and apply it.`,
			);
		} catch (cause) {
			setError(
				errorMessage(
					cause,
					"External secret configuration could not be saved.",
				),
			);
		} finally {
			setBusy("");
		}
	}

	async function sync(providerId: ExternalSecretProviderId) {
		setBusy(`sync:${providerId}`);
		setError("");
		setNotice("");
		try {
			const saved = await window.kestrel.request({
				type: "external-secret-save",
				configuration,
				...(onePasswordToken.trim()
					? { onePasswordToken: onePasswordToken.trim() }
					: {}),
				...(bitwardenToken.trim()
					? { bitwardenToken: bitwardenToken.trim() }
					: {}),
			});
			receive(saved);
			const response = await window.kestrel.request({
				type: "external-secret-sync",
				providerId,
			});
			receive(response);
			setOnePasswordToken("");
			setBitwardenToken("");
			setNotice(
				`${sourceById[providerId]?.label ?? "Source"} verified and applied to the isolated core.`,
			);
		} catch (cause) {
			setError(
				errorMessage(cause, "External secret source could not be verified."),
			);
		} finally {
			setBusy("");
		}
	}

	async function installBitwarden() {
		setBusy("install:bitwarden");
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "external-secret-install-bitwarden",
			});
			receive(response);
			setNotice(
				"Verified Bitwarden CLI installed locally. Add a project and machine-account token to continue.",
			);
		} catch (cause) {
			setError(errorMessage(cause, "Bitwarden CLI installation failed."));
		} finally {
			setBusy("");
		}
	}

	async function remove(providerId: ExternalSecretProviderId) {
		setBusy(`remove:${providerId}`);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "external-secret-remove",
				providerId,
			});
			receive(response);
			if (providerId === "onepassword") setOnePasswordToken("");
			if (providerId === "bitwarden") setBitwardenToken("");
			setNotice(
				`${sourceById[providerId]?.label ?? "Source"} configuration removed.`,
			);
		} catch (cause) {
			setError(
				errorMessage(cause, "External secret source could not be removed."),
			);
		} finally {
			setBusy("");
		}
	}

	const activeCount = sources.filter(
		(source) => source.state === "verified",
	).length;

	return (
		<article className="setting-row external-secret-setting">
			<div className="external-secret-content">
				<strong>External secret sources</strong>
				<p>
					Optional for advanced setups. Saved protected fields keep precedence
					unless you override them here.
				</p>
				<div className="external-secret-list">
					<OnePasswordSection
						configuration={configuration.onepassword}
						status={sourceById.onepassword}
						update={(values) => update("onepassword", values)}
						onSave={() => void save("onepassword")}
						onSync={() => void sync("onepassword")}
						onRemove={() => void remove("onepassword")}
						busy={busy}
						onePasswordToken={onePasswordToken}
						setOnePasswordToken={setOnePasswordToken}
					/>

					<BitwardenSection
						configuration={configuration.bitwarden}
						status={sourceById.bitwarden}
						update={(values) => update("bitwarden", values)}
						onSave={() => void save("bitwarden")}
						onSync={() => void sync("bitwarden")}
						onRemove={() => void remove("bitwarden")}
						onInstall={() => void installBitwarden()}
						busy={busy}
						bitwardenToken={bitwardenToken}
						setBitwardenToken={setBitwardenToken}
					/>

					<CommandSection
						configuration={configuration.command}
						status={sourceById.command}
						update={(values) => update("command", values)}
						onSave={() => void save("command")}
						onSync={() => void sync("command")}
						onRemove={() => void remove("command")}
						busy={busy}
					/>
				</div>
				<div className="external-secret-feedback" aria-live="polite">
					{notice && <small role="status">{notice}</small>}
					{error && <small role="alert">{error}</small>}
				</div>
			</div>
			<span className="status">{activeCount} verified</span>
		</article>
	);
}
