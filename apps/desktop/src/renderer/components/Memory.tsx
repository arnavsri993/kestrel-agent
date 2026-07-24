import { useEffect, useMemo, useState } from "react";
import type { CoreResponse, MemoryRecord, RendererRequest, RuntimeMessage, UserModelFact, WorkspaceSnapshot } from "@kestrel/shared-types";
import { PageFrame } from "./PageFrame";
import { DreamingPanel } from "./DreamingPanel";

export function Memory({
  snapshot,
  update,
}: {
  snapshot: WorkspaceSnapshot;
  update(next: WorkspaceSnapshot): void;
}) {
  const [filter, setFilter] = useState<MemoryRecord["type"] | "all">("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [facts, setFacts] = useState<UserModelFact[]>([]);
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<MemoryRecord["type"]>("semantic");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RuntimeMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const grouped = useMemo(
    () =>
      snapshot.memories.reduce<Record<string, MemoryRecord[]>>(
        (groups, item) => {
          (groups[item.type] ??= []).push(item);
          return groups;
        },
        {},
      ),
    [snapshot.memories],
  );
  const visible =
    filter === "all" ? snapshot.memories : (grouped[filter] ?? []);

  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        snapshot.memories.map((memory) => [memory.id, memory.content]),
      ),
    );
  }, [snapshot.memories]);

  async function loadFacts() {
    const response = (await window.kestrel.request({
      type: "memory-user-model-list",
    })) as CoreResponse;
    if (!response.ok) throw new Error(response.error);
    setFacts(response.userModelFacts ?? []);
  }

  useEffect(() => {
    void loadFacts().catch((cause) =>
      setMemoryError(
        cause instanceof Error
          ? cause.message
          : "Could not load the user model.",
      ),
    );
  }, []);

  async function refreshSnapshot() {
    const response = (await window.kestrel.request({
      type: "snapshot",
    })) as CoreResponse;
    if (!response.ok || !response.snapshot)
      throw new Error(response.ok ? "Memory refresh failed." : response.error);
    update(response.snapshot);
  }

  async function mutate(request: RendererRequest) {
    setBusy(true);
    setMemoryError("");
    try {
      const response = (await window.kestrel.request(request)) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      await refreshSnapshot();
    } catch (cause) {
      setMemoryError(
        cause instanceof Error ? cause.message : "Memory update failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reviewFact(id: string, decision: "confirm" | "reject") {
    setBusy(true);
    setMemoryError("");
    try {
      const response = (await window.kestrel.request({
        type: "memory-user-model-review",
        id,
        decision,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      await loadFacts();
    } catch (cause) {
      setMemoryError(
        cause instanceof Error ? cause.message : "User-model review failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function searchTranscripts() {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setBusy(true);
    setMemoryError("");
    try {
      const response = (await window.kestrel.request({
        type: "runtime-search-messages",
        query,
        limit: 30,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      setSearchResults(response.messages ?? []);
    } catch (cause) {
      setMemoryError(
        cause instanceof Error ? cause.message : "Transcript search failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      eyebrow="Local memory"
      title="What Kestrel knows."
      text="Inspect provenance, correct or forget durable memories, review proposed user facts, and search encrypted task history."
    >
      <form
        className="memory-create"
        onSubmit={(event) => {
          event.preventDefault();
          const content = newContent.trim();
          if (!content) return;
          void mutate({
            type: "memory-remember",
            memoryType: newType,
            content,
            sensitivity: "personal",
            sourceId: "desktop-user",
          }).then(() => setNewContent(""));
        }}
      >
        <label>
          New confirmed memory
          <textarea
            value={newContent}
            onChange={(event) => setNewContent(event.target.value)}
            rows={2}
            placeholder="Store something with explicit provenance…"
          />
        </label>
        <select
          aria-label="Memory type"
          value={newType}
          onChange={(event) =>
            setNewType(event.target.value as MemoryRecord["type"])
          }
        >
          {[
            "semantic",
            "episodic",
            "procedural",
            "project",
            "relationship",
          ].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <button
          className="button primary"
          disabled={busy || !newContent.trim()}
        >
          Remember
        </button>
      </form>
      <form
        className="memory-search"
        onSubmit={(event) => {
          event.preventDefault();
          void searchTranscripts();
        }}
      >
        <input
          aria-label="Search task history"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search across encrypted task history"
        />
        <button
          className="button secondary"
          disabled={busy || !searchQuery.trim()}
        >
          Search history
        </button>
      </form>
      {searchResults.length > 0 && (
        <section
          className="memory-search-results"
          aria-label="Task history results"
        >
          {searchResults.map((message) => (
            <article key={message.id}>
              <span className="eyebrow">
                {message.role} · session {message.sessionId.slice(-8)}
              </span>
              <p>{message.content}</p>
            </article>
          ))}
        </section>
      )}
      <DreamingPanel
        memories={snapshot.memories}
        onMemoryChanged={refreshSnapshot}
      />
      <div className="memory-layout">
        <aside className="memory-filters">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            <span>All</span>
            <strong>{snapshot.memories.length}</strong>
          </button>
          {Object.entries(grouped).map(([key, items]) => (
            <button
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key as MemoryRecord["type"])}
              key={key}
            >
              <span>{key}</span>
              <strong>{items.length}</strong>
            </button>
          ))}
        </aside>
        <section className="memory-list">
          {visible.map((item) => (
            <article key={item.id}>
              <div>
                <span className="eyebrow">
                  {item.type} · {item.userConfirmed ? "confirmed" : "inferred"}{" "}
                  · {item.sensitivity}
                </span>
                <textarea
                  aria-label={`Edit ${item.type} memory`}
                  value={drafts[item.id] ?? item.content}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                  rows={2}
                />
                <details>
                  <summary>Provenance</summary>
                  <small>
                    {item.sourceType} · {item.sourceIds.join(" · ")}
                  </small>
                </details>
              </div>
              <div className="memory-actions">
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    !(drafts[item.id] ?? "").trim() ||
                    drafts[item.id] === item.content
                  }
                  onClick={() =>
                    void mutate({
                      type: "memory-correct",
                      id: item.id,
                      content: drafts[item.id]!,
                      memoryType: item.type,
                      sensitivity: item.sensitivity,
                    })
                  }
                >
                  Save correction
                </button>
                <button
                  className="quiet-link"
                  disabled={busy}
                  onClick={() =>
                    void mutate({ type: "memory-forget", id: item.id })
                  }
                >
                  Forget
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
      <section className="user-model-review">
        <h2>Proposed user model</h2>
        {facts.filter((fact) => fact.status === "proposed").length === 0 ? (
          <p>No facts are waiting for review.</p>
        ) : (
          facts
            .filter((fact) => fact.status === "proposed")
            .map((fact) => (
              <article key={fact.id}>
                <div>
                  <span className="eyebrow">
                    {fact.kind}.{fact.key} · {fact.sensitivity}
                  </span>
                  <p>{fact.value}</p>
                  <small>Sources · {fact.sourceIds.join(" · ")}</small>
                </div>
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void reviewFact(fact.id, "confirm")}
                  >
                    Confirm
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void reviewFact(fact.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))
        )}
      </section>
      {memoryError && (
        <p className="connection-error" role="alert">
          {memoryError}
        </p>
      )}
    </PageFrame>
  );
}
