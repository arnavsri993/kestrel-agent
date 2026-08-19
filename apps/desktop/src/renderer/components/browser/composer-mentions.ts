import type { SelectedAttachment, UserBrowserBookmark, UserBrowserTab } from "@kestrel/shared-types";

export interface ComposerMention {
	id: string;
	kind: "tab" | "bookmark" | "file";
	label: string;
	detail: string;
	insert: string;
	attachment?: SelectedAttachment;
}

export function mentionQuery(value: string, cursor = value.length): string | null {
	const before = value.slice(0, cursor);
	const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
	return match ? (match[1] ?? "") : null;
}

export function replaceMention(
	value: string,
	insert: string,
	cursor = value.length,
): string {
	const before = value.slice(0, cursor);
	const after = value.slice(cursor);
	return `${before.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
		const prefix = match.startsWith("@") ? "" : match[0] ?? "";
		return `${prefix}${insert} `;
	})}${after}`;
}

export function composerMentions(input: {
	query: string;
	tabs: UserBrowserTab[];
	bookmarks: UserBrowserBookmark[];
	files: SelectedAttachment[];
}): ComposerMention[] {
	const needle = input.query.trim().toLowerCase();
	const items: ComposerMention[] = [];
	for (const tab of input.tabs) {
		if (!tab.url) continue;
		const haystack = `${tab.title} ${tab.url}`.toLowerCase();
		if (needle && !haystack.includes(needle)) continue;
		items.push({
			id: tab.id,
			kind: "tab",
			label: tab.title,
			detail: tab.url,
			insert: `${tab.title} (${tab.url})`,
		});
	}
	for (const bookmark of input.bookmarks) {
		const haystack = `${bookmark.title} ${bookmark.url}`.toLowerCase();
		if (needle && !haystack.includes(needle)) continue;
		items.push({
			id: bookmark.id,
			kind: "bookmark",
			label: bookmark.title,
			detail: bookmark.url,
			insert: `${bookmark.title} (${bookmark.url})`,
		});
	}
	for (const file of input.files) {
		const haystack = `${file.name} ${file.path}`.toLowerCase();
		if (needle && !haystack.includes(needle)) continue;
		items.push({
			id: file.path,
			kind: "file",
			label: file.name,
			detail: file.path,
			insert: file.name,
			attachment: file,
		});
	}
	return items.slice(0, 8);
}
