import { useState } from "react";
import type {
  CoreResponse,
  PetHatchCapability,
  PetHatchDraft,
  PetStatus,
} from "@kestrel/shared-types";

// This is the exported utility function that was previously only available in PetSettings.tsx
export function petSlug(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "my-pet"
  );
}

export function PetHatch({
  busy,
  setBusy,
  setError,
  setNotice,
  onChange,
  hatchCapability,
  setHatchCapability,
  hatchDrafts,
  setHatchDrafts,
}: {
  busy: string;
  setBusy: (busy: string) => void;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
  onChange: (status: PetStatus) => void;
  hatchCapability: PetHatchCapability | null;
  setHatchCapability: (capability: PetHatchCapability | null) => void;
  hatchDrafts: PetHatchDraft[];
  setHatchDrafts: (drafts: PetHatchDraft[]) => void;
}) {
  const [hatchConcept, setHatchConcept] = useState("");
  const [hatchStyle, setHatchStyle] = useState("auto");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [hatchName, setHatchName] = useState("");
  const [hatchSlug, setHatchSlug] = useState("");

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
  );
}
