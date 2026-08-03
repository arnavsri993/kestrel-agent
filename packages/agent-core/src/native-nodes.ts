import { randomUUID } from "node:crypto";

export type NodePlatform = "ios" | "android" | "macos";
export type LocationAccuracy = "coarse" | "balanced" | "precise";
export type NativeNodeCapability = "location" | "talk" | "voiceWake" | "activePresence";

export interface NativeNodeBeacon {
  nodeId: string;
  label: string;
  platform: NodePlatform;
  version?: string;
  capabilities: NativeNodeCapability[];
  idleSeconds?: number;
}

export interface NativeNodeRecord extends NativeNodeBeacon {
  connectedAt: string;
  lastSeenAt: string;
  status: "active" | "idle";
}

export interface NativeNodeCommand {
  id: string;
  kind: "location.get" | "talk.speak";
  createdAt: string;
  expiresAt: string;
  input: Record<string, unknown>;
}

export interface NativeNodeResult {
  commandId: string;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const CAPABILITIES = new Set<NativeNodeCapability>(["location", "talk", "voiceWake", "activePresence"]);

function boundedDuration(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(candidate)));
}

function cleanTriggers(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("Voice-wake triggers must be an array.");
  const raw = input.length === 0 ? DEFAULT_TRIGGERS : input;
  if (raw.length > 32) throw new Error("Voice-wake triggers exceed 32 entries.");
  const normalized = raw.map((value) => {
    if (typeof value !== "string") throw new Error("Voice-wake trigger is invalid.");
    const trigger = value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!trigger || trigger.length > 64) throw new Error("Voice-wake trigger is invalid.");
    return trigger;
  });
  return [...new Set(normalized)];
}

export class NativeNodeManager {
  private readonly nodes = new Map<string, Omit<NativeNodeRecord, "status">>();
  private readonly commands = new Map<string, NativeNodeCommand[]>();
  private readonly results = new Map<string, NativeNodeResult>();
  private triggers = DEFAULT_TRIGGERS;

  constructor(private readonly now: () => Date = () => new Date()) {}

  beacon(input: NativeNodeBeacon): NativeNodeRecord {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.nodeId)) throw new Error("Node ID is invalid.");
    if (!input.label.trim() || input.label.length > 100) throw new Error("Node label is invalid.");
    if (!["ios", "android", "macos"].includes(input.platform)) throw new Error("Node platform is invalid.");
    if (input.capabilities.length > 8 || input.capabilities.some((item) => !CAPABILITIES.has(item))) throw new Error("Node capabilities are invalid.");
    if (input.idleSeconds !== undefined && (!Number.isInteger(input.idleSeconds) || input.idleSeconds < 0 || input.idleSeconds > 31_536_000)) throw new Error("Node idle seconds are invalid.");
    const timestamp = this.now().toISOString();
    const existing = this.nodes.get(input.nodeId);
    const record = {
      ...input,
      capabilities: [...new Set(input.capabilities)],
      connectedAt: existing?.connectedAt ?? timestamp,
      lastSeenAt: timestamp
    };
    this.nodes.set(input.nodeId, record);
    return { ...record, status: (input.idleSeconds ?? 0) >= 60 ? "idle" : "active" };
  }

  list(): NativeNodeRecord[] {
    const cutoff = this.now().getTime() - 300_000;
    for (const [id, node] of this.nodes) if (new Date(node.lastSeenAt).getTime() < cutoff) this.nodes.delete(id);
    return [...this.nodes.values()].map((node) => ({ ...node, status: (node.idleSeconds ?? 0) >= 60 ? "idle" as const : "active" as const }));
  }

  enqueueLocation(nodeId: string, input: { timeoutMs?: number; maxAgeMs?: number; desiredAccuracy?: LocationAccuracy }): NativeNodeCommand {
    const node = this.requireCapability(nodeId, "location");
    const timeoutMs = boundedDuration(input.timeoutMs, 10_000, 1_000, 60_000);
    const maxAgeMs = boundedDuration(input.maxAgeMs, 0, 0, 3_600_000);
    const desiredAccuracy = input.desiredAccuracy ?? "balanced";
    if (!["coarse", "balanced", "precise"].includes(desiredAccuracy)) throw new Error("Location accuracy is invalid.");
    return this.enqueue(node.nodeId, "location.get", { timeoutMs, maxAgeMs, desiredAccuracy }, timeoutMs + 10_000);
  }

  enqueueTalk(nodeId: string, text: string, sessionId?: string): NativeNodeCommand {
    const node = this.requireCapability(nodeId, "talk");
    if (!text.trim() || text.length > 10_000) throw new Error("Talk text is invalid.");
    if (sessionId && (sessionId.length > 200 || !sessionId.trim())) throw new Error("Talk session is invalid.");
    return this.enqueue(node.nodeId, "talk.speak", { text, ...(sessionId ? { sessionId } : {}) }, 120_000);
  }

  poll(nodeId: string): { commands: NativeNodeCommand[]; voiceWake: string[] } {
    if (!this.nodes.has(nodeId)) throw new Error("Node must beacon before polling.");
    const now = this.now().getTime();
    const pending = (this.commands.get(nodeId) ?? []).filter((command) => new Date(command.expiresAt).getTime() > now).slice(0, 20);
    this.commands.set(nodeId, []);
    return { commands: pending, voiceWake: [...this.triggers] };
  }

  complete(nodeId: string, result: NativeNodeResult): void {
    if (!this.nodes.has(nodeId)) throw new Error("Node is not registered.");
    if (!/^node-command-[A-Za-z0-9-]+$/.test(result.commandId)) throw new Error("Node command ID is invalid.");
    if (JSON.stringify(result).length > 100_000) throw new Error("Node result exceeds limits.");
    this.results.set(result.commandId, structuredClone(result));
    if (this.results.size > 500) this.results.delete(this.results.keys().next().value!);
  }

  result(commandId: string): NativeNodeResult | undefined { return this.results.get(commandId); }
  getVoiceWake(): string[] { return [...this.triggers]; }
  setVoiceWake(input: unknown): string[] { this.triggers = cleanTriggers(input); return this.getVoiceWake(); }

  private requireCapability(nodeId: string, capability: NativeNodeCapability) {
    const node = this.nodes.get(nodeId);
    if (!node || !node.capabilities.includes(capability)) throw new Error(`Node does not provide ${capability}.`);
    return node;
  }

  private enqueue(nodeId: string, kind: NativeNodeCommand["kind"], input: Record<string, unknown>, lifetimeMs: number): NativeNodeCommand {
    const created = this.now();
    const command: NativeNodeCommand = { id: `node-command-${randomUUID()}`, kind, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + lifetimeMs).toISOString(), input };
    const pending = this.commands.get(nodeId) ?? [];
    if (pending.length >= 20) throw new Error("Node command queue is full.");
    pending.push(command);
    this.commands.set(nodeId, pending);
    return command;
  }
}
