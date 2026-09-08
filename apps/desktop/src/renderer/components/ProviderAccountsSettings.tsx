import type {
	CoreResponse,
	ProviderAccountAdapter,
	ProviderAccountAuthTransport,
	ProviderAccountSummary,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useState } from "react";

type AccountKind = {
	id: string;
	label: string;
	providerId: string;
	adapter: ProviderAccountAdapter;
	authTransport: ProviderAccountAuthTransport;
	description: string;
	requiresBaseUrl?: boolean;
	showsApiKey?: boolean;
};

const ACCOUNT_KINDS: readonly AccountKind[] = [
	{
		id: "openai",
		label: "OpenAI API",
		providerId: "openai",
		adapter: "openai-responses",
		authTransport: "api_key",
		description: "A protected OpenAI API credential with account-specific discovery.",
		showsApiKey: true,
	},
	{
		id: "codex",
		label: "ChatGPT / Codex",
		providerId: "codex",
		adapter: "codex-app-server",
		authTransport: "oauth",
		description: "An isolated official Codex profile. Connect each account separately.",
	},
	{
		id: "anthropic",
		label: "Anthropic API",
		providerId: "anthropic",
		adapter: "anthropic-messages",
		authTransport: "api_key",
		description: "Uses Anthropic's authenticated model listing for this account.",
		showsApiKey: true,
	},
	{
		id: "gemini",
		label: "Google Gemini API",
		providerId: "gemini",
		adapter: "gemini-generate-content",
		authTransport: "api_key",
		description: "Uses Google's supported model enumeration for this account.",
		showsApiKey: true,
	},
	{
		id: "ollama",
		label: "Ollama / local runtime",
		providerId: "ollama",
		adapter: "ollama",
		authTransport: "local",
		description: "Discovers models installed on the selected local runtime.",
	},
	{
		id: "compatible",
		label: "OpenAI-compatible endpoint",
		providerId: "custom",
		adapter: "openai-compatible",
		authTransport: "api_key",
		description: "For self-hosted or cloud endpoints that expose the OpenAI model-list API.",
		requiresBaseUrl: true,
		showsApiKey: true,
	},
];

type AccountForm = {
	kindId: string;
	displayName: string;
	providerId: string;
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	organization: string;
	project: string;
	headerLines: string;
};

const INITIAL_FORM: AccountForm = {
	kindId: "openai",
	displayName: "",
	providerId: "openai",
	baseUrl: "",
	apiKey: "",
	defaultModel: "",
	organization: "",
	project: "",
	headerLines: "",
};

function providerLabel(value: string): string {
	return value
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

function statusFor(account: ProviderAccountSummary): {
	label: string;
	tone: "ready" | "muted" | "warning" | "error";
} {
	if (!account.enabled) return { label: "Disabled", tone: "muted" };
	if (
		account.authTransport === "oauth" &&
		account.discovery.state === "idle" &&
		account.models.length === 0
	)
		return { label: "Authentication required", tone: "warning" };
	if (account.models.some((model) => model.availability === "authentication_required"))
		return { label: "Authentication required", tone: "warning" };
	if (account.models.some((model) => model.availability === "permission_denied"))
		return { label: "Permission denied", tone: "error" };
	if (account.discovery.state === "failed") return { label: "Refresh failed", tone: "error" };
	if (account.discovery.state === "fresh") return { label: "Ready", tone: "ready" };
	if (account.discovery.state === "stale") return { label: "Catalog stale", tone: "warning" };
	if (account.discovery.state === "unsupported")
		return { label: "No model listing", tone: "muted" };
	return { label: "Needs refresh", tone: "muted" };
}

function refreshedLabel(account: ProviderAccountSummary): string {
	const value = account.discovery.lastSuccessAt ?? account.discovery.lastAttemptAt;
	if (!value) return "Not refreshed yet";
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? `Last refreshed ${date.toLocaleString()}`
		: "Refresh time unavailable";
}

function parseHeaders(lines: string): Array<{ name: string; value: string }> {
	const headers: Array<{ name: string; value: string }> = [];
	for (const raw of lines.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator < 1 || !line.slice(separator + 1).trim())
			throw new Error("Use one additional header per line: Name: value.");
		headers.push({
			name: line.slice(0, separator).trim(),
			value: line.slice(separator + 1).trim(),
		});
	}
	return headers;
}

function isLoopbackBaseUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		const hostname = parsed.hostname;
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			(hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "::1" ||
				hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function mergeAccounts(
	configured: readonly ProviderAccountSummary[],
	runtime: readonly ProviderAccountSummary[],
): ProviderAccountSummary[] {
	const runtimeById = new Map(runtime.map((account) => [account.id, account]));
	const merged = configured.map((account) => runtimeById.get(account.id) ?? account);
	for (const account of runtime) {
		if (!configured.some((configuredAccount) => configuredAccount.id === account.id))
			merged.push(account);
	}
	return merged.sort(
		(left, right) =>
			left.providerId.localeCompare(right.providerId) ||
			left.displayName.localeCompare(right.displayName),
	);
}

function groupsFor(
	accounts: readonly ProviderAccountSummary[],
): Array<{ providerId: string; accounts: ProviderAccountSummary[] }> {
	const groups = new Map<string, ProviderAccountSummary[]>();
	for (const account of accounts) {
		const group = groups.get(account.providerId) ?? [];
		group.push(account);
		groups.set(account.providerId, group);
	}
	return [...groups.entries()].map(([providerId, group]) => ({
		providerId,
		accounts: group,
	}));
}

export function ProviderAccountsSettings() {
	const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([]);
	const [form, setForm] = useState<AccountForm>(INITIAL_FORM);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [keyUpdate, setKeyUpdate] = useState<Record<string, string>>({});
	const accountGroups = useMemo(() => groupsFor(accounts), [accounts]);
	const selectedKind =
		ACCOUNT_KINDS.find((kind) => kind.id === form.kindId) ?? ACCOUNT_KINDS[0]!;
	const selectedAuthTransport =
		selectedKind.adapter === "openai-compatible" &&
		isLoopbackBaseUrl(form.baseUrl.trim())
			? "local"
			: selectedKind.authTransport;
	const showsApiKey = selectedKind.showsApiKey && selectedAuthTransport === "api_key";

	async function load(): Promise<ProviderAccountSummary[]> {
		const [configuredRaw, runtimeRaw] = await Promise.all([
			window.kestrel.request({ type: "provider-account-list" }),
			window.kestrel.request({ type: "runtime-list-providers" }),
		]);
		const configured = configuredRaw as CoreResponse;
		const runtime = runtimeRaw as CoreResponse;
		if (!configured.ok) throw new Error(configured.error);
		if (!runtime.ok) throw new Error(runtime.error);
		const merged = mergeAccounts(
			configured.providerAccounts ?? [],
			runtime.providerAccounts ?? [],
		);
		setAccounts(merged);
		return merged;
	}

	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Could not load provider accounts.",
			),
		);
	}, []);

	function chooseKind(kindId: string) {
		const kind = ACCOUNT_KINDS.find((candidate) => candidate.id === kindId);
		if (!kind) return;
		setForm((current) => ({
			...current,
			kindId,
			providerId: kind.providerId,
			baseUrl: kind.adapter === "ollama" ? "http://127.0.0.1:11434" : "",
			apiKey: "",
			headerLines: "",
		}));
	}

	async function refreshModels(accountId?: string) {
		setBusy(accountId ? `refresh:${accountId}` : "refresh:all");
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-refresh-provider-models",
				...(accountId ? { providerId: accountId } : {}),
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const configuredRaw = (await window.kestrel.request({
				type: "provider-account-list",
			})) as CoreResponse;
			if (!configuredRaw.ok) throw new Error(configuredRaw.error);
			setAccounts(
				mergeAccounts(
					configuredRaw.providerAccounts ?? [],
					response.providerAccounts ?? [],
				),
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not refresh this account's model catalog.",
			);
		} finally {
			setBusy("");
		}
	}

	async function addAccount(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy("add");
		setError("");
		try {
			const existingIds = new Set(accounts.map((account) => account.id));
			const providerId = form.providerId.trim().toLowerCase();
			if (!providerId) throw new Error("Enter a provider ID.");
			const headers = parseHeaders(form.headerLines);
			const response = (await window.kestrel.request({
				type: "provider-account-create",
				account: {
					providerId,
					adapter: selectedKind.adapter,
					displayName: form.displayName.trim() || `${providerLabel(providerId)} account`,
					authTransport: selectedAuthTransport,
					enabled: true,
					...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
					...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
					...(form.defaultModel.trim()
						? { defaultModel: form.defaultModel.trim() }
						: {}),
					...(form.organization.trim()
						? { organization: form.organization.trim() }
						: {}),
					...(form.project.trim() ? { project: form.project.trim() } : {}),
					headers,
				},
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const createdId = response.providerAccounts?.find(
				(account) => !existingIds.has(account.id),
			)?.id;
			setForm((current) => ({
				...INITIAL_FORM,
				kindId: current.kindId,
				providerId: selectedKind.providerId,
			}));
			await load();
			if (createdId && selectedAuthTransport !== "oauth")
				await refreshModels(createdId);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not add the account.",
			);
		} finally {
			setBusy("");
		}
	}

	async function updateAccount(
		account: ProviderAccountSummary,
		update: Record<string, unknown>,
		operation: string,
	) {
		setBusy(operation);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "provider-account-update",
				account: { id: account.id, ...update },
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not update the account.",
			);
		} finally {
			setBusy("");
		}
	}

	async function connect(account: ProviderAccountSummary) {
		setBusy(`connect:${account.id}`);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "provider-account-connect",
				accountId: account.id,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
			await refreshModels(account.id);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not connect this account.",
			);
		} finally {
			setBusy("");
		}
	}

	async function removeAccount(account: ProviderAccountSummary) {
		if (!window.confirm(`Remove ${account.displayName}? Its protected credential will be disconnected from Kestrel.`))
			return;
		setBusy(`remove:${account.id}`);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "provider-account-remove",
				accountId: account.id,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not remove the account.",
			);
		} finally {
			setBusy("");
		}
	}

	return (
		<article className="setting-row provider-accounts-setting">
			<div className="provider-accounts-content">
				<header className="provider-accounts-heading">
					<div>
						<strong>Provider accounts</strong>
						<p>
							Each account has its own protected credential or profile, model catalog,
							and routing endpoint.
						</p>
					</div>
					<button
						type="button"
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={() => void refreshModels()}
					>
						{busy === "refresh:all" ? "Refreshing…" : "Refresh all models"}
					</button>
				</header>

				{accountGroups.length === 0 ? (
					<p className="provider-account-empty">
						Add a provider account to discover models available to it.
					</p>
				) : (
					<div className="provider-account-groups">
						{accountGroups.map((group) => (
							<section key={group.providerId} className="provider-account-group">
								<h3>{providerLabel(group.providerId)}</h3>
								<div className="provider-account-cards">
									{group.accounts.map((account) => {
										const status = statusFor(account);
										return (
											<article key={account.id} className="provider-account-card">
												<header>
													<div>
														<strong>{account.displayName}</strong>
														<small>
															{account.authTransport.replaceAll("_", " ")} · {account.models.length} model{account.models.length === 1 ? "" : "s"}
														</small>
													</div>
													<span className={`provider-account-status is-${status.tone}`}>
														{status.label}
													</span>
												</header>
												<p>{refreshedLabel(account)}</p>
												{account.discovery.error ? (
													<p className="provider-account-error" role="alert">
														{account.discovery.error}
													</p>
												) : null}
												<div className="provider-account-actions">
													<button
														type="button"
														className="button secondary"
														disabled={Boolean(busy) || !account.enabled}
														onClick={() => void refreshModels(account.id)}
													>
														{busy === `refresh:${account.id}` ? "Refreshing…" : "Refresh models"}
													</button>
													{account.authTransport === "oauth" ? (
														<button
															type="button"
															className="button primary"
															disabled={Boolean(busy)}
															onClick={() => void connect(account)}
														>
															{busy === `connect:${account.id}` ? "Connecting…" : "Connect"}
														</button>
													) : null}
													<button
														type="button"
														className="button secondary"
														disabled={Boolean(busy)}
														onClick={() =>
															void updateAccount(
																account,
																{ enabled: !account.enabled },
																`toggle:${account.id}`,
															)
														}
													>
														{busy === `toggle:${account.id}`
															? "Updating…"
															: account.enabled
																? "Disable"
																: "Enable"}
													</button>
												</div>
												<details className="provider-account-details">
													<summary>Account details</summary>
													<form
														className="provider-account-rename"
														onSubmit={(event) => {
															event.preventDefault();
															const value = new FormData(event.currentTarget).get("displayName");
															if (typeof value === "string" && value.trim())
																void updateAccount(
																	account,
																	{ displayName: value.trim() },
																	`rename:${account.id}`,
																);
														}}
													>
															<label>
																Account label
																<input name="displayName" defaultValue={account.displayName} />
															</label>
															<button type="submit" className="button secondary" disabled={Boolean(busy)}>
																Rename
															</button>
														</form>
													{account.authTransport === "api_key" ? (
														<form
															className="provider-account-rename"
															onSubmit={(event) => {
																event.preventDefault();
																const apiKey = keyUpdate[account.id]?.trim();
																if (apiKey)
																	void updateAccount(account, { apiKey }, `key:${account.id}`);
															}}
														>
															<label>
																Replace protected API key
																<input
																	type="password"
																	autoComplete="off"
																	value={keyUpdate[account.id] ?? ""}
																	onChange={(event) =>
																		setKeyUpdate((current) => ({
																			...current,
																			[account.id]: event.target.value,
																		}))
																	}
																/>
															</label>
															<button type="submit" className="button secondary" disabled={Boolean(busy)}>
																Save key
															</button>
														</form>
													) : null}
													<div className="provider-account-models">
														<strong>Discovered models</strong>
														{account.models.length ? (
															<ul>
																{account.models.map((model) => (
													<li key={model.id}>
														<span>{model.displayName}</span>
														<small>
															{model.availability.replaceAll("_", " ")} · {model.discoverySource.replaceAll("_", " ")}
															{model.capabilities.capabilityProvenance !== "confirmed"
																? " · capabilities need verification"
																: ""}
														</small>
																	</li>
																))}
															</ul>
														) : (
															<p>No models have been discovered for this account yet.</p>
														)}
													</div>
													<button
														type="button"
														className="quiet-link provider-account-remove"
														disabled={Boolean(busy)}
														onClick={() => void removeAccount(account)}
													>
														{busy === `remove:${account.id}` ? "Removing…" : "Remove account"}
													</button>
												</details>
											</article>
										);
									})}
								</div>
							</section>
						))}
					</div>
				)}

				<aside className="provider-account-unsupported" aria-label="Unsupported subscription connectors">
					<strong>Unsupported subscription connectors</strong>
					<p>
						Cursor and Google AI subscription profiles do not yet have a tested,
						account-isolated Kestrel transport. They are intentionally not shown as
						connection types. Use a supported API account or a local compatible
						endpoint instead; Kestrel never imports browser cookies or copied login state.
					</p>
				</aside>

				<form className="provider-account-add" onSubmit={(event) => void addAccount(event)}>
					<header>
						<strong>Add account</strong>
						<small>Credentials are saved only in Kestrel's protected native storage.</small>
					</header>
					<div className="provider-account-add-grid">
						<label>
							Connection type
							<select value={form.kindId} onChange={(event) => chooseKind(event.target.value)}>
								{ACCOUNT_KINDS.map((kind) => (
									<option key={kind.id} value={kind.id}>{kind.label}</option>
								))}
							</select>
						</label>
						<label>
							Account label
							<input
								value={form.displayName}
								onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
								placeholder="Personal, Work, Team…"
							/>
						</label>
						<label>
							Provider ID
							<input
								value={form.providerId}
								onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value }))}
								disabled={selectedKind.id !== "compatible"}
							/>
						</label>
						<label>
							Base URL {selectedKind.requiresBaseUrl ? "(required)" : "(optional)"}
							<input
								value={form.baseUrl}
								onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
							placeholder={selectedKind.adapter === "ollama" ? "http://127.0.0.1:11434" : selectedKind.adapter === "openai-compatible" ? "http://127.0.0.1:1234/v1 or https://api.example.com/v1" : "https://api.example.com/v1"}
								required={selectedKind.requiresBaseUrl}
							/>
						</label>
						{showsApiKey ? (
							<label>
								Protected API key
								<input
									type="password"
									autoComplete="off"
									value={form.apiKey}
									onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
									required
								/>
							</label>
						) : null}
						<label>
							Fallback model ID (optional)
							<input
								value={form.defaultModel}
								onChange={(event) => setForm((current) => ({ ...current, defaultModel: event.target.value }))}
								placeholder="Used only when the provider has no supported listing"
							/>
						</label>
					</div>
					<details className="provider-account-advanced">
						<summary>Advanced connection settings</summary>
						<div className="provider-account-add-grid">
							<label>
								Organization (optional)
								<input value={form.organization} onChange={(event) => setForm((current) => ({ ...current, organization: event.target.value }))} />
							</label>
							<label>
								Project (optional)
								<input value={form.project} onChange={(event) => setForm((current) => ({ ...current, project: event.target.value }))} />
							</label>
							<label className="provider-account-headers">
								Additional request headers
								<textarea
									rows={3}
									value={form.headerLines}
									onChange={(event) => setForm((current) => ({ ...current, headerLines: event.target.value }))}
									placeholder="Header-Name: value"
								/>
							</label>
						</div>
					</details>
					<p className="provider-account-kind-description">
						Detected OpenCode and Claude Code profiles remain available through
						their existing trusted CLI setup. Kestrel does not copy or synthesize
						additional CLI credential profiles.
					</p>
					<p className="provider-account-kind-description">{selectedKind.description}</p>
					{selectedKind.adapter === "openai-compatible" &&
					selectedAuthTransport === "local" ? (
						<p className="provider-account-kind-description">
							Loopback runtime detected: Kestrel will use this local endpoint without an API key.
						</p>
					) : null}
					<button type="submit" className="button primary" disabled={Boolean(busy)}>
						{busy === "add" ? "Adding…" : "Add account"}
					</button>
				</form>
				{error ? <small className="provider-account-global-error" role="alert">{error}</small> : null}
			</div>
		</article>
	);
}
