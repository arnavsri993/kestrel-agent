/**
 * The native WebContents find API currently does not report results for a
 * WebContentsView in Electron 43. Keep the user-visible fallback in an
 * isolated world: it receives only the person's query and returns only a
 * boolean and a match count, never page text.
 */
export const FIND_IN_PAGE_WORLD_ID = 1005;

export interface FallbackFindInPageResult {
	found: boolean;
	matches: number;
}

export const CLEAR_FIND_IN_PAGE_SELECTION_SCRIPT = `(() => {
	window.getSelection()?.removeAllRanges();
})()`;

export function findInPageFallbackScript(options: {
	query: string;
	findNext: boolean;
	forward: boolean;
}): string {
	return `(() => {
		const request = ${JSON.stringify(options)};
		const selection = window.getSelection();
		if (!request.findNext) selection?.removeAllRanges();
		const found =
			typeof window.find === "function" &&
			window.find(
				request.query,
				false,
				!request.forward,
				true,
				false,
				true,
				false,
			);
		const source = (document.body?.innerText ?? "").toLocaleLowerCase();
		const query = request.query.toLocaleLowerCase();
		let matches = 0;
		let offset = 0;
		while (offset <= source.length - query.length) {
			const match = source.indexOf(query, offset);
			if (match < 0) break;
			matches += 1;
			offset = match + query.length;
		}
		return {
			found: Boolean(found),
			matches: found ? Math.max(1, matches) : 0,
		};
	})()`;
}
