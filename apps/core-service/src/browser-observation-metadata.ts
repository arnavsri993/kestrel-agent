import { UserBrowserDownloadSchema, UserBrowserHistoryEntrySchema } from "@kestrel/shared-types";
import { z } from "zod";
import { browserObservationText, browserObservationUrl } from "./browser-page-context";

const tabs = z.array(z.object({
	id: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	title: z.string().max(500), url: z.string().max(8_192),
	active: z.boolean(), loading: z.boolean(), discarded: z.boolean(),
	trust: z.literal("untrusted_browser"),
})).max(1_000);
const history = z.object({ entries: z.array(UserBrowserHistoryEntrySchema).max(100), trust: z.literal("untrusted_browser") });
const downloads = z.object({ downloads: z.array(UserBrowserDownloadSchema).max(500), trust: z.literal("untrusted_browser") });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	// Do not reflect a malformed host payload (possibly containing a credential)
	// into an error message, activity receipt, or model context.
	if (!result.success) throw new Error("The browser returned invalid observation metadata.");
	return result.data;
}

export function normalizeBrowserVisibleTabs(value: unknown) {
	return parse(tabs, value).flatMap(tab => {
		const url = tab.url === "about:blank" ? tab.url : browserObservationUrl(tab.url);
		return url ? [{ ...tab, url, title: browserObservationText(tab.title, 500) || "Untitled page" }] : [];
	});
}

export function normalizeBrowserHistory(value: unknown) {
	const result = parse(history, value);
	return { ...result, entries: result.entries.flatMap(entry => {
		const url = browserObservationUrl(entry.url);
		return url ? [{ ...entry, url, title: browserObservationText(entry.title, 500) || "Untitled page" }] : [];
	}) };
}

export function normalizeBrowserDownloads(value: unknown) {
	const result = parse(downloads, value);
	return { ...result, downloads: result.downloads.flatMap(download => {
		const sourceUrl = browserObservationUrl(download.sourceUrl);
		return sourceUrl ? [{ ...download, sourceUrl, filename: browserObservationText(download.filename, 255) || "Download",
			...(download.reputation ? { reputation: { ...download.reputation, provider: browserObservationText(download.reputation.provider, 100) || "Unknown" } } : {}),
		}] : [];
	}) };
}
