import type { CoreRequest, CoreResponse, ProviderVerification } from "@kestrel/shared-types";

interface ProviderAuthMonitorOptions {
  request(request: CoreRequest): Promise<CoreResponse>;
  notify(event: { providerId: string; status: "failed" | "recovered"; detail: string }): void;
  initialDelayMs?: number;
  intervalMs?: number;
}

const MAX_TIMER_MS = 2_147_483_647;

function boundedTimer(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TIMER_MS, Math.max(minimum, Math.trunc(value)));
}

export class ProviderAuthMonitor {
  private readonly status = new Map<string, boolean>();
  private initialTimer: NodeJS.Timeout | undefined;
  private intervalTimer: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(private readonly options: ProviderAuthMonitorOptions) {}

  start(): void {
    if (this.initialTimer || this.intervalTimer) return;
    const initialDelay = boundedTimer(this.options.initialDelayMs, 2 * 60_000, 1_000);
    const interval = boundedTimer(this.options.intervalMs, 6 * 60 * 60_000, 60_000);
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.check();
    }, initialDelay);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => void this.check(), interval);
    this.intervalTimer.unref();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
  }

  async check(): Promise<ProviderVerification[]> {
    if (this.checking) return [];
    this.checking = true;
    try {
      const listed = await this.options.request({ type: "runtime-list-providers" });
      if (!listed.ok) return [];
      const providers = (listed.providers ?? []).filter((provider) => provider.id !== "auto");
      const verifications: ProviderVerification[] = [];
      for (const provider of providers) {
        const response = await this.options.request({ type: "runtime-verify-provider", providerId: provider.id });
        if (!response.ok) continue;
        verifications.push(...(response.providerVerifications ?? []));
      }
      const observed = new Set<string>();
      for (const verification of verifications) {
        const key = verification.providerId;
        observed.add(key);
        const previous = this.status.get(key);
        this.status.set(key, verification.ok);
        if (!verification.ok && previous !== false) {
          this.options.notify({ providerId: key, status: "failed", detail: verification.error?.slice(0, 500) || "The provider rejected its saved authentication." });
        } else if (verification.ok && previous === false) {
          this.options.notify({ providerId: key, status: "recovered", detail: "The provider accepted its saved authentication again." });
        }
      }
      for (const key of [...this.status.keys()]) if (!observed.has(key)) this.status.delete(key);
      return verifications;
    } catch {
      return [];
    } finally {
      this.checking = false;
    }
  }
}
