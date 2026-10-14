import type { CoreResponse, WorkspaceSnapshot } from "@kestrel/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { Icon } from "./Icon";
import { EmptyState, PageFrame, Status } from "./ui";
import "./surface-pages.css";
import {
  pendingToolApprovals,
  policyGateCopy,
  runRouteLabel,
  type PendingToolApproval,
} from "../runtime-evidence";

type LoadState = "loading" | "ready" | "error";

export function RuntimeApprovalQueue({
  snapshot,
  update,
  onOpenSession,
}: {
  snapshot: WorkspaceSnapshot;
  update(next: WorkspaceSnapshot): void;
  onOpenSession(sessionId: string): void;
}) {
  const [pending, setPending] = useState<PendingToolApproval[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const latestRefresh = useRef(0);
  // Only a still-pending approval belongs here; resolved ones are history.
  const approval = snapshot.approvals.find(
    (candidate) => candidate.status === "pending",
  );

  const refresh = useCallback(async () => {
    const refreshId = ++latestRefresh.current;
    try {
      const response = (await window.kestrel.request({
        type: "runtime-list-pending-tool-approvals",
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (refreshId !== latestRefresh.current) return;
      setPending(
        pendingToolApprovals(response.runs ?? [], response.executions ?? []),
      );
      setError("");
      setLoadState("ready");
    } catch (cause) {
      if (refreshId !== latestRefresh.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Kestrel could not load the actions waiting for you.",
      );
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  async function request(input: Parameters<typeof window.kestrel.request>[0]) {
    const response = (await window.kestrel.request(input)) as CoreResponse;
    if (!response.ok) throw new Error(response.error);
    if (response.snapshot) update(response.snapshot);
    void refresh();
  }

  const hasItems = pending.length > 0 || Boolean(approval);

  if (!hasItems && loadState === "loading")
    return (
      <PageFrame
        title="Waiting for your OK"
        description="Checking for actions that need your decision."
        measure="reading"
        className="runtime-approval-queue"
      >
        <Status tone="info" live="polite">
          Loading…
        </Status>
      </PageFrame>
    );

  if (!hasItems && loadState === "error")
    return (
      <EmptyState
        title="Couldn't load waiting actions"
        detail={`${error} Nothing has been approved or rejected.`}
        action={
          <button
            className="button primary"
            type="button"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        }
      />
    );

  if (!hasItems)
    return (
      <EmptyState
        title="Nothing needs your OK"
        detail="When an action needs your decision, Kestrel pauses it here until you allow or reject it. A paused action stays here even if you quit and reopen Kestrel."
      />
    );

  return (
    <PageFrame
      title="Review this action"
      description="Kestrel pauses actions that could change something until you decide. Anything waiting here stays until you allow or reject it, even after a restart."
      measure="reading"
      className="runtime-approval-queue"
    >
      {loadState === "error" && (
        <p className="connection-error" role="alert">
          {error}{" "}
          <button
            className="button"
            type="button"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </p>
      )}
      {pending.map((item) => (
        <RuntimeApprovalCard
          key={item.execution.id}
          item={item}
          onOpen={() => onOpenSession(item.run.sessionId)}
        />
      ))}
      {approval && (
        <ApprovalCard
          approval={approval}
          onApprove={() =>
            request({ type: "approve", approvalId: approval.id })
          }
          onReject={() => request({ type: "reject", approvalId: approval.id })}
          onEdit={(emailBody) =>
            request({
              type: "edit-approval",
              approvalId: approval.id,
              emailBody,
            })
          }
        />
      )}
    </PageFrame>
  );
}

function RuntimeApprovalCard({
  item,
  onOpen,
}: {
  item: PendingToolApproval;
  onOpen(): void;
}) {
  const policy = policyGateCopy(item.execution);
  const titleId = `runtime-approval-${item.execution.id}-title`;
  return (
    <article className="runtime-approval-card" aria-labelledby={titleId}>
      <header>
        <div>
          <span className="eyebrow">
            {item.execution.riskLevel.replaceAll("_", " ")} risk · waits for
            you
          </span>
          <h2 id={titleId}>{item.execution.toolName}</h2>
        </div>
        <Status tone="needs-approval">Waiting</Status>
      </header>
      <p>{policy.reason}</p>
      <small>Model: {runRouteLabel(item.run)}</small>
      {typeof item.execution.output?.preview === "string" && (
        <pre className="approval-preview">{item.execution.output.preview}</pre>
      )}
      <div className="button-row">
        <button className="button primary" type="button" onClick={onOpen}>
          Review in task
          <Icon name="arrow" />
        </button>
      </div>
    </article>
  );
}
