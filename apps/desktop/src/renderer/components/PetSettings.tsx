import { useEffect, useMemo, useState } from "react";
import type {
  CoreResponse,
  PetActivityState,
  PetHatchCapability,
  PetHatchDraft,
  PetStatus,
} from "@kestrel/shared-types";
import { PetGallery } from "./PetGallery";
import { PetHatch } from "./PetHatch";

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

export function FloatingPet({
  status,
  activity,
  onOpen,
  onPopOut,
}: {
  status: PetStatus | null;
  activity: PetActivityState;
  onOpen(): void;
  onPopOut(): void;
}) {
  const selected = status?.configuration.selectedSlug
    ? status.installed.find(
        (pet) => pet.slug === status.configuration.selectedSlug,
      )
    : undefined;
  const [asset, setAsset] = useState("");
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setAsset("");
    if (!selected || !status?.configuration.enabled) return;
    void window.kestrel
      .request({ type: "pet-asset", slug: selected.slug })
      .then((raw) => {
        const response = raw as CoreResponse;
        if (response.ok && response.petAsset)
          setAsset(
            `data:${response.petAsset.mediaType};base64,${response.petAsset.dataBase64}`,
          );
      });
  }, [selected?.slug, status?.configuration.enabled]);
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
  if (
    !selected ||
    !status?.configuration.enabled ||
    status.configuration.poppedOut ||
    !asset
  )
    return null;
  const rows = selected.height / 208;
  const size = {
    width: 192 * status.configuration.scale,
    height: 208 * status.configuration.scale,
  };
  return (
    <button
      type="button"
      className={`floating-pet pet-${activity}`}
      title={`${selected.displayName} · ${activity}. Click for settings or shift-click to pop out.`}
      aria-label={`${selected.displayName} pet is ${activity}. Open pet settings, or shift-click to pop it out.`}
      onClick={(event) => {
        if (event.shiftKey) onPopOut();
        else onOpen();
      }}
      style={{
        ...size,
        backgroundImage: `url("${asset}")`,
        backgroundSize: `800% ${rows * 100}%`,
        backgroundPosition: `${(frame / 7) * 100}% ${(rowFor(activity, rows) / Math.max(1, rows - 1)) * 100}%`,
      }}
    />
  );
}

export function PetSettings({
  status,
  onChange,
}: {
  status: PetStatus | null;
  onChange(status: PetStatus): void;
}) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selectedAsset, setSelectedAsset] = useState("");
  const [hatchCapability, setHatchCapability] =
    useState<PetHatchCapability | null>(null);
  const [hatchDrafts, setHatchDrafts] = useState<PetHatchDraft[]>([]);
  const installedSlugs = useMemo(
    () => new Set(status?.installed.map((pet) => pet.slug) ?? []),
    [status?.installed],
  );
  const selected = status?.configuration.selectedSlug
    ? status.installed.find(
        (pet) => pet.slug === status.configuration.selectedSlug,
      )
    : undefined;
  useEffect(() => {
    setSelectedAsset("");
    if (!selected) return;
    void window.kestrel
      .request({ type: "pet-asset", slug: selected.slug })
      .then((raw) => {
        const response = raw as CoreResponse;
        if (response.ok && response.petAsset)
          setSelectedAsset(
            `data:${response.petAsset.mediaType};base64,${response.petAsset.dataBase64}`,
          );
      });
  }, [selected?.slug]);
  useEffect(() => {
    void window.kestrel.request({ type: "pet-hatch-status" }).then((raw) => {
      const response = raw as CoreResponse;
      if (!response.ok) return;
      setHatchCapability(response.petHatchCapability ?? null);
      setHatchDrafts(response.petHatchDrafts ?? []);
    });
  }, []);

  async function mutate(
    request:
      | { type: "pet-install"; slug: string; select: true; force: boolean }
      | { type: "pet-select"; slug: string }
      | {
          type: "pet-configure";
          enabled?: boolean;
          scale?: number;
          renderMode?: "auto" | "kitty" | "iterm" | "sixel" | "unicode" | "off";
        }
      | { type: "pet-remove"; slug: string },
    success: string,
  ) {
    setBusy("mutation");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request(request)) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (!response.petStatus) throw new Error("Pet status was missing.");
      onChange(response.petStatus);
      setNotice(success);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Pet operation failed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function popOut() {
    setBusy("mutation");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request({
        type: "pet-overlay-open",
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (!response.petStatus) throw new Error("Pet status was missing.");
      onChange(response.petStatus);
      setNotice("Pet moved to its own always-on-top window.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not pop out the pet.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <article className="setting-row pet-setting">
      <div>
        <strong>Activity pet</strong>
        <p>
          Adopt a cosmetic Petdex mascot that reacts to local agent activity.
          Pets never enter prompts, use tokens, or change tools and permissions.
        </p>
        {!status ? (
          <small>Loading pet settings…</small>
        ) : (
          <>
            <div className="pet-current">
              <span
                className={
                  selectedAsset
                    ? "pet-current-preview has-image"
                    : "pet-current-preview"
                }
                aria-hidden="true"
                style={
                  selectedAsset && selected
                    ? {
                        backgroundImage: `url("${selectedAsset}")`,
                        backgroundSize: `800% ${(selected.height / 208) * 100}%`,
                        backgroundPosition: "0 0",
                      }
                    : undefined
                }
              >
                {selected
                  ? selected.displayName.slice(0, 2).toUpperCase()
                  : "—"}
              </span>
              <div>
                <b>{selected?.displayName ?? "No pet adopted"}</b>
                <small>
                  {selected
                    ? `By ${selected.submittedBy} · ${selected.kind} · SHA-256 ${selected.sha256.slice(0, 12)}…`
                    : "Off by default. Browse the public approved gallery when you want one."}
                </small>
              </div>
              {selected && (
                <span className="pet-current-actions">
                  {status.configuration.enabled &&
                    !status.configuration.poppedOut && (
                      <button
                        className="button secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void popOut()}
                      >
                        Pop out
                      </button>
                    )}
                  <button
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void mutate(
                        {
                          type: "pet-configure",
                          enabled: !status.configuration.enabled,
                        },
                        status.configuration.enabled
                          ? "Pet tucked away."
                          : "Pet is active.",
                      )
                    }
                  >
                    {status.configuration.enabled ? "Turn off" : "Turn on"}
                  </button>
                </span>
              )}
            </div>
            {selected && (
              <div className="pet-controls">
                <label>
                  Pet size{" "}
                  <output>{status.configuration.scale.toFixed(2)}×</output>
                  <input
                    aria-label="Pet size"
                    type="range"
                    min="0.1"
                    max="1.25"
                    step="0.01"
                    value={Math.min(1.25, status.configuration.scale)}
                    onChange={(event) =>
                      void mutate(
                        {
                          type: "pet-configure",
                          scale: Number(event.target.value),
                        },
                        "Pet size changed.",
                      )
                    }
                  />
                </label>
                <label>
                  Terminal rendering
                  <select
                    aria-label="Terminal pet rendering"
                    value={status.configuration.renderMode}
                    onChange={(event) =>
                      void mutate(
                        {
                          type: "pet-configure",
                          renderMode: event.target
                            .value as PetStatus["configuration"]["renderMode"],
                        },
                        "Terminal pet rendering changed.",
                      )
                    }
                  >
                    <option value="auto">Automatic</option>
                    <option value="kitty">Kitty</option>
                    <option value="iterm">iTerm2</option>
                    <option value="sixel">Sixel</option>
                    <option value="unicode">Unicode</option>
                    <option value="off">Desktop only</option>
                  </select>
                </label>
              </div>
            )}
            {status.installed.length > 0 && (
              <details className="pet-installed">
                <summary>
                  {status.installed.length} installed pet
                  {status.installed.length === 1 ? "" : "s"}
                </summary>
                <ul>
                  {status.installed.map((pet) => (
                    <li key={pet.slug}>
                      <span>
                        <b>{pet.displayName}</b>
                        <small>
                          {pet.slug} · {(pet.bytes / 1_000_000).toFixed(1)} MB
                        </small>
                      </span>
                      <span>
                        {pet.slug !== status.configuration.selectedSlug && (
                          <button
                            className="quiet-link"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void mutate(
                                { type: "pet-select", slug: pet.slug },
                                `${pet.displayName} adopted.`,
                              )
                            }
                          >
                            Adopt
                          </button>
                        )}
                        <button
                          className="quiet-link"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void mutate(
                              { type: "pet-remove", slug: pet.slug },
                              `${pet.displayName} removed.`,
                            )
                          }
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert">{error}</small>}
        <PetGallery
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          mutate={mutate}
          installedSlugs={installedSlugs}
        />
        <PetHatch
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setNotice={setNotice}
          onChange={onChange}
          hatchCapability={hatchCapability}
          setHatchCapability={setHatchCapability}
          hatchDrafts={hatchDrafts}
          setHatchDrafts={setHatchDrafts}
        />
      </div>
      <span className="status">
        {selected
          ? status?.configuration.enabled
            ? status.configuration.poppedOut
              ? "Popped out"
              : "Active"
            : "Off"
          : "Optional"}
      </span>
    </article>
  );
}
