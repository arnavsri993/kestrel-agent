import type {
  ActivityItem,
  CoreResponse,
  WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageFrame } from "./ui";
import "./surface-pages.css";
import { activityItemsFromExecutions } from "../runtime-evidence";
import { runtimeToolTitle } from "./RuntimeToolMessage";

const statusLabels: Record<ActivityItem["status"], string> = {
  observed: "Observed",
  reasoned: "Reasoned",
  waiting: "Needs approval",
  verified: "Verified",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function RuntimeActivityTrail({
  snapshot,
  highlightExecutionId,
}: {
  snapshot: WorkspaceSnapshot;
  highlightExecutionId?: string | null;
}) {
  const [executions, setExecutions] = useState<ActivityItem[]>([]);
  const [error, setError] = useState("");
  const items = useMemo(() => {
    const fixtureIds = new Set(snapshot.activity.map((item) => item.id));
    return [
      ...executions.filter((item) => !fixtureIds.has(item.id)),
      ...snapshot.activity,
    ];
  }, [executions, snapshot.activity]);

  useEffect(() => {
    let cancelled = false;
    void window.kestrel
      .request({ type: "runtime-list-executions", limit: 80 })
      .then((raw) => {
        if (cancelled) return;
        const response = raw as CoreResponse;
        if (!response.ok) throw new Error(response.error);
        setExecutions(activityItemsFromExecutions(response.executions ?? []));
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load the tool audit trail.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!highlightExecutionId) return;
    const node = document.getElementById(
      `activity-item-${highlightExecutionId}`,
    );
    if (!node) return;
    const evidence = node.querySelector("details");
    if (evidence) evidence.open = true;
    node.scrollIntoView({ block: "nearest" });
    node.classList.add("activity-item-focused");
    return () => node.classList.remove("activity-item-focused");
  }, [highlightExecutionId, items]);

  return (
    <PageFrame
      title="What happened"
      description="See what Kestrel observed, checked, and prepared."
      measure="wide"
      className="runtime-activity-trail"
    >
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <EmptyState
          title="No activity yet"
          detail="Tool results will appear here with their status and supporting evidence."
        />
      ) : (
        <ol className="activity-list">
          {items.map((item, index) => (
            <li key={item.id} id={`activity-item-${item.id}`}>
              <span className={`activity-node node-${item.status}`}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <div className="activity-title">
                  <strong>{runtimeToolTitle(item.title, item.title)}</strong>
                  <time>
                    {new Date(item.timestamp).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <p className={`activity-status activity-status-${item.status}`}>
                  {statusLabels[item.status]}
                </p>
                {item.status !== "verified" && (
                  <p>
                    {item.status === "waiting" && /^Approval level \d+ is required before this action can execute\.$/.test(item.detail)
                      ? "Waiting for your approval before this action runs."
                      : item.detail}
                  </p>
                )}
                <details className="activity-evidence">
                  <summary>Details</summary>
                  <dl>
                    <dt>Action</dt>
                    <dd><code>{item.title}</code></dd>
                    <dt>Result</dt>
                    <dd>{item.detail}</dd>
                    {item.sourceIds.length > 0 && (
                      <>
                        <dt>Source references</dt>
                        <dd>
                          <ul>{item.sourceIds.map((sourceId, sourceIndex) => (
                            <li key={`${sourceIndex}:${sourceId}`}><code>{sourceId}</code></li>
                          ))}</ul>
                        </dd>
                      </>
                    )}
                  </dl>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}
