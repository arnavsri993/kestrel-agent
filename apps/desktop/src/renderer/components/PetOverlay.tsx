import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CoreResponse,
  PetActivityState,
  PetStatus,
} from "@kestrel/shared-types";

const speech: Record<PetActivityState, string> = {
  idle: "ready",
  wave: "done",
  run: "working…",
  failed: "needs attention",
  review: "thinking…",
  jump: "finished!",
  waiting: "your turn",
};

function rowFor(state: PetActivityState, rows: number): number {
  return (
    {
      idle: 0,
      wave: 3,
      run: 7,
      failed: 5,
      review: rows >= 9 ? 8 : 0,
      jump: 4,
      waiting: rows >= 9 ? 6 : 0,
    } as Record<PetActivityState, number>
  )[state];
}

export function PetOverlay() {
  const [status, setStatus] = useState<PetStatus | null>(null);
  const [asset, setAsset] = useState("");
  const [activity, setActivity] = useState<PetActivityState>("idle");
  const [frame, setFrame] = useState(0);
  const [composer, setComposer] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [unread, setUnread] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const clickTimer = useRef<number | null>(null);
  const selected = status?.configuration.selectedSlug
    ? status.installed.find(
        (pet) => pet.slug === status.configuration.selectedSlug,
      )
    : undefined;

  useEffect(() => {
    void window.kestrel.request({ type: "pet-get" }).then((raw) => {
      const response = raw as CoreResponse;
      if (response.ok && response.petStatus) setStatus(response.petStatus);
    });
    const unsubscribeRuntime = window.kestrel.onRuntimeEvent((event) => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      if (event.type === "tool.started" || event.type === "tool.progress")
        setActivity("run");
      else if (event.type === "tool.completed")
        setActivity(
          ["failed", "blocked", "cancelled"].includes(
            String(event.payload.status ?? ""),
          )
            ? "failed"
            : /goal|task/.test(String(event.payload.toolName ?? ""))
              ? "jump"
              : "review",
        );
      else if (event.type === "message.appended") {
        setActivity(event.payload.role === "assistant" ? "wave" : "review");
        if (event.payload.role === "assistant") setUnread(true);
      }
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null;
        setActivity("idle");
      }, 2_200);
    });
    const unsubscribeStatus = window.kestrel.onPetStatus(setStatus);
    return () => {
      unsubscribeRuntime();
      unsubscribeStatus();
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    setAsset("");
    if (!selected) return;
    void window.kestrel
      .request({ type: "pet-asset", slug: selected.slug })
      .then((raw) => {
        const response = raw as CoreResponse;
        if (response.ok && response.petAsset)
          setAsset(
            `data:${response.petAsset.mediaType};base64,${response.petAsset.dataBase64}`,
          );
      });
  }, [selected?.slug]);

  useEffect(() => {
    setFrame(0);
    if (!asset || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const timer = window.setInterval(
      () => setFrame((value) => (value + 1) % 8),
      activity === "run" ? 110 : 170,
    );
    return () => window.clearInterval(timer);
  }, [activity, asset]);

  async function closeOverlay() {
    await window.kestrel.request({ type: "pet-overlay-close" });
  }

  async function toggleMain() {
    setUnread(false);
    await window.kestrel.request({ type: "pet-overlay-toggle-main" });
  }

  function handleSpriteClick(shiftKey: boolean) {
    if (shiftKey) {
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
      void closeOverlay();
      return;
    }
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      setComposer(true);
    }, 210);
  }

  function handleSpriteDoubleClick() {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    void toggleMain();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || sending) return;
    setSending(true);
    setMessage("");
    try {
      const sessions = (await window.kestrel.request({
        type: "runtime-list-sessions",
      })) as CoreResponse;
      if (!sessions.ok) throw new Error(sessions.error);
      let session = [...(sessions.sessions ?? [])].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0];
      if (!session) {
        const created = (await window.kestrel.request({
          type: "runtime-create-session",
          title: "Pet quick task",
        })) as CoreResponse;
        if (!created.ok || !created.session)
          throw new Error(
            created.ok ? "Could not create a task." : created.error,
          );
        session = created.session;
      }
      setActivity("review");
      const response = (await window.kestrel.request({
        type: "runtime-run-agent",
        sessionId: session.id,
        message: prompt.trim(),
        model: "auto",
        providerIds: ["auto"],
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      setPrompt("");
      setComposer(false);
      setActivity(
        response.run?.status === "waiting_approval" ? "waiting" : "wave",
      );
      setMessage(
        response.run?.status === "waiting_approval"
          ? "Approval needed in Kestrel."
          : "Sent.",
      );
    } catch (cause) {
      setActivity("failed");
      setMessage(
        cause instanceof Error ? cause.message : "Could not send the task.",
      );
    } finally {
      setSending(false);
    }
  }

  if (!selected || !asset)
    return (
      <main className="pet-overlay-shell">
        <div className="pet-overlay-handle" />
        <p>Loading pet…</p>
      </main>
    );
  const rows = selected.height / 208;
  const scale = status?.configuration.scale ?? 0.33;
  return (
    <main className="pet-overlay-shell">
      <div className="pet-overlay-handle" title="Drag pet window">
        <span />
      </div>
      <span className="pet-speech" role="status">
        {speech[activity]}
      </span>
      <button
        type="button"
        className="pet-overlay-sprite"
        aria-label={`${selected.displayName} is ${activity}. Click for a quick task, double-click for Kestrel, or shift-click to return it.`}
        onClick={(event) => handleSpriteClick(event.shiftKey)}
        onDoubleClick={handleSpriteDoubleClick}
        style={{
          width: 192 * scale,
          height: 208 * scale,
          backgroundImage: `url("${asset}")`,
          backgroundSize: `800% ${rows * 100}%`,
          backgroundPosition: `${(frame / 7) * 100}% ${(rowFor(activity, rows) / Math.max(1, rows - 1)) * 100}%`,
        }}
      />
      {unread && (
        <button
          className="pet-mail"
          aria-label="Open completed task in Kestrel"
          onClick={() => void toggleMain()}
        >
          ↗
        </button>
      )}
      {composer && (
        <form
          className="pet-mini-composer"
          onSubmit={(event) => void submit(event)}
        >
          <label className="sr-only" htmlFor="pet-prompt">
            Quick task
          </label>
          <textarea
            id="pet-prompt"
            autoFocus
            value={prompt}
            placeholder="Ask Kestrel…"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div>
            <button type="button" onClick={() => setComposer(false)}>
              Cancel
            </button>
            <button disabled={sending || !prompt.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
      {message && <span className="pet-overlay-message">{message}</span>}
    </main>
  );
}
