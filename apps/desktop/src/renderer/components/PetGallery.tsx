import { useState } from "react";
import type { CoreResponse, PetGalleryEntry } from "@kestrel/shared-types";

export function PetGallery({
  busy,
  setBusy,
  setError,
  mutate,
  installedSlugs,
}: {
  busy: string;
  setBusy: (busy: string) => void;
  setError: (error: string) => void;
  mutate: (
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
  ) => Promise<void>;
  installedSlugs: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [gallery, setGallery] = useState<PetGalleryEntry[]>([]);

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

  return (
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
  );
}
