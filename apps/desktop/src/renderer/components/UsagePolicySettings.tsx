import { useEffect, useState } from "react";
import type { UsagePolicy, CoreResponse } from "@kestrel/shared-types";

export function UsagePolicySettings() {
  const [policy, setPolicy] = useState<UsagePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void window.kestrel
      .request({ type: "runtime-get-usage-policy" })
      .then((raw) => {
        const response = raw as CoreResponse;
        if (response.ok) setPolicy(response.usagePolicy ?? null);
        else setError(response.error);
      });
  }, []);
  if (!policy)
    return (
      <article className="setting-row">
        <div>
          <strong>Usage and cost guardrails</strong>
          <p>Loading encrypted budget policy…</p>
          {error && <small role="alert">{error}</small>}
        </div>
      </article>
    );
  const updateNumber = (
    field:
      | "dailyBudgetUsd"
      | "monthlyBudgetUsd"
      | "perCallReservationUsd"
      | "maximumConcurrentCalls",
    value: string,
  ) => setPolicy({ ...policy, [field]: Number(value) });
  const updateRate = (field: keyof UsagePolicy["defaultRate"], value: string) =>
    setPolicy({
      ...policy,
      defaultRate: { ...policy.defaultRate, [field]: Number(value) },
    });
  async function save() {
    if (!policy) return;
    setBusy(true);
    setError("");
    try {
      const response = (await window.kestrel.request({
        type: "runtime-set-usage-policy",
        policy,
      })) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      setPolicy(response.usagePolicy ?? policy);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Usage policy save failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="setting-row usage-policy-setting">
      <div>
        <strong>Usage and cost guardrails</strong>
        <p>
          Budget reservations and concurrency are enforced before every provider
          call. Rates are accounting estimates per million tokens and can be
          overridden through the policy API by model.
        </p>
        <div className="usage-policy-grid">
          <label>
            Daily budget, USD
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={policy.dailyBudgetUsd}
              onChange={(event) =>
                updateNumber("dailyBudgetUsd", event.target.value)
              }
            />
          </label>
          <label>
            Monthly budget, USD
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={policy.monthlyBudgetUsd}
              onChange={(event) =>
                updateNumber("monthlyBudgetUsd", event.target.value)
              }
            />
          </label>
          <label>
            Per-call reserve, USD
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={policy.perCallReservationUsd}
              onChange={(event) =>
                updateNumber("perCallReservationUsd", event.target.value)
              }
            />
          </label>
          <label>
            Concurrent calls
            <input
              type="number"
              min="1"
              max="64"
              step="1"
              value={policy.maximumConcurrentCalls}
              onChange={(event) =>
                updateNumber("maximumConcurrentCalls", event.target.value)
              }
            />
          </label>
          <label>
            Input / 1M
            <input
              type="number"
              min="0"
              step="0.01"
              value={policy.defaultRate.inputPerMillionUsd}
              onChange={(event) =>
                updateRate("inputPerMillionUsd", event.target.value)
              }
            />
          </label>
          <label>
            Output / 1M
            <input
              type="number"
              min="0"
              step="0.01"
              value={policy.defaultRate.outputPerMillionUsd}
              onChange={(event) =>
                updateRate("outputPerMillionUsd", event.target.value)
              }
            />
          </label>
          <label>
            Cached input / 1M
            <input
              type="number"
              min="0"
              step="0.01"
              value={policy.defaultRate.cachedInputPerMillionUsd}
              onChange={(event) =>
                updateRate("cachedInputPerMillionUsd", event.target.value)
              }
            />
          </label>
          <label>
            Reasoning / 1M
            <input
              type="number"
              min="0"
              step="0.01"
              value={policy.defaultRate.reasoningPerMillionUsd}
              onChange={(event) =>
                updateRate("reasoningPerMillionUsd", event.target.value)
              }
            />
          </label>
        </div>
        {error && <small role="alert">{error}</small>}
      </div>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save guardrails"}
      </button>
    </article>
  );
}
