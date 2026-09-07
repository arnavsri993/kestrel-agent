import type {
  CoreResponse,
  ModelRoutingDecision,
  ProviderAccountSummary,
  RendererRequest,
  WritingAdaptationStrength,
  WritingContextPreview,
  WritingGenre,
  WritingProfileConfig,
  WritingProfileStatus,
  WritingResult,
} from "@kestrel/shared-types";
import { type FormEvent, useEffect, useState } from "react";
import { Icon } from "../Icon";
import { PageFrame } from "../ui";
import { ModelSelector } from "./ModelSelector";
import {
  accountForChoice,
  type ModelSelectorChoice,
} from "./model-selector";
import "./surface-pages.css";
import { writingProfilePanelPhase } from "./writing-studio-state";

type SuccessfulCoreResponse = Extract<CoreResponse, { ok: true }>;

async function request(
  input: RendererRequest,
): Promise<SuccessfulCoreResponse> {
  const response = (await window.kestrel.request(input)) as CoreResponse;
  if (!response.ok) throw new Error(response.error);
  return response;
}

const genres: Array<{ id: WritingGenre; label: string }> = [
  { id: "email", label: "Email" },
  { id: "message", label: "Message" },
  { id: "professional", label: "Professional" },
  { id: "general", label: "General" },
  { id: "marketing", label: "Marketing" },
  { id: "academic", label: "Academic" },
  { id: "social", label: "Social" },
];

const adaptationStrengths: Array<{
  id: WritingAdaptationStrength;
  label: string;
  detail: string;
}> = [
  { id: "light", label: "Light", detail: "Keep your wording close" },
  { id: "balanced", label: "Balanced", detail: "Blend clarity and voice" },
  { id: "strong", label: "Strong", detail: "Use more learned tendencies" },
];

function routeLabel(route: ModelRoutingDecision): string {
  if (route.taskId.includes("reviewer")) return "Independent review";
  if (route.taskId.includes("repair")) return "Fidelity repair";
  return "Draft generation";
}

function contextCategoryLabel(category: string): string {
  return category
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function catalogNeedsRefresh(
  accounts: readonly ProviderAccountSummary[],
): boolean {
  return accounts.some(
    (account) =>
      account.enabled &&
      (account.discovery.state === "idle" || account.discovery.state === "stale"),
  );
}

function formatQualityStatus(result: WritingResult): string {
  return result.quality.status === "passed"
    ? "Fidelity checks passed"
    : "Review recommended";
}

export function WritingStudio() {
  const [recipient, setRecipient] = useState("");
  const [purpose, setPurpose] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [genre, setGenre] = useState<WritingGenre>("email");
  const [tone, setTone] = useState("");
  const [adaptationStrength, setAdaptationStrength] =
    useState<WritingAdaptationStrength>("balanced");
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const [modelChoice, setModelChoice] = useState<ModelSelectorChoice>(() => {
    const accountId = localStorage.getItem("kestrel:provider-account-id");
    const storedReasoningEffort = localStorage.getItem(
      "kestrel:reasoning-effort",
    );
    return {
      executionMode:
        localStorage.getItem("kestrel:execution-mode") === "manual"
          ? "manual"
          : "automatic",
      providerId: localStorage.getItem("kestrel:provider-id") ?? "",
      ...(accountId ? { accountId } : {}),
      model: localStorage.getItem("kestrel:model") ?? "auto",
      reasoningEffort:
        storedReasoningEffort === "low" ||
        storedReasoningEffort === "medium" ||
        storedReasoningEffort === "high" ||
        storedReasoningEffort === "xhigh" ||
        storedReasoningEffort === "max" ||
        storedReasoningEffort === "none"
          ? storedReasoningEffort
          : "none",
    };
  });

  const [profile, setProfile] = useState<WritingProfileStatus | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [providerAccounts, setProviderAccounts] = useState<
    ProviderAccountSummary[]
  >([]);
  const [providerAccountsLoaded, setProviderAccountsLoaded] = useState(false);
  const [sampleText, setSampleText] = useState("");
  const [sampleConsent, setSampleConsent] = useState(false);
  const [useAsExemplar, setUseAsExemplar] = useState(false);
  const [context, setContext] = useState<WritingContextPreview | null>(null);
  const [draft, setDraft] = useState<WritingResult | null>(null);
  const [routes, setRoutes] = useState<ModelRoutingDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");

  const selectedManualAccount = accountForChoice(providerAccounts, modelChoice);
  const manualRouteReady = Boolean(
    providerAccountsLoaded && selectedManualAccount && modelChoice.model.trim(),
  );
  const writingRoutingReady =
    modelChoice.executionMode === "automatic" || manualRouteReady;
  const writingRouting =
    modelChoice.executionMode === "automatic"
      ? { providerIds: ["auto"] }
      : {
          providerIds: [modelChoice.providerId],
          providerModels: {
            [modelChoice.providerId]: modelChoice.model.trim(),
          },
          writerModel: modelChoice.model.trim(),
          reviewerModel: modelChoice.model.trim(),
        };

  useEffect(() => {
    let active = true;
    setProfileLoading(true);
    void request({ type: "writing-profile-get" })
      .then((response) => {
        if (active && response.writingProfile)
          setProfile(response.writingProfile);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load the writing profile.",
          );
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    void request({ type: "runtime-list-providers" })
      .then((response) => {
        if (!active) return;
        if ("providerAccounts" in response) {
          setProviderAccounts(response.providerAccounts ?? []);
          setProviderAccountsLoaded(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!providerAccountsLoaded) return;
    setModelChoice((current) => {
      if (current.executionMode === "automatic") return current;
      const account = accountForChoice(providerAccounts, current);
      if (!account) return current;
      return {
        ...current,
        providerId: account.endpointId,
        accountId: account.id,
      };
    });
  }, [providerAccounts, providerAccountsLoaded]);

  useEffect(() => {
    if (!providerAccountsLoaded || !catalogNeedsRefresh(providerAccounts))
      return;
    let active = true;
    void request({ type: "runtime-refresh-provider-models" })
      .then((response) => {
        if (active && response.providerAccounts)
          setProviderAccounts(response.providerAccounts);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [providerAccounts, providerAccountsLoaded]);

  useEffect(() => {
    localStorage.setItem("kestrel:execution-mode", modelChoice.executionMode);
    if (modelChoice.providerId)
      localStorage.setItem("kestrel:provider-id", modelChoice.providerId);
    if (modelChoice.accountId)
      localStorage.setItem(
        "kestrel:provider-account-id",
        modelChoice.accountId,
      );
    else localStorage.removeItem("kestrel:provider-account-id");
    if (modelChoice.model.trim())
      localStorage.setItem("kestrel:model", modelChoice.model.trim());
    localStorage.setItem(
      "kestrel:reasoning-effort",
      modelChoice.reasoningEffort,
    );
  }, [modelChoice]);

  useEffect(() => {
    const trimmedPurpose = purpose.trim();
    if (!trimmedPurpose) {
      setContext(null);
      setPreviewError("");
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      setPreviewError("");
      void request({
        type: "writing-context-preview",
        ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
        purpose: trimmedPurpose,
        genre,
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        includeSensitive,
      })
        .then((response) => {
          if (active && response.writingContextPreview)
            setContext(response.writingContextPreview);
        })
        .catch((cause) => {
          if (active)
            setPreviewError(
              cause instanceof Error
                ? cause.message
                : "Could not preview the selected context.",
            );
        })
        .finally(() => {
          if (active) setPreviewBusy(false);
        });
    }, 240);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [genre, includeSensitive, purpose, recipient, tone]);

  async function configureProfile(next: Partial<WritingProfileConfig>) {
    if (!profile) return;
    setProfileBusy(true);
    setError("");
    try {
      const response = await request({
        type: "writing-profile-configure",
        config: { ...profile.config, ...next },
      });
      if (response.writingProfile) setProfile(response.writingProfile);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the writing profile.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function addSample(event: FormEvent) {
    event.preventDefault();
    if (!sampleText.trim() || !sampleConsent) return;
    setProfileBusy(true);
    setError("");
    try {
      const response = await request({
        type: "writing-profile-ingest",
        text: sampleText.trim(),
        consent: true,
        useAsExemplar,
      });
      if (response.writingProfile) setProfile(response.writingProfile);
      setSampleText("");
      setSampleConsent(false);
      setUseAsExemplar(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not add the writing sample.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function resetProfile() {
    if (
      !window.confirm(
        "Reset the learned writing profile and remove its samples?",
      )
    )
      return;
    setProfileBusy(true);
    setError("");
    try {
      const response = await request({
        type: "writing-profile-reset",
        confirm: true,
      });
      if (response.writingProfile) setProfile(response.writingProfile);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reset the writing profile.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!purpose.trim()) {
      setError("Add a purpose before creating a draft.");
      return;
    }
    if (!writingRoutingReady) {
      setError("Choose an available provider account and model before drafting.");
      return;
    }
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await request({
        type: "writing-generate",
        ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
        purpose: purpose.trim(),
        ...(sourceText.trim() ? { sourceText: sourceText.trim() } : {}),
        genre,
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        adaptationStrength,
        includeSensitive,
        ...writingRouting,
        ...(modelChoice.executionMode === "manual" &&
        modelChoice.reasoningEffort !== "none"
          ? { reasoningEffort: modelChoice.reasoningEffort }
          : {}),
      });
      if (!response.writingResult)
        throw new Error("Kestrel did not return a writing draft.");
      setDraft(response.writingResult);
      setRoutes(response.writingRoutes ?? []);
      if (response.writingContextPreview)
        setContext(response.writingContextPreview);
      if (response.writingProfile) setProfile(response.writingProfile);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the writing draft.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    const text = draft.subject
      ? `Subject: ${draft.subject}\n\n${draft.body}`
      : draft.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setError("Kestrel could not copy the draft to the clipboard.");
    }
  }

  function updateDraft(field: "subject" | "body", value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  const profileConfig: WritingProfileConfig = profile?.config ?? {
    enabled: false,
    useSelectedExemplars: false,
    maxExemplars: 3,
  };
  const selectedStrength = adaptationStrengths.find(
    (item) => item.id === adaptationStrength,
  );
  const profilePanelPhase = writingProfilePanelPhase(
    profile !== null,
    profileLoading,
  );

  return (
    <PageFrame
      as="main"
      className="writing-studio"
    title="Write with your context."
      titleId="writing-studio-title"
      eyebrow="Writing Studio"
    description="Turn a brief and confirmed context into an editable draft."
      measure="wide"
      actions={
        <span className="writing-studio-badge">
          <Icon name="writing" />
      Local-first drafts
        </span>
      }
    >
      {error && (
        <p className="writing-studio-error" role="alert">
          {error}
        </p>
      )}

      <div className="writing-studio-grid">
        <section
          className="writing-brief-panel"
          aria-labelledby="writing-brief-title"
        >
          <header>
            <div>
              <span className="eyebrow">01 · Brief</span>
              <h2 id="writing-brief-title">What do you want to say?</h2>
            </div>
            <span className="writing-step-mark">A</span>
          </header>
          <form onSubmit={(event) => void generate(event)}>
            <div className="writing-form-grid">
              <label>
                <span>
                  Recipient <small>optional</small>
                </span>
                <input
                  value={recipient}
                  placeholder="Name, email, or relationship"
                  onChange={(event) => setRecipient(event.target.value)}
                />
              </label>
              <label>
                <span>Format</span>
                <select
                  value={genre}
                  onChange={(event) =>
                    setGenre(event.target.value as WritingGenre)
                  }
                >
                  {genres.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="writing-field-wide">
              <span>Purpose</span>
              <textarea
                value={purpose}
        placeholder="Outcome, key points, and details to keep."
                maxLength={10_000}
                required
                onChange={(event) => setPurpose(event.target.value)}
              />
            </label>
            <label className="writing-field-wide">
              <span>
                Starting text <small>optional · adapt an existing draft</small>
              </span>
              <textarea
                value={sourceText}
        placeholder="Paste notes or a draft to improve."
                maxLength={20_000}
                onChange={(event) => setSourceText(event.target.value)}
              />
            </label>
            <div className="writing-form-grid">
              <label>
                <span>
                  Tone <small>optional</small>
                </span>
                <input
                  value={tone}
                  placeholder="Warm, direct, concise…"
                  maxLength={300}
                  onChange={(event) => setTone(event.target.value)}
                />
              </label>
              <label>
                <span>Model route</span>
                <ModelSelector
                  accounts={providerAccounts}
                  choice={modelChoice}
                  onChange={setModelChoice}
                />
                <small>
                  Select an account and model to pin this draft, or leave
                  routing automatic.
                </small>
              </label>
            </div>
            <fieldset className="writing-strength-fieldset">
              <legend>Voice adaptation</legend>
              <div className="writing-strength-options">
                {adaptationStrengths.map((item) => (
                  <label
                    className={item.id === adaptationStrength ? "selected" : ""}
                    key={item.id}
                  >
                    <input
                      type="radio"
                      name="writing-adaptation-strength"
                      value={item.id}
                      checked={item.id === adaptationStrength}
                      onChange={() => setAdaptationStrength(item.id)}
                    />
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </label>
                ))}
              </div>
              <p>
        {selectedStrength?.detail}. Learned signals guide the draft; they do not
        prove authorship.
              </p>
            </fieldset>
            <label className="writing-sensitive-toggle">
              <input
                type="checkbox"
                checked={includeSensitive}
                onChange={(event) => setIncludeSensitive(event.target.checked)}
              />
              <span>
                <strong>Include sensitive context for this draft</strong>
                <small>
          Opt in only if the recipient and purpose require it.
                </small>
              </span>
            </label>
            <div className="writing-submit-row">
              <button
                className="button primary"
                disabled={busy || !purpose.trim() || !writingRoutingReady}
              >
                {busy ? <Icon name="loader" /> : <Icon name="writing" />}
                {busy
                  ? "Building draft…"
                  : sourceText.trim()
                    ? "Adapt draft"
                    : "Create draft"}
              </button>
        <small>Drafts are never sent automatically.</small>
            </div>
          </form>
        </section>

        <aside
          className="writing-context-panel"
          aria-labelledby="writing-context-title"
        >
          <header>
            <div>
              <span className="eyebrow">02 · Context</span>
              <h2 id="writing-context-title">What Kestrel can use</h2>
            </div>
            {previewBusy && <Icon name="loader" />}
          </header>
          {previewError && (
            <p className="writing-inline-error" role="status">
              {previewError}
            </p>
          )}
          {context ? (
            <>
              <div className="writing-context-match">
                <span className="writing-context-orb" aria-hidden="true" />
                <div>
                  <strong>
                    {context.recipient
                      ? `Matched ${context.recipient.displayName}`
                      : "Brief-led draft"}
                  </strong>
                  <small>
                    {context.sensitiveIncluded
                      ? "Sensitive context opted in"
                      : "Sensitive context stays excluded"}
                  </small>
                </div>
              </div>
              <div className="writing-context-counts">
                <div>
                  <strong>{context.confirmedProfileFacts}</strong>
                  <span>confirmed profile facts</span>
                </div>
                <div>
                  <strong>{context.memories}</strong>
                  <span>relevant memories</span>
                </div>
                <div>
                  <strong>{context.calendarEvents}</strong>
                  <span>calendar events</span>
                </div>
              </div>
              {context.categories.length > 0 && (
                <div className="writing-context-categories">
                  {context.categories.map((category) => (
                    <span key={category}>{contextCategoryLabel(category)}</span>
                  ))}
                </div>
              )}
              <ul className="writing-context-notes">
                {context.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          ) : (
            <div className="writing-context-empty">
              <Icon name="compass" />
              <strong>Start with a purpose</strong>
        <p>Add a purpose to preview eligible confirmed context.</p>
            </div>
          )}
        </aside>
      </div>

      <section
        className="writing-profile-panel"
        aria-labelledby="writing-profile-title"
      >
        <header>
          <div>
            <span className="eyebrow">03 · Your voice</span>
      <h2 id="writing-profile-title">Your voice</h2>
      <p>
        Voice adaptation stays off until enabled. Style signals stay local;
        only selected exemplars retain raw text.
            </p>
          </div>
          {profile && (
            <span className={`writing-profile-status ${profile.status}`}>
              <span aria-hidden="true" />
              {profile.status === "disabled"
                ? "Off"
                : profile.status === "ready"
                  ? "Ready"
                  : "Learning"}
            </span>
          )}
        </header>
        {profilePanelPhase === "ready" && profile ? (
          <div className="writing-profile-content">
            <div className="writing-profile-controls">
              <label className="writing-profile-toggle">
                <input
                  type="checkbox"
                  checked={profileConfig?.enabled ?? false}
                  disabled={profileBusy}
                  onChange={(event) =>
                    void configureProfile({ enabled: event.target.checked })
                  }
                />
                <span>
                  <strong>Use my voice profile</strong>
          <small>Guides the draft; you review it.</small>
                </span>
              </label>
              <label>
                <span>Private exemplars</span>
                <select
                  value={profileConfig?.maxExemplars ?? 3}
                  disabled={profileBusy}
                  onChange={(event) =>
                    void configureProfile({
                      maxExemplars: Number(event.target.value),
                    })
                  }
                >
                  {[0, 1, 2, 3, 4, 5].map((count) => (
                    <option value={count} key={count}>
                      {count === 0 ? "None" : `${count} max`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="writing-profile-toggle">
                <input
                  type="checkbox"
                  checked={profileConfig?.useSelectedExemplars ?? false}
                  disabled={profileBusy || profileConfig?.maxExemplars === 0}
                  onChange={(event) =>
                    void configureProfile({
                      useSelectedExemplars: event.target.checked,
                    })
                  }
                />
                <span>
                  <strong>Allow selected exemplars</strong>
          <small>Keep raw sample text encrypted.</small>
                </span>
              </label>
            </div>
            <div
              className="writing-profile-metrics"
              aria-label="Voice profile metrics"
            >
              <div>
                <strong>{profile.sampleCount}</strong>
                <span>samples</span>
              </div>
              <div>
                <strong>{profile.wordCount.toLocaleString()}</strong>
                <span>words learned</span>
              </div>
              <div>
                <strong>{profile.exemplarCount}</strong>
                <span>private exemplars</span>
              </div>
            </div>
            <form
              className="writing-sample-form"
              onSubmit={(event) => void addSample(event)}
            >
              <label>
                <span>Add a sample you wrote</span>
                <textarea
                  value={sampleText}
          placeholder="Paste an email, message, or paragraph to learn from."
                  maxLength={20_000}
                  disabled={profileBusy || !profileConfig.enabled}
                  onChange={(event) => setSampleText(event.target.value)}
                />
              </label>
              <div className="writing-sample-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={sampleConsent}
                    disabled={profileBusy || !profileConfig.enabled}
                    onChange={(event) => setSampleConsent(event.target.checked)}
                  />
                  <span>
                    I explicitly consent to use this sample for my profile.
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={useAsExemplar}
                    disabled={
                      profileBusy ||
                      !profileConfig.enabled ||
                      !profileConfig.useSelectedExemplars ||
                      profileConfig.maxExemplars === 0
                    }
                    onChange={(event) => setUseAsExemplar(event.target.checked)}
                  />
                  <span>Keep an encrypted private exemplar</span>
                </label>
                <button
                  className="button secondary"
                  disabled={
                    profileBusy ||
                    !profileConfig.enabled ||
                    !sampleConsent ||
                    !sampleText.trim()
                  }
                >
                  {profileBusy ? "Saving…" : "Add sample"}
                </button>
              </div>
            </form>
            <button
              type="button"
              className="writing-reset-button"
              disabled={profileBusy || profile.sampleCount === 0}
              onClick={() => void resetProfile()}
            >
              Reset voice profile
            </button>
          </div>
        ) : profilePanelPhase === "loading" ? (
          <p className="writing-profile-loading" role="status">
            Loading the encrypted profile…
          </p>
        ) : null}
      </section>

      {draft && (
        <section
          className="writing-result-panel"
          aria-labelledby="writing-result-title"
        >
          <header>
            <div>
              <span className="eyebrow">04 · Draft</span>
              <h2 id="writing-result-title">Your editable draft</h2>
            </div>
            <div className="writing-result-actions">
              <span className={`writing-quality ${draft.quality.status}`}>
                <span aria-hidden="true" />
                {formatQualityStatus(draft)}
              </span>
              <button
                type="button"
                className="button secondary"
                onClick={() => void copyDraft()}
              >
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy draft"}
              </button>
            </div>
          </header>
          <div className="writing-result-editor">
            {draft.subject !== undefined && (
              <label>
                <span>Subject</span>
                <input
                  value={draft.subject}
                  onChange={(event) =>
                    updateDraft("subject", event.target.value)
                  }
                />
              </label>
            )}
            <label>
              <span>Body</span>
              <textarea
                value={draft.body}
                onChange={(event) => updateDraft("body", event.target.value)}
              />
            </label>
          </div>
          <div className="writing-result-footer">
            <div>
              <strong>Review before you send</strong>
              <p>
        Kestrel does not send drafts. Review names, dates, commitments, and
        sensitive details.
              </p>
            </div>
            {draft.quality.reviewerIssues.length > 0 && (
              <ul aria-label="Reviewer notes">
                {draft.quality.reviewerIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
          {routes.length > 0 && (
            <details className="writing-route-details">
      <summary>Route details</summary>
              <div>
                {routes.map((route) => (
                  <span key={`${route.taskId}-${route.selectedAt}`}>
                    <strong>{routeLabel(route)}</strong>
                    {route.model} via {route.providerId ?? "configured route"} ·{" "}
                    {route.execution}
                  </span>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
    </PageFrame>
  );
}
