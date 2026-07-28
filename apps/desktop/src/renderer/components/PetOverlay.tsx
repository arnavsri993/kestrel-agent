import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CoreResponse,
  PetActivityState,
  PetStatus,
} from "@kestrel/shared-types";
import { petTaskSessionRequest } from "../pet-task";

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

function usePetRuntimeState() {
  const [status, setStatus] = useState<PetStatus | null>(null);
  const [activity, setActivity] = useState<PetActivityState>("idle");
  const [unread, setUnread] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    void window.kestrel.request({ type: "pet-get" }).then((raw) => {
      const response = raw as CoreResponse;
      if (response.ok && response.petStatus) setStatus(response.petStatus);
    });
    const unsubscribeActivity = window.kestrel.onPetActivity((nextActivity) => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      setActivity(nextActivity);
      if (nextActivity === "wave") setUnread(true);
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null;
        setActivity("idle");
      }, 2_200);
    });
    const unsubscribeStatus = window.kestrel.onPetStatus(setStatus);
    return () => {
      unsubscribeActivity();
      unsubscribeStatus();
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, []);

  return { status, activity, setActivity, unread, setUnread };
}

function usePetAsset(selectedSlug: string | undefined) {
  const [asset, setAsset] = useState("");

  useEffect(() => {
    setAsset("");
    if (!selectedSlug) return;
    void window.kestrel
      .request({ type: "pet-asset", slug: selectedSlug })
      .then((raw) => {
        const response = raw as CoreResponse;
        if (response.ok && response.petAsset)
          setAsset(
            `data:${response.petAsset.mediaType};base64,${response.petAsset.dataBase64}`,
          );
      });
  }, [selectedSlug]);

  return asset;
}

function usePetAnimation(activity: PetActivityState, asset: string) {
  const [frame, setFrame] = useState(0);

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

  return frame;
}

function usePetInteraction(
  setUnread: (unread: boolean) => void,
  setActivity: (activity: PetActivityState) => void
) {
  const [composer, setComposer] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const clickTimer = useRef<number | null>(null);
  const spriteRef = useRef<HTMLButtonElement | null>(null);
  const activeStreamId = useRef<string | null>(null);
  const cancelRequested = useRef(false);

  useEffect(() => {
    return () => {
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
      const streamId = activeStreamId.current;
      if (streamId)
        void window.kestrel.request({
          type: "runtime-cancel-stream",
          streamId,
        }).catch(() => undefined);
    };
  }, []);

  async function closeOverlay() {
    await cancelTask();
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

  async function cancelTask() {
    cancelRequested.current = true;
    const streamId = activeStreamId.current;
    activeStreamId.current = null;
    setComposer(false);
    window.setTimeout(() => spriteRef.current?.focus(), 0);
    if (!streamId) {
      if (sending) {
        setActivity("idle");
        setMessage("Cancelled.");
      }
      return;
    }
    setMessage("Cancelling…");
    try {
      const response = (await window.kestrel.request({
        type: "runtime-cancel-stream",
        streamId,
      })) as CoreResponse;
      setActivity(response.ok ? "idle" : "failed");
      setMessage(response.ok ? "Cancelled." : response.error);
    } catch (cause) {
      setActivity("failed");
      setMessage(
        cause instanceof Error ? cause.message : "Could not cancel the task.",
      );
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || sending) return;
    setSending(true);
    setMessage("");
    cancelRequested.current = false;
    let submittedStreamId: string | null = null;
    try {
      const task = prompt.trim();
      // A pet task must never inherit the workspace or tool scope from an
      // unrelated recent chat. Give every quick task an explicit, visible,
      // workspace-free session that can be reviewed from the main window.
      const created = (await window.kestrel.request(
        petTaskSessionRequest(task),
      )) as CoreResponse;
      if (!created.ok || !created.session)
        throw new Error(
          created.ok ? "Could not create a task." : created.error,
        );
      if (cancelRequested.current) return;
      const session = created.session;
      setActivity("review");
      const streamId = `pet-${crypto.randomUUID()}`;
      submittedStreamId = streamId;
      activeStreamId.current = streamId;
      const response = (await window.kestrel.request({
        type: "runtime-run-agent",
        sessionId: session.id,
        message: task,
        model: "auto",
        providerIds: ["auto"],
        streamId,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      setPrompt("");
      setComposer(false);
      window.setTimeout(() => spriteRef.current?.focus(), 0);
      setActivity(
        response.run?.status === "waiting_approval" ? "waiting" : "wave",
      );
      setMessage(
        response.run?.status === "waiting_approval"
          ? "Approval needed in Kestrel."
          : "Sent.",
      );
    } catch (cause) {
      if (
        !submittedStreamId ||
        activeStreamId.current === submittedStreamId
      ) {
        setActivity("failed");
        setMessage(
          cause instanceof Error ? cause.message : "Could not send the task.",
        );
      }
    } finally {
      if (
        !submittedStreamId ||
        activeStreamId.current === submittedStreamId
      )
        activeStreamId.current = null;
      cancelRequested.current = false;
      setSending(false);
    }
  }

  return {
    composer,
    spriteRef,
    prompt,
    setPrompt,
    sending,
    message,
    cancelTask,
    handleSpriteClick,
    handleSpriteDoubleClick,
    submit,
    toggleMain,
  };
}

export function PetOverlay() {
  const { status, activity, setActivity, unread, setUnread } = usePetRuntimeState();
  const selectedSlug = status?.configuration.selectedSlug;
  const selected = selectedSlug
    ? status.installed.find((pet) => pet.slug === selectedSlug)
    : undefined;

  const asset = usePetAsset(selectedSlug);
  const frame = usePetAnimation(activity, asset);

  const {
    composer,
    spriteRef,
    prompt,
    setPrompt,
    sending,
    message,
    cancelTask,
    handleSpriteClick,
    handleSpriteDoubleClick,
    submit,
    toggleMain,
  } = usePetInteraction(setUnread, setActivity);

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
        ref={spriteRef}
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
          aria-label="Open Kestrel"
          onClick={() => void toggleMain()}
        >
          ↗
        </button>
      )}
      {composer && (
        <form
          className="pet-mini-composer"
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            void cancelTask();
          }}
        >
          <label className="sr-only" htmlFor="pet-prompt">
            Quick task
          </label>
          <textarea
            id="pet-prompt"
            autoFocus
            maxLength={10_000}
            value={prompt}
            placeholder="Ask Kestrel…"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div>
            <button type="button" onClick={() => void cancelTask()}>
              Cancel
            </button>
            <button disabled={sending || !prompt.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
      {message && (
        <span
          className="pet-overlay-message"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {message}
        </span>
      )}
    </main>
  );
}
