import type { z } from "zod";
import {
	AgentStreamEventSchema,
	ExternalIntakeSchema,
	KestrelDeepLinkSchema,
	LocalRuntimeProgressSchema,
	PaymentPromptSchema,
	PasswordPromptSchema,
	PetActivityStateSchema,
	PetStatusSchema,
	type RendererBridge,
	type RendererRequest,
	RendererRequestSchema,
	type RendererResponse,
	RuntimeEventSchema,
	UserBrowserCommandSchema,
	UserBrowserEventSchema,
	WindowFocusStateSchema,
	WorkspaceSnapshotSchema,
} from "./contracts";

export type RendererEventChannel =
	| "browser-event"
	| "window-focus"
	| "password-prompt"
	| "payment-prompt"
	| "browser-command"
	| "deep-link"
	| "external-intake"
	| "snapshot"
	| "pet-status"
	| "pet-activity"
	| "runtime-event"
	| "agent-stream"
	| "local-runtime-progress";

export type RendererReadySignal =
	| "window-focus-ready"
	| "deep-link-ready"
	| "deep-link-not-ready"
	| "external-intake-ready";

/** A host supplies transport only; request and event validation are shared. */
export interface RendererTransport {
	request(request: RendererRequest): Promise<RendererResponse>;
	subscribe(channel: RendererEventChannel, callback: (value: unknown) => void): () => void;
	notify?(signal: RendererReadySignal): void;
}

/** Browser-safe: no Electron, Node globals, or host discovery. */
export function createRendererBridge(transport: RendererTransport): RendererBridge {
	function subscribe<S extends z.ZodType>(
		channel: RendererEventChannel,
		schema: S,
		callback: (value: z.output<S>) => void,
		ready?: RendererReadySignal,
		notReady?: RendererReadySignal,
	): () => void {
		let closed = false;
		const unsubscribe = transport.subscribe(channel, (value) => {
			if (closed) return;
			const parsed = schema.safeParse(value);
			if (parsed.success) callback(parsed.data);
		});
		try {
			if (ready) transport.notify?.(ready);
		} catch (error) {
			closed = true;
			unsubscribe();
			throw error;
		}
		return () => {
			if (closed) return;
			closed = true;
			try {
				unsubscribe();
			} finally {
				if (notReady) transport.notify?.(notReady);
			}
		};
	}

	return Object.freeze({
		request: (request: RendererRequest) => transport.request(RendererRequestSchema.parse(request)),
		onBrowserEvent: (callback) => subscribe("browser-event", UserBrowserEventSchema, callback),
		onWindowFocus: (callback) => subscribe("window-focus", WindowFocusStateSchema, callback, "window-focus-ready"),
		onPasswordPrompt: (callback) => subscribe("password-prompt", PasswordPromptSchema.nullable(), callback),
		onPaymentPrompt: (callback) => subscribe("payment-prompt", PaymentPromptSchema.nullable(), callback),
		onBrowserCommand: (callback) => subscribe("browser-command", UserBrowserCommandSchema, callback),
		onDeepLink: (callback) => subscribe("deep-link", KestrelDeepLinkSchema, callback, "deep-link-ready", "deep-link-not-ready"),
		onExternalIntake: (callback) => subscribe("external-intake", ExternalIntakeSchema, callback, "external-intake-ready"),
		onSnapshot: (callback) => subscribe("snapshot", WorkspaceSnapshotSchema, callback),
		onPetStatus: (callback) => subscribe("pet-status", PetStatusSchema, callback),
		onPetActivity: (callback) => subscribe("pet-activity", PetActivityStateSchema, callback),
		onRuntimeEvent: (callback) => subscribe("runtime-event", RuntimeEventSchema, callback),
		onAgentStream: (callback) => subscribe("agent-stream", AgentStreamEventSchema, callback),
		onLocalRuntimeProgress: (callback) => subscribe("local-runtime-progress", LocalRuntimeProgressSchema, callback),
	} satisfies RendererBridge);
}
