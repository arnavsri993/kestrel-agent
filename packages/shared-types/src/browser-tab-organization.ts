import { z } from "zod";

const TAB_FOLDER_ID_PATTERN = /^tab-folder-[a-f0-9-]{36}$/;

/**
 * The model sees only the small amount of metadata needed to name a group.
 * Full URLs, query strings, and browser state stay in the desktop process.
 */
export const BrowserTabFolderNamingGroupSchema = z
	.object({
		id: z.string().regex(TAB_FOLDER_ID_PATTERN),
		fallbackName: z.string().min(1).max(80),
		tabs: z
			.array(
				z
					.object({
						title: z.string().min(1).max(200),
						host: z.string().min(1).max(253),
					})
					.strict(),
			)
			.min(1)
			.max(32),
	})
	.strict();
export type BrowserTabFolderNamingGroup = z.infer<
	typeof BrowserTabFolderNamingGroupSchema
>;

export const BrowserTabFolderNameSchema = z
	.object({
		id: z.string().regex(TAB_FOLDER_ID_PATTERN),
		name: z.string().min(1).max(64),
	})
	.strict();
export type BrowserTabFolderName = z.infer<
	typeof BrowserTabFolderNameSchema
>;

export const BrowserTabFolderNamesResponseSchema = z
	.array(BrowserTabFolderNameSchema)
	.max(32);

/**
 * Model output is rendered as a folder label, so keep it concise and inert.
 * This rejects prompt-like, URL-like, and control-character output before it
 * can cross back into the browser UI.
 */
export function validateBrowserTabFolderName(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
	if (
		!normalized ||
		normalized.length > 64 ||
		/[\u0000-\u001f\u007f]/u.test(normalized) ||
		/(?:https?:\/\/|www\.|@)/iu.test(normalized) ||
		!/^[\p{L}\p{M}\p{N}&'’+,.()\- ]+$/u.test(normalized) ||
		!/[\p{L}]/u.test(normalized) ||
		normalized.split(" ").length > 6
	)
		return undefined;
	return normalized;
}
