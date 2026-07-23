import { useEffect, useMemo, useState } from "react";
import type {
  BrokeredCredentialSummary,
  ExternalSecretConfiguration,
  ExternalSecretProviderId,
  ExternalSecretProviderStatus
} from "@kestrel/shared-types";

const EMPTY_CONFIGURATION: ExternalSecretConfiguration = {
  version: 1,
  onepassword: { enabled: false, account: "", mappings: {}, overrideStored: true },
  bitwarden: { enabled: false, projectId: "", serverUrl: "", autoInstall: true, overrideStored: true },
  command: { enabled: false, executablePath: "", arguments: [], timeoutMs: 3_000, overrideStored: false }
};

const credentialOptions: Array<{ id: BrokeredCredentialSummary["id"]; label: string }> = [
  { id: "openai", label: "OpenAI · primary" },
  { id: "openai-secondary", label: "OpenAI · backup" },
  { id: "anthropic", label: "Anthropic · primary" },
  { id: "anthropic-secondary", label: "Anthropic · backup" },
  { id: "gemini", label: "Google Gemini" },
  { id: "brave-search", label: "Brave Search" },
  { id: "github", label: "GitHub" },
  { id: "fal", label: "fal media" }
];

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function ExternalSecretSettings() {
  const [configuration, setConfiguration] = useState<ExternalSecretConfiguration>(() => structuredClone(EMPTY_CONFIGURATION));
  const [sources, setSources] = useState<ExternalSecretProviderStatus[]>([]);
  const [onePasswordToken, setOnePasswordToken] = useState("");
  const [bitwardenToken, setBitwardenToken] = useState("");
  const [mappingId, setMappingId] = useState<BrokeredCredentialSummary["id"]>("openai");
  const [mappingReference, setMappingReference] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const response = await window.kestrel.request({ type: "external-secret-list" });
    if (!response.ok) throw new Error(response.error);
    if ("externalSecretSources" in response) {
      setSources(response.externalSecretSources);
      setConfiguration(response.externalSecretConfiguration);
    }
  }

  useEffect(() => {
    void load().catch((cause) => setError(errorMessage(cause, "External secret status failed.")));
  }, []);

  const sourceById = useMemo(
    () => Object.fromEntries(sources.map((source) => [source.id, source])) as Partial<Record<ExternalSecretProviderId, ExternalSecretProviderStatus>>,
    [sources]
  );

  function update<K extends ExternalSecretProviderId>(providerId: K, values: Partial<ExternalSecretConfiguration[K]>) {
    setConfiguration((current) => ({
      ...current,
      [providerId]: { ...current[providerId], ...values }
    }));
    setNotice("");
    setError("");
  }

  function receive(response: Awaited<ReturnType<typeof window.kestrel.request>>) {
    if (!response.ok) throw new Error(response.error);
    if ("externalSecretSources" in response) {
      setSources(response.externalSecretSources);
      setConfiguration(response.externalSecretConfiguration);
    }
  }

  async function save(providerId: ExternalSecretProviderId) {
    setBusy(`save:${providerId}`); setError(""); setNotice("");
    try {
      const response = await window.kestrel.request({
        type: "external-secret-save",
        configuration,
        ...(onePasswordToken.trim() ? { onePasswordToken: onePasswordToken.trim() } : {}),
        ...(bitwardenToken.trim() ? { bitwardenToken: bitwardenToken.trim() } : {})
      });
      receive(response);
      setOnePasswordToken("");
      setBitwardenToken("");
      setNotice(`${sourceById[providerId]?.label ?? "Source"} configuration saved. Sync to verify and apply it.`);
    } catch (cause) {
      setError(errorMessage(cause, "External secret configuration could not be saved."));
    } finally {
      setBusy("");
    }
  }

  async function sync(providerId: ExternalSecretProviderId) {
    setBusy(`sync:${providerId}`); setError(""); setNotice("");
    try {
      const saved = await window.kestrel.request({
        type: "external-secret-save",
        configuration,
        ...(onePasswordToken.trim() ? { onePasswordToken: onePasswordToken.trim() } : {}),
        ...(bitwardenToken.trim() ? { bitwardenToken: bitwardenToken.trim() } : {})
      });
      receive(saved);
      const response = await window.kestrel.request({ type: "external-secret-sync", providerId });
      receive(response);
      setOnePasswordToken("");
      setBitwardenToken("");
      setNotice(`${sourceById[providerId]?.label ?? "Source"} verified and applied to the isolated core.`);
    } catch (cause) {
      setError(errorMessage(cause, "External secret source could not be verified."));
    } finally {
      setBusy("");
    }
  }

  async function installBitwarden() {
    setBusy("install:bitwarden"); setError(""); setNotice("");
    try {
      const response = await window.kestrel.request({ type: "external-secret-install-bitwarden" });
      receive(response);
      setNotice("Verified Bitwarden CLI installed locally. Add a project and machine-account token to continue.");
    } catch (cause) {
      setError(errorMessage(cause, "Bitwarden CLI installation failed."));
    } finally {
      setBusy("");
    }
  }

  async function remove(providerId: ExternalSecretProviderId) {
    setBusy(`remove:${providerId}`); setError(""); setNotice("");
    try {
      const response = await window.kestrel.request({ type: "external-secret-remove", providerId });
      receive(response);
      if (providerId === "onepassword") setOnePasswordToken("");
      if (providerId === "bitwarden") setBitwardenToken("");
      setNotice(`${sourceById[providerId]?.label ?? "Source"} configuration removed.`);
    } catch (cause) {
      setError(errorMessage(cause, "External secret source could not be removed."));
    } finally {
      setBusy("");
    }
  }

  function sourceSummary(providerId: ExternalSecretProviderId) {
    const source = sourceById[providerId];
    return <span className={`external-secret-state ${source?.state ?? "needs_setup"}`}>
      {source ? source.state.replace("_", " ") : "checking"}
    </span>;
  }

  const activeCount = sources.filter((source) => source.state === "verified").length;
  const mappedCredentials = Object.entries(configuration.onepassword.mappings) as Array<[BrokeredCredentialSummary["id"], string]>;

  return <article className="setting-row external-secret-setting">
    <div className="external-secret-content">
      <strong>External secret sources</strong>
      <p>Optional for advanced setups. Kestrel resolves only supported provider credentials, keeps values out of the interface, and gives saved protected fields precedence unless you explicitly override them.</p>
      <div className="external-secret-list">
        <details>
          <summary><span><b>1Password CLI</b><small>{sourceById.onepassword?.detail ?? "Checking the official CLI…"}</small></span>{sourceSummary("onepassword")}</summary>
          <div className="external-secret-form">
            <label className="checkbox-label"><input type="checkbox" checked={configuration.onepassword.enabled} onChange={(event) => update("onepassword", { enabled: event.target.checked })} /><span>Resolve mapped credentials at startup</span></label>
            <div className="external-secret-grid">
              <label>CLI path <input value={configuration.onepassword.binaryPath ?? ""} placeholder="/opt/homebrew/bin/op" autoComplete="off" spellCheck={false} onChange={(event) => update("onepassword", { binaryPath: event.target.value || undefined })} /></label>
              <label>Account <input value={configuration.onepassword.account} placeholder="my.1password.com" autoComplete="off" spellCheck={false} onChange={(event) => update("onepassword", { account: event.target.value })} /></label>
              <label className="wide">Service-account token <input type="password" value={onePasswordToken} placeholder="Optional replacement; desktop sign-in also works" autoComplete="new-password" spellCheck={false} aria-describedby="onepassword-token-note" onChange={(event) => setOnePasswordToken(event.target.value)} /></label>
            </div>
            <small id="onepassword-token-note">The token is OS-encrypted and never shown again. Kestrel passes it only to the official op process.</small>
            <div className="external-secret-mapper">
              <label>Credential <select value={mappingId} onChange={(event) => setMappingId(event.target.value as BrokeredCredentialSummary["id"])}>{credentialOptions.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}</select></label>
              <label>Secret reference <input value={mappingReference} placeholder="op://Vault/Item/field" autoComplete="off" spellCheck={false} onChange={(event) => setMappingReference(event.target.value)} /></label>
              <button className="button secondary" disabled={!mappingReference.trim()} onClick={() => {
                update("onepassword", { mappings: { ...configuration.onepassword.mappings, [mappingId]: mappingReference.trim() } });
                setMappingReference("");
              }}>Add mapping</button>
            </div>
            {mappedCredentials.length > 0 && <ul className="external-secret-mappings">{mappedCredentials.map(([id, reference]) => <li key={id}><span>{credentialOptions.find((option) => option.id === id)?.label ?? id}<small>{reference}</small></span><button className="quiet-link" onClick={() => {
              const mappings = { ...configuration.onepassword.mappings };
              delete mappings[id];
              update("onepassword", { mappings });
            }}>Remove</button></li>)}</ul>}
            <label className="checkbox-label"><input type="checkbox" checked={configuration.onepassword.overrideStored} onChange={(event) => update("onepassword", { overrideStored: event.target.checked })} /><span>Override matching protected fields</span></label>
            <div className="button-row">
              <button className="button secondary" disabled={Boolean(busy)} onClick={() => void save("onepassword")}>{busy === "save:onepassword" ? "Saving…" : "Save configuration"}</button>
              <button className="button primary" disabled={Boolean(busy) || !configuration.onepassword.enabled || mappedCredentials.length === 0} onClick={() => void sync("onepassword")}>{busy === "sync:onepassword" ? "Verifying…" : "Sync and verify"}</button>
              <button className="quiet-link" disabled={Boolean(busy)} onClick={() => void remove("onepassword")}>Remove source</button>
            </div>
          </div>
        </details>

        <details>
          <summary><span><b>Bitwarden Secrets Manager</b><small>{sourceById.bitwarden?.detail ?? "Checking the verified bws CLI…"}</small></span>{sourceSummary("bitwarden")}</summary>
          <div className="external-secret-form">
            <label className="checkbox-label"><input type="checkbox" checked={configuration.bitwarden.enabled} onChange={(event) => update("bitwarden", { enabled: event.target.checked })} /><span>Resolve supported secret names at startup</span></label>
            <div className="external-secret-grid">
              <label>Project ID <input value={configuration.bitwarden.projectId} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} onChange={(event) => update("bitwarden", { projectId: event.target.value })} /></label>
              <label>Server URL <input value={configuration.bitwarden.serverUrl} placeholder="Default Bitwarden cloud" autoComplete="off" spellCheck={false} onChange={(event) => update("bitwarden", { serverUrl: event.target.value })} /></label>
              <label>CLI path <input value={configuration.bitwarden.binaryPath ?? ""} placeholder="Managed install or absolute path" autoComplete="off" spellCheck={false} onChange={(event) => update("bitwarden", { binaryPath: event.target.value || undefined })} /></label>
              <label>Machine-account token <input type="password" value={bitwardenToken} placeholder="Enter or replace token" autoComplete="new-password" spellCheck={false} aria-describedby="bitwarden-token-note" onChange={(event) => setBitwardenToken(event.target.value)} /></label>
            </div>
            <small id="bitwarden-token-note">The token is OS-encrypted. Only names matching supported provider fields are accepted from the project.</small>
            <label className="checkbox-label"><input type="checkbox" checked={configuration.bitwarden.autoInstall} onChange={(event) => update("bitwarden", { autoInstall: event.target.checked })} /><span>Use the pinned, checksum-verified managed CLI</span></label>
            <label className="checkbox-label"><input type="checkbox" checked={configuration.bitwarden.overrideStored} onChange={(event) => update("bitwarden", { overrideStored: event.target.checked })} /><span>Override matching protected fields</span></label>
            <div className="button-row">
              <button className="button secondary" disabled={Boolean(busy)} onClick={() => void installBitwarden()}>{busy === "install:bitwarden" ? "Installing…" : sourceById.bitwarden?.managedBinary ? "Verified CLI installed" : "Install verified CLI"}</button>
              <button className="button secondary" disabled={Boolean(busy)} onClick={() => void save("bitwarden")}>{busy === "save:bitwarden" ? "Saving…" : "Save configuration"}</button>
              <button className="button primary" disabled={Boolean(busy) || !configuration.bitwarden.enabled || !configuration.bitwarden.projectId || (!bitwardenToken && sourceById.bitwarden?.state === "needs_setup")} onClick={() => void sync("bitwarden")}>{busy === "sync:bitwarden" ? "Verifying…" : "Sync and verify"}</button>
              <button className="quiet-link" disabled={Boolean(busy)} onClick={() => void remove("bitwarden")}>Remove source</button>
            </div>
          </div>
        </details>

        <details>
          <summary><span><b>Command helper</b><small>{sourceById.command?.detail ?? "Checking the configured executable…"}</small></span>{sourceSummary("command")}</summary>
          <div className="external-secret-form">
            <label className="checkbox-label"><input type="checkbox" checked={configuration.command.enabled} onChange={(event) => update("command", { enabled: event.target.checked })} /><span>Run this exact executable at startup</span></label>
            <div className="external-secret-grid">
              <label className="wide">Executable path <input value={configuration.command.executablePath} placeholder="/absolute/path/to/helper" autoComplete="off" spellCheck={false} onChange={(event) => update("command", { executablePath: event.target.value })} /></label>
              <label className="wide">Arguments, one per line <textarea value={configuration.command.arguments.join("\n")} placeholder={"get\n--format=env"} spellCheck={false} onChange={(event) => update("command", { arguments: event.target.value.split(/\r?\n/).filter(Boolean) })} /></label>
              <label>Timeout in milliseconds <input type="number" min={250} max={10_000} step={250} value={configuration.command.timeoutMs} onChange={(event) => update("command", { timeoutMs: Number(event.target.value) })} /></label>
            </div>
            <small>Kestrel does not invoke a shell. The helper receives discrete arguments, a minimal environment, a hard timeout, and must print supported KEY=VALUE records.</small>
            <label className="checkbox-label"><input type="checkbox" checked={configuration.command.overrideStored} onChange={(event) => update("command", { overrideStored: event.target.checked })} /><span>Override matching protected fields</span></label>
            <div className="button-row">
              <button className="button secondary" disabled={Boolean(busy)} onClick={() => void save("command")}>{busy === "save:command" ? "Saving…" : "Save configuration"}</button>
              <button className="button primary" disabled={Boolean(busy) || !configuration.command.enabled || !configuration.command.executablePath} onClick={() => void sync("command")}>{busy === "sync:command" ? "Verifying…" : "Sync and verify"}</button>
              <button className="quiet-link" disabled={Boolean(busy)} onClick={() => void remove("command")}>Remove source</button>
            </div>
          </div>
        </details>
      </div>
      <div className="external-secret-feedback" aria-live="polite">
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
    </div>
    <span className="status">{activeCount} verified</span>
  </article>;
}
