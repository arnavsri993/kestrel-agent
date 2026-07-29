import type { RuntimeMessage } from "@kestrel/shared-types";
import { Icon } from "./Icon";

export interface ConfigurationMessageModel {
  kind: "plan" | "applied" | "rollback" | "history" | "improvements" | "error";
  title: string;
  status: string;
  summary: string;
  diff?: string;
  checks: string[];
  version?: string;
  undoPrompt?: string;
  error?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function checkLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const check = objectValue(item);
        return typeof check?.detail === "string"
          ? [check.detail]
          : typeof check?.id === "string"
            ? [check.id]
            : [];
      })
    : [];
}

export function parseConfigurationMessage(
  message: Pick<RuntimeMessage, "toolName" | "content">,
): ConfigurationMessageModel | null {
  if (!message.toolName?.startsWith("agent.config.")) return null;
  let envelope: Record<string, unknown>;
  try {
    envelope = objectValue(JSON.parse(message.content)) ?? {};
  } catch {
    return {
      kind: "error",
      title: "Configuration result",
      status: "unreadable",
      summary: "The configuration result could not be displayed safely.",
      checks: [],
      error: "Malformed configuration result envelope.",
    };
  }
  if (envelope.status !== "verified") {
    return {
      kind: "error",
      title: "Configuration change did not complete",
      status: String(envelope.status ?? "failed"),
      summary:
        typeof envelope.error === "string"
          ? envelope.error
          : "No live configuration change was verified.",
      checks: [],
      ...(typeof envelope.error === "string" ? { error: envelope.error } : {}),
    };
  }
  const output = objectValue(envelope.output) ?? {};
  if (message.toolName === "agent.config.plan") {
    const proposal = objectValue(output.proposal) ?? {};
    return {
      kind: "plan",
      title: "Configuration plan staged",
      status: "preview only",
      summary:
        typeof proposal.requestSummary === "string"
          ? proposal.requestSummary
          : "The candidate is isolated and the live agent is unchanged.",
      ...(typeof proposal.diff === "string" ? { diff: proposal.diff } : {}),
      checks: checkLabels(proposal.isolatedChecks),
      ...(typeof proposal.baseVersionId === "string"
        ? { version: proposal.baseVersionId }
        : {}),
    };
  }
  if (message.toolName === "agent.config.rollback-preview") {
    return {
      kind: "plan",
      title: "Restoration preview ready",
      status: "preview only",
      summary:
        "The live agent is unchanged. Review the exact known-good restoration before approving it.",
      ...(typeof output.preview === "string" ? { diff: output.preview } : {}),
      checks: [],
      ...(typeof output.targetVersionId === "string"
        ? { version: output.targetVersionId }
        : {}),
    };
  }
  if (
    message.toolName === "agent.config.apply" ||
    message.toolName === "agent.config.rollback"
  ) {
    const result = objectValue(output.result) ?? {};
    const version = objectValue(result.version) ?? {};
    const undo = objectValue(result.undo) ?? {};
    const rollback = message.toolName === "agent.config.rollback";
    return {
      kind: rollback ? "rollback" : "applied",
      title: rollback
        ? "Known-good configuration restored"
        : "Configuration verified and active",
      status: "verified",
      summary: rollback
        ? "A new restoring version is active. Earlier history remains intact."
        : "The approved version passed isolated checks and encrypted live read-back.",
      checks: checkLabels(result.verification),
      ...(typeof version.id === "string" ? { version: version.id } : {}),
      ...(typeof undo.request === "string"
        ? { undoPrompt: undo.request }
        : {}),
    };
  }
  if (
    message.toolName === "agent.config.history" ||
    message.toolName === "agent.config.audit"
  ) {
    const versions = Array.isArray(output.versions) ? output.versions : [];
    const events = Array.isArray(output.events) ? output.events : [];
    return {
      kind: "history",
      title:
        message.toolName === "agent.config.audit"
          ? "Configuration audit"
          : "Configuration history",
      status: "read only",
      summary:
        message.toolName === "agent.config.audit"
          ? `${events.length} append-only audit events are available.`
          : `${versions.length} immutable versions are available.`,
      checks: [],
    };
  }
  if (
    message.toolName === "agent.config.improvements" ||
    message.toolName === "agent.config.scan-improvements"
  ) {
    const improvements = Array.isArray(output.improvements)
      ? output.improvements
      : Array.isArray(output.detected)
        ? output.detected
        : [];
    return {
      kind: "improvements",
      title: "Self-improvement review",
      status: "suggestions only",
      summary:
        improvements.length === 0
          ? "No new evidence-backed weakness crossed the configured threshold."
          : `${improvements.length} evidence-backed suggestion${improvements.length === 1 ? "" : "s"} await review. Nothing was self-applied.`,
      checks: [],
    };
  }
  return {
    kind: "history",
    title: "Configuration inspected",
    status: "read only",
    summary: "The editable catalog and protected boundaries were returned.",
    checks: [],
  };
}

export function ConfigurationMessage({
  message,
  showDiffs,
  announceVerification,
  onPrepareUndo,
}: {
  message: RuntimeMessage;
  showDiffs: boolean;
  announceVerification: boolean;
  onPrepareUndo(prompt: string): void;
}) {
  const model = parseConfigurationMessage(message);
  if (!model) return null;
  const titleId = `${message.id}-configuration-title`;
  return (
    <article
      className={`configuration-message configuration-${model.kind}`}
      aria-labelledby={titleId}
    >
      <header>
        <span className="configuration-message-icon" aria-hidden="true">
          <Icon
            name={
              model.kind === "error"
                ? "safety"
                : model.kind === "plan"
                  ? "activity"
                  : "check"
            }
          />
        </span>
        <div>
          <span className="eyebrow">Chat configuration · {model.status}</span>
          <strong id={titleId}>{model.title}</strong>
        </div>
      </header>
      <p>{model.summary}</p>
      {model.version && <small className="configuration-version">{model.version}</small>}
      {showDiffs && model.diff && (
        <details>
          <summary>Review exact diff</summary>
          <pre>{model.diff}</pre>
        </details>
      )}
      {model.checks.length > 0 && (
        <details>
          <summary>{model.checks.length} verification checks passed</summary>
          <ul>
            {model.checks.map((check) => (
              <li key={check}>
                <Icon name="check" />
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {model.undoPrompt && (
        <footer>
          <span>
            This creates another reviewed version; it never deletes history.
          </span>
          <button
            type="button"
            className="button secondary"
            onClick={() => onPrepareUndo(model.undoPrompt!)}
          >
            Prepare undo
          </button>
        </footer>
      )}
      {announceVerification &&
        (model.kind === "applied" || model.kind === "rollback") && (
          <span className="sr-only" role="status">
            {model.title}. {model.summary}
          </span>
        )}
    </article>
  );
}
