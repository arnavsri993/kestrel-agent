import { useEffect, useMemo, useState } from "react";
import type {
  CoreResponse,
  PetActivityState,
  PetGalleryEntry,
  PetHatchCapability,
  PetHatchDraft,
  PetStatus,
} from "@kestrel/shared-types";

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

function petSlug(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "my-pet"
  );
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
  const [query, setQuery] = useState("");
  const [gallery, setGallery] = useState<PetGalleryEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selectedAsset, setSelectedAsset] = useState("");
  const [hatchCapability, setHatchCapability] =
    useState<PetHatchCapability | null>(null);
  const [hatchDrafts, setHatchDrafts] = useState<PetHatchDraft[]>([]);
  const [hatchConcept, setHatchConcept] = useState("");
  const [hatchStyle, setHatchStyle] = useState("auto");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [hatchName, setHatchName] = useState("");
  const [hatchSlug, setHatchSlug] = useState("");
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

  async function loadGallery(search = query) {
    setBusy("gallery");
    setError("");
    try {
      const response = (await window.kestrel.request({
        type: "pet-gallery",
        query: search,
        limit: 24,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      setGallery(response.petGallery ?? []);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reach the Petdex gallery.",
      );
    } finally {
      setBusy("");
    }
  }

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

  async function generateDrafts() {
    if (!hatchConcept.trim() || busy) return;
    setBusy("hatch-drafts");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request({
        type: "pet-hatch-drafts",
        concept: hatchConcept.trim(),
        style: hatchStyle,
        count: 4,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      const drafts = response.petHatchDrafts ?? [];
      if (drafts.length === 0)
        throw new Error("The image provider returned no usable drafts.");
      setHatchCapability(response.petHatchCapability ?? hatchCapability);
      setHatchDrafts(drafts);
      setSelectedDraftId(drafts[0]!.id);
      if (!hatchName) setHatchName(hatchConcept.trim().slice(0, 120));
      if (!hatchSlug) setHatchSlug(petSlug(hatchConcept));
      setNotice(
        `${drafts.length} base look${drafts.length === 1 ? "" : "s"} ready. Pick one before the reference-grounded hatch.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not generate pet drafts.",
      );
    } finally {
      setBusy("");
    }
  }

  async function hatchSelected() {
    if (!selectedDraftId || !hatchName.trim() || !hatchSlug.trim() || busy)
      return;
    setBusy("hatch-complete");
    setError("");
    setNotice("");
    try {
      const response = (await window.kestrel.request({
        type: "pet-hatch-complete",
        draftId: selectedDraftId,
        slug: petSlug(hatchSlug),
        displayName: hatchName.trim(),
        description: hatchConcept.trim(),
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      if (!response.petStatus || !response.petHatchResult)
        throw new Error("Hatch result was incomplete.");
      onChange(response.petStatus);
      setNotice(
        `${response.petHatchResult.displayName} hatched with ${response.petHatchResult.states.length} verified animation rows and is now active.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not complete the pet hatch.",
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
        <details className="pet-gallery">
          <summary
            onClick={() => {
              if (gallery.length === 0 && !busy) void loadGallery("");
            }}
          >
            Browse approved Petdex gallery
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void loadGallery();
            }}
          >
            <label className="sr-only" htmlFor="pet-search">
              Search pets
            </label>
            <input
              id="pet-search"
              value={query}
              placeholder="Search by pet, kind, or creator"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="button secondary" disabled={Boolean(busy)}>
              {busy === "gallery" ? "Searching…" : "Search"}
            </button>
          </form>
          {gallery.length === 0 && busy !== "gallery" ? (
            <small>Open the gallery or search for a mascot.</small>
          ) : (
            <ul>
              {gallery.map((pet) => (
                <li key={pet.slug}>
                  <span className="pet-monogram" aria-hidden="true">
                    {pet.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <b>{pet.displayName}</b>
                    <small>
                      {pet.kind} · by {pet.submittedBy}
                    </small>
                  </span>
                  <button
                    className="button secondary"
                    disabled={Boolean(busy) || installedSlugs.has(pet.slug)}
                    onClick={() =>
                      void mutate(
                        installedSlugs.has(pet.slug)
                          ? { type: "pet-select", slug: pet.slug }
                          : {
                              type: "pet-install",
                              slug: pet.slug,
                              select: true,
                              force: false,
                            },
                        `${pet.displayName} installed and adopted.`,
                      )
                    }
                  >
                    {installedSlugs.has(pet.slug) ? "Installed" : "Install"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <small>
            Community assets remain owned by their submitters. Kestrel
            downloads only after you choose Install.
          </small>
        </details>
        <details className="pet-hatch">
          <summary>Hatch an original pet with AI</summary>
          <p>
            Generate up to four low-quality base looks, choose one, then make
            eight reference-grounded animation strips. Kestrel assembles and
            verifies the final 8×9 atlas locally. Your image provider’s pricing
            applies.
          </p>
          {!hatchCapability ? (
            <small>Checking for a reference-image provider…</small>
          ) : !hatchCapability.available ? (
            <div className="pet-hatch-unavailable">
              <small>{hatchCapability.reason}</small>
              <small>
                Use the Connections page to add the provider, then return here.
              </small>
            </div>
          ) : (
            <>
              <div className="pet-hatch-inputs">
                <label>
                  Pet concept
                  <textarea
                    value={hatchConcept}
                    maxLength={500}
                    placeholder="A tiny midnight-blue kestrel made of folded paper"
                    onChange={(event) => setHatchConcept(event.target.value)}
                  />
                </label>
                <label>
                  Style
                  <select
                    value={hatchStyle}
                    onChange={(event) => setHatchStyle(event.target.value)}
                  >
                    <option value="auto">16-bit pixel art</option>
                    <option value="plush">Plush</option>
                    <option value="clay">Clay</option>
                    <option value="sticker">Sticker</option>
                    <option value="flat-vector">Flat vector</option>
                  </select>
                </label>
                <button
                  className="button secondary"
                  type="button"
                  disabled={Boolean(busy) || !hatchConcept.trim()}
                  onClick={() => void generateDrafts()}
                >
                  {busy === "hatch-drafts"
                    ? "Drawing drafts…"
                    : hatchDrafts.length
                      ? "Remix four drafts"
                      : "Generate four drafts"}
                </button>
              </div>
              {hatchDrafts.length > 0 && (
                <>
                  <div
                    className="pet-draft-grid"
                    role="radiogroup"
                    aria-label="Choose a base pet look"
                  >
                    {hatchDrafts.map((draft, index) => (
                      <button
                        key={draft.id}
                        type="button"
                        role="radio"
                        aria-checked={selectedDraftId === draft.id}
                        className={
                          selectedDraftId === draft.id ? "selected" : ""
                        }
                        onClick={() => setSelectedDraftId(draft.id)}
                      >
                        <img
                          src={`data:${draft.mediaType};base64,${draft.dataBase64}`}
                          alt={`Generated pet base look ${index + 1}`}
                        />
                        <span>Draft {index + 1}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pet-hatch-metadata">
                    <label>
                      Pet name
                      <input
                        value={hatchName}
                        maxLength={120}
                        onChange={(event) => {
                          setHatchName(event.target.value);
                          if (!hatchSlug || hatchSlug === petSlug(hatchName))
                            setHatchSlug(petSlug(event.target.value));
                        }}
                      />
                    </label>
                    <label>
                      Local slug
                      <input
                        value={hatchSlug}
                        maxLength={80}
                        onChange={(event) =>
                          setHatchSlug(petSlug(event.target.value))
                        }
                      />
                    </label>
                    <button
                      className="button primary"
                      type="button"
                      disabled={
                        Boolean(busy) ||
                        !selectedDraftId ||
                        !hatchName.trim() ||
                        !hatchSlug.trim()
                      }
                      onClick={() => void hatchSelected()}
                    >
                      {busy === "hatch-complete"
                        ? "Hatching 8 grounded rows…"
                        : "Hatch selected pet"}
                    </button>
                  </div>
                  <small>
                    The hatch can take several minutes. It retries malformed
                    rows, mirrors the left walk deterministically, requires at
                    least six usable states, and installs only a digest-verified
                    atlas.
                  </small>
                </>
              )}
              <small>
                Provider: {hatchCapability.providerId}
                {hatchCapability.model ? ` · ${hatchCapability.model}` : ""}.
                Reference images stay inside the configured generation request
                and are not added to chat.
              </small>
            </>
          )}
        </details>
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
