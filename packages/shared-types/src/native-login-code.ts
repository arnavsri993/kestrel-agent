import { z } from "zod";
import { CommunicationCodeMatchSchema } from "./communication";

// Private native host/extension protocol. These operations are intentionally
// absent from RendererRequestSchema and BrowserBackendWireRequestSchema.
const tabId = z.string().regex(/^tab-[a-f0-9-]{36}$/);
const browserId = z.number().int().nonnegative().max(2_147_483_647);
const origin = z.string().max(1_000).refine(value => {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") &&
			url.origin === value && !url.username && !url.password;
	} catch { return false; }
}, "A canonical HTTP(S) origin is required.");
export const NativeLoginCodeAuthoritySchema = z.object({
	tabId,
	chromeTabId: browserId,
	windowId: browserId,
	documentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
	origin,
	fieldId: z.string().uuid(),
}).strict();
export type NativeLoginCodeAuthority = z.infer<typeof NativeLoginCodeAuthoritySchema>;
export const NativeLoginCodeBrowserRequestSchema = z.discriminatedUnion("operation", [
	z.object({ operation: z.literal("inspect"), tabId }).strict(),
	z.object({ operation: z.literal("validate"), authority: NativeLoginCodeAuthoritySchema }).strict(),
	z.object({ operation: z.literal("fill"), authority: NativeLoginCodeAuthoritySchema, code: CommunicationCodeMatchSchema.shape.code }).strict(),
]);
export type NativeLoginCodeBrowserRequest = z.infer<typeof NativeLoginCodeBrowserRequestSchema>;
export const NativeLoginCodeValidatedSchema = z.object({ valid: z.literal(true) }).strict();
export const NativeLoginCodeFilledSchema = z.object({ filled: z.literal(true) }).strict();
export function parseNativeLoginCodeResult(operation: NativeLoginCodeBrowserRequest["operation"], result: unknown) {
	return (operation === "inspect" ? NativeLoginCodeAuthoritySchema : operation === "validate" ? NativeLoginCodeValidatedSchema : NativeLoginCodeFilledSchema).safeParse(result);
}
