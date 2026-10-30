import { z } from "zod";
import { ReasoningEffortSchema, RuntimeApprovalPolicySchema, SelectedAttachmentSchema } from "@kestrel/shared-types";
import type { NewTabComposerDraft } from "./components/browser/new-tab-composer";

export type NativeAgentAction =
	| { type: "new-agent"; prompt: string; workspaceRoot?: string; projectId?: string | null; focusTarget: "prompt" | "task-settings"; draft?: NewTabComposerDraft }
	| { type: "open-session"; sessionId: string | null };

const path = z.string().min(1).max(4096);
const draft = z.object({ prompt: z.string().max(500_000), workspaceRoot: path.optional(), projectId: z.string().min(1).max(100).optional(),
	modelChoice: z.object({ executionMode: z.enum(["automatic", "manual"]), providerId: z.string().max(100), accountId: z.string().max(100).optional(), model: z.string().max(200), reasoningEffort: ReasoningEffortSchema }).strict(),
	approvalPolicy: RuntimeApprovalPolicySchema, attachments: z.array(SelectedAttachmentSchema).max(8),
}).strict();
const ActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("new-agent"), prompt: z.string().max(500_000), workspaceRoot: path.optional(), projectId: z.string().min(1).max(100).nullable().optional(), focusTarget: z.enum(["prompt", "task-settings"]), draft: draft.optional() }).strict(),
	z.object({ type: z.literal("open-session"), sessionId: z.string().min(1).max(100).nullable() }).strict(),
]);
interface Channel {
	postMessage(value: unknown): void;
	addEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
	close(): void;
}
const UNAVAILABLE = "The native agent panel did not accept this request. Check the current task before trying again.";

// Same-origin BroadcastChannel is available only to the private first-party
// extension. Window IDs prevent cross-window task routing. There is no host
// bridge here, persisted prompt queue, or automatic replay after a disconnect.
export function createNativeAgentChannel({ channel, windowId, panel, timeoutMs = 8_000 }: { channel: Channel; windowId: number; panel: boolean; timeoutMs?: number }) {
	let closed = false;
	let handler: ((action: NativeAgentAction) => void | Promise<void>) | undefined;
	const waiting = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	const received = new Map<string, boolean | undefined>();
	const queued = new Map<string, { action: NativeAgentAction; timer: ReturnType<typeof setTimeout> }>();
	function acknowledge(id: string, accepted: boolean) {
		if (received.has(id)) received.set(id, accepted);
		if (!closed) channel.postMessage({ kind: "agent-action-receipt", id, windowId, accepted });
	}
	function deliver(id: string, action: NativeAgentAction) {
		if (!handler || closed) return;
		const callback = handler;
		void Promise.resolve().then(() => callback(action)).then(() => acknowledge(id, true), () => acknowledge(id, false));
	}
	const message = ({ data }: { data: unknown }) => {
		if (closed || !data || typeof data !== "object" || Array.isArray(data)) return;
		const value = data as Record<string, unknown>;
		if (value.windowId !== windowId || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) return;
		const id = value.id;
		if (value.kind === "agent-action-receipt" && !panel) {
			const request = waiting.get(value.id); if (!request || typeof value.accepted !== "boolean") return;
			waiting.delete(value.id); clearTimeout(request.timer);
			if (value.accepted) request.resolve(); else request.reject(new Error(UNAVAILABLE));
			return;
		}
		if (value.kind !== "agent-action" || !panel) return;
		if (received.has(value.id)) { const accepted = received.get(value.id); if (accepted !== undefined) acknowledge(value.id, accepted); return; }
		const parsed = ActionSchema.safeParse(value.action);
		if (received.size >= 128) {
			for (const [oldId, result] of received) if (result !== undefined) { received.delete(oldId); break; }
		}
		if (!parsed.success || received.size >= 128 || queued.size >= 8) { acknowledge(id, false); return; }
		received.set(value.id, undefined);
		const action = parsed.data as NativeAgentAction;
		if (handler) deliver(value.id, action);
		else queued.set(id, { action, timer: setTimeout(() => { queued.delete(id); acknowledge(id, false); }, timeoutMs) });
	};
	channel.addEventListener("message", message);
	return {
		send(action: NativeAgentAction): Promise<void> {
			if (closed || panel || waiting.size >= 8 || !ActionSchema.safeParse(action).success || new TextEncoder().encode(JSON.stringify(action)).byteLength > 768 * 1024) return Promise.reject(new Error(UNAVAILABLE));
			return new Promise((resolve, reject) => {
				const id = crypto.randomUUID();
				const timer = setTimeout(() => { waiting.delete(id); reject(new Error(UNAVAILABLE)); }, timeoutMs);
				waiting.set(id, { resolve, reject, timer });
				try { channel.postMessage({ kind: "agent-action", id, windowId, action }); }
				catch { waiting.delete(id); clearTimeout(timer); reject(new Error(UNAVAILABLE)); }
			});
		},
		subscribe(callback: (action: NativeAgentAction) => void | Promise<void>) {
			handler = callback;
			for (const [id, item] of queued) { queued.delete(id); clearTimeout(item.timer); deliver(id, item.action); }
			return () => { if (handler === callback) handler = undefined; };
		},
		close() {
			if (closed) return; closed = true;
			channel.removeEventListener("message", message); channel.close();
			for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error(UNAVAILABLE)); }
			for (const item of queued.values()) clearTimeout(item.timer);
			waiting.clear(); queued.clear(); received.clear(); handler = undefined;
		},
	};
}
