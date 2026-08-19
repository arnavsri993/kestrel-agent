import { z } from "zod";

const SESSION_ID = z.string().min(1).max(200);
const TAB_ID = z.string().regex(/^tab-[a-f0-9-]{36}$/);
const NAMED_KEYS = [
	"Enter",
	"Escape",
	"Tab",
	"Backspace",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
] as const;

export const BrowserActionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("click"),
			target: z.string().min(1).max(2_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("type"),
			target: z.string().min(1).max(2_000),
			text: z.string().max(20_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("key"),
			key: z.union([
				z.enum(NAMED_KEYS),
				z.string().regex(/^[A-Za-z0-9]{1,20}$/),
			]),
		})
		.strict(),
	z
		.object({
			type: z.literal("scroll"),
			x: z.number().gte(-100_000).lte(100_000),
			y: z.number().gte(-100_000).lte(100_000),
		})
		.strict(),
]);

export const DesktopActionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("click"),
			x: z.number().int().gte(0).lte(20_000),
			y: z.number().int().gte(0).lte(20_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("type"),
			text: z.string().min(1).max(20_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("key"),
			key: z.enum(NAMED_KEYS),
		})
		.strict(),
]);

export const BrowserViewportSchema = z
	.object({
		name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
		width: z.number().int().gte(240).lte(3_840),
		height: z.number().int().gte(240).lte(2_160),
		deviceScaleFactor: z.number().gte(0.5).lte(4).optional(),
	})
	.strict();

export const BrowserBackendWireRequestSchema = z.discriminatedUnion(
	"operation",
	[
		z
			.object({
				operation: z.literal("create"),
				allowedOrigins: z.array(z.string().url()).min(1).max(20),
			})
			.strict(),
		z
			.object({
				operation: z.literal("navigate"),
				sessionId: SESSION_ID,
				url: z.string().min(1).max(8_192),
			})
			.strict(),
		z
			.object({
				operation: z.literal("act"),
				sessionId: SESSION_ID,
				action: BrowserActionSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("snapshot"),
				sessionId: SESSION_ID,
			})
			.strict(),
		z
			.object({
				operation: z.literal("screenshot"),
				sessionId: SESSION_ID,
			})
			.strict(),
		z
			.object({
				operation: z.literal("viewport"),
				sessionId: SESSION_ID,
				viewport: BrowserViewportSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("diagnostics"),
				sessionId: SESSION_ID,
			})
			.strict(),
		z
			.object({
				operation: z.literal("auth-handoff"),
				sessionId: SESSION_ID,
				visible: z.boolean(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("upload"),
				sessionId: SESSION_ID,
				selector: z.string().min(1).max(2_000),
				paths: z.array(z.string().min(1).max(4_096)).min(1).max(20),
			})
			.strict(),
		z
			.object({
				operation: z.literal("downloads"),
				sessionId: SESSION_ID,
			})
			.strict(),
		z.object({ operation: z.literal("desktop-screenshot") }).strict(),
		z
			.object({
				operation: z.literal("desktop-act"),
				action: DesktopActionSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("close"),
				sessionId: SESSION_ID,
			})
			.strict(),
		z.object({ operation: z.literal("visible-tabs") }).strict(),
		z
			.object({
				operation: z.literal("visible-context"),
				tabId: TAB_ID.optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-snapshot"),
				tabId: TAB_ID.optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-screenshot"),
				tabId: TAB_ID.optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-history"),
				query: z.string().max(500).optional(),
				limit: z.number().int().gte(1).lte(100).optional(),
			})
			.strict(),
		z.object({ operation: z.literal("visible-downloads") }).strict(),
		z
			.object({
				operation: z.literal("visible-act"),
				tabId: TAB_ID,
				action: BrowserActionSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-navigate"),
				tabId: TAB_ID,
				input: z.string().min(1).max(8_192),
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-create"),
				input: z.string().max(8_192).optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-close"),
				tabId: TAB_ID,
			})
			.strict(),
		z
			.object({
				operation: z.literal("visible-select"),
				tabId: TAB_ID,
			})
			.strict(),
	],
);

export const BrowserBackendRequestMessageSchema = z
	.object({
		type: z.literal("browser-backend-request"),
		requestId: z.string().min(1).max(200),
		request: BrowserBackendWireRequestSchema,
	})
	.strict();

export const BrowserBackendCancelMessageSchema = z
	.object({
		type: z.literal("browser-backend-cancel"),
		requestId: z.string().min(1).max(200),
	})
	.strict();

export type BrowserBackendWireRequest = z.infer<
	typeof BrowserBackendWireRequestSchema
>;
export type UserBrowserBackendWireRequest = Extract<
	BrowserBackendWireRequest,
	{ operation: `visible-${string}` }
>;
export type AutomationBrowserBackendWireRequest = Exclude<
	BrowserBackendWireRequest,
	UserBrowserBackendWireRequest
>;

export function isUserBrowserBackendWireRequest(
	request: BrowserBackendWireRequest,
): request is UserBrowserBackendWireRequest {
	return request.operation.startsWith("visible-");
}
