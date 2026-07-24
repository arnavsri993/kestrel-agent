import { useEffect, useState } from "react";
import type {
  BrokeredCredentialSummary,
  CoreResponse,
  HonchoMemoryConfiguration,
  HonchoMemoryStatus,
} from "@kestrel/shared-types";

export function HonchoMemorySettings() {
  const [status, setStatus] = useState<HonchoMemoryStatus | null>(null);
  const [draft, setDraft] = useState<HonchoMemoryConfiguration | null>(null);
  const [credential, setCredential] =
    useState<BrokeredCredentialSummary | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [memoryRaw, credentialsRaw] = await Promise.all([
      window.kestrel.request({ type: "honcho-memory-get" }),
      window.kestrel.request({ type: "credential-list" }),
    ]);
    const memory = memoryRaw as CoreResponse;
    if (!memory.ok) throw new Error(memory.error);
    if (!memory.honchoMemoryStatus)
      throw new Error("Honcho memory status is unavailable.");
    setStatus(memory.honchoMemoryStatus);
    setDraft(memory.honchoMemoryStatus.configuration);
    if (credentialsRaw.ok && "credentials" in credentialsRaw)
      setCredential(
        credentialsRaw.credentials.find((item) => item.id === "honcho") ?? null,
      );
  }

  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Honcho memory status could not be loaded.",
      ),
    );
  }, []);

  async function configure(enabled = draft?.enabled ?? false) {
    if (!draft) return;
    if (enabled && !status?.configuration.enabled && !acknowledged) {
      setError("Acknowledge the remote-data boundary before enabling Honcho.");
      return;
    }
    setBusy(enabled ? "enable" : "save");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request({
        type: "honcho-memory-configure",
        configuration: { ...draft, enabled },
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (response.honchoMemoryStatus) {
        setStatus(response.honchoMemoryStatus);
        setDraft(response.honchoMemoryStatus.configuration);
      }
      setNotice(
        enabled
          ? "Honcho memory settings saved."
          : "Honcho is disabled; local memory remains active.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Honcho memory settings could not be saved.",
      );
    } finally {
      setBusy("");
    }
  }

  async function saveKey() {
    if (apiKey.trim().length < 8) {
      setError("Enter the complete Honcho API key.");
      return;
    }
    setBusy("key");
    setError("");
    setNotice("");
    try {
      const response = await window.kestrel.request({
        type: "credential-set",
        credentialId: "honcho",
        value: apiKey,
      });
      if (!response.ok)
        throw new Error(
          "error" in response ? response.error : "Honcho key save failed.",
        );
      setApiKey("");
      await load();
      setNotice("Honcho API key saved in protected macOS storage.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Honcho key save failed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function removeKey() {
    setBusy("key");
    setError("");
    setNotice("");
    try {
      if (draft?.enabled) await configure(false);
      const response = await window.kestrel.request({
        type: "credential-remove",
        credentialId: "honcho",
      });
      if (!response.ok)
        throw new Error(
          "error" in response ? response.error : "Honcho key removal failed.",
        );
      await load();
      setNotice("Honcho API key removed; local memory was not changed.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Honcho key removal failed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function verify() {
    setBusy("verify");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request({
        type: "honcho-memory-verify",
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (response.honchoMemoryStatus) {
        setStatus(response.honchoMemoryStatus);
        setDraft(response.honchoMemoryStatus.configuration);
      }
      setNotice("Honcho workspace verified.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Honcho verification failed.",
      );
    } finally {
      setBusy("");
    }
  }

  if (!status || !draft)
    return (
      <article className="setting-row honcho-memory-setting">
        <div>
          <strong>Honcho remote memory</strong>
          <p>{error || "Loading optional memory provider…"}</p>
        </div>
      </article>
    );

  return (
    <article className="setting-row honcho-memory-setting">
      <div>
        <strong>Honcho remote memory</strong>
        <p>
          Optional reasoning-backed memory alongside Kestrel’s encrypted local
          memory. Local facts, corrections, review, and deletion controls stay
          available even when Honcho is enabled.
        </p>
        <small className="honcho-disclosure">
          {status.remoteDataDisclosure}
        </small>

        <div className="honcho-key-row">
          <label>
            <span>
              Honcho API key ·{" "}
              {credential?.configured ? "protected" : "not configured"}
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={
                credential?.configured ? "Enter replacement" : "Enter API key"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            disabled={Boolean(busy)}
            onClick={() => void saveKey()}
          >
            {credential?.configured ? "Replace key" : "Save key"}
          </button>
          {credential?.configured && (
            <button
              className="quiet-link"
              disabled={Boolean(busy)}
              onClick={() => void removeKey()}
            >
              Remove
            </button>
          )}
        </div>

        <HonchoConfigurationForm draft={draft} setDraft={setDraft} />

        {!status.configuration.enabled && (
          <label className="honcho-check honcho-consent">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I understand that enabling Honcho sends the disclosed data to the
            configured server.
          </label>
        )}
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
      <div className="honcho-actions">
        <span className={`status status-${status.state}`}>
          {status.state.replace("_", " ")}
        </span>
        {status.configuration.enabled ? (
          <>
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void configure(true)}
            >
              Save settings
            </button>
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void verify()}
            >
              Verify connection
            </button>
            <button
              className="quiet-link"
              disabled={Boolean(busy)}
              onClick={() => void configure(false)}
            >
              Disable
            </button>
          </>
        ) : (
          <button
            className="button secondary"
            disabled={Boolean(busy) || !acknowledged}
            onClick={() => void configure(true)}
          >
            Enable Honcho
          </button>
        )}
        <small>{status.syncedMessages} messages synced</small>
      </div>
    </article>
  );
}

function HonchoConfigurationForm({
  draft,
  setDraft,
}: {
  draft: HonchoMemoryConfiguration;
  setDraft: (draft: HonchoMemoryConfiguration) => void;
}) {
  return (
    <details className="honcho-configuration">
      <summary>Provider configuration and reasoning controls</summary>
      <div className="honcho-form">
        <label>
          <span>Server URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) =>
              setDraft({ ...draft, baseUrl: event.target.value })
            }
          />
        </label>
        <label>
          <span>Workspace ID</span>
          <input
            value={draft.workspaceId}
            onChange={(event) =>
              setDraft({ ...draft, workspaceId: event.target.value })
            }
          />
        </label>
        <label>
          <span>User peer</span>
          <input
            value={draft.userPeerId}
            onChange={(event) =>
              setDraft({ ...draft, userPeerId: event.target.value })
            }
          />
        </label>
        <label>
          <span>Agent peer</span>
          <input
            value={draft.agentPeerId}
            onChange={(event) =>
              setDraft({ ...draft, agentPeerId: event.target.value })
            }
          />
        </label>
        <label>
          <span>Recall mode</span>
          <select
            value={draft.recallMode}
            onChange={(event) =>
              setDraft({
                ...draft,
                recallMode: event.target
                  .value as HonchoMemoryConfiguration["recallMode"],
              })
            }
          >
            <option value="hybrid">Context + tools</option>
            <option value="context">Context only</option>
            <option value="tools">Tools only</option>
          </select>
        </label>
        <label>
          <span>Session strategy</span>
          <select
            value={draft.sessionStrategy}
            onChange={(event) =>
              setDraft({
                ...draft,
                sessionStrategy: event.target
                  .value as HonchoMemoryConfiguration["sessionStrategy"],
              })
            }
          >
            <option value="per-session">Per conversation</option>
            <option value="per-project">Per project</option>
            <option value="global">Global</option>
          </select>
        </label>
        <label>
          <span>Observation</span>
          <select
            value={draft.observationMode}
            onChange={(event) =>
              setDraft({
                ...draft,
                observationMode: event.target
                  .value as HonchoMemoryConfiguration["observationMode"],
              })
            }
          >
            <option value="directional">Directional</option>
            <option value="unified">Unified</option>
          </select>
        </label>
        <label>
          <span>Context tokens</span>
          <input
            type="number"
            min={256}
            max={16000}
            value={draft.contextTokens}
            onChange={(event) =>
              setDraft({
                ...draft,
                contextTokens: Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          <span>Context cadence</span>
          <input
            type="number"
            min={1}
            max={20}
            value={draft.contextCadence}
            onChange={(event) =>
              setDraft({
                ...draft,
                contextCadence: Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          <span>Dialectic cadence</span>
          <input
            type="number"
            min={1}
            max={20}
            value={draft.dialecticCadence}
            onChange={(event) =>
              setDraft({
                ...draft,
                dialecticCadence: Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          <span>Dialectic depth</span>
          <select
            value={draft.dialecticDepth}
            onChange={(event) =>
              setDraft({
                ...draft,
                dialecticDepth: Number(
                  event.target.value,
                ) as HonchoMemoryConfiguration["dialecticDepth"],
              })
            }
          >
            <option value={1}>1 pass</option>
            <option value={2}>2 passes</option>
            <option value={3}>3 passes</option>
          </select>
        </label>
        <label>
          <span>Reasoning level</span>
          <select
            value={draft.dialecticReasoningLevel}
            onChange={(event) =>
              setDraft({
                ...draft,
                dialecticReasoningLevel: event.target
                  .value as HonchoMemoryConfiguration["dialecticReasoningLevel"],
              })
            }
          >
            {["minimal", "low", "medium", "high", "max"].map((level) => (
              <option value={level} key={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Dialectic output characters</span>
          <input
            type="number"
            min={100}
            max={4000}
            value={draft.dialecticMaxChars}
            onChange={(event) =>
              setDraft({
                ...draft,
                dialecticMaxChars: Number(event.target.value),
              })
            }
          />
        </label>
      </div>
      <label className="honcho-check">
        <input
          type="checkbox"
          checked={draft.saveMessages}
          onChange={(event) =>
            setDraft({ ...draft, saveMessages: event.target.checked })
          }
        />
        Save bounded user and assistant messages to Honcho
      </label>
      <label className="honcho-check">
        <input
          type="checkbox"
          checked={draft.reasoningHeuristic}
          onChange={(event) =>
            setDraft({
              ...draft,
              reasoningHeuristic: event.target.checked,
            })
          }
        />
        Scale reasoning for longer queries, capped at high
      </label>
    </details>
  );
}
