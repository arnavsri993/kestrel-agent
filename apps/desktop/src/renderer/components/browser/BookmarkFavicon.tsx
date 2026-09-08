import type { UserBrowserOriginFavicon } from "@kestrel/shared-types";
import { useState } from "react";
import { bookmarkBarFaviconDataUrl, bookmarkBarGlyph } from "./bookmarks-bar";

export function BookmarkFavicon({
	title,
	url,
	faviconDataUrl,
	originFavicons,
	className,
}: {
	title: string;
	url: string;
	faviconDataUrl?: string;
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	className: string;
}) {
	const bookmarkFavicon = bookmarkBarFaviconDataUrl(
		url,
		[],
		faviconDataUrl,
	);
	const originFavicon = bookmarkBarFaviconDataUrl(
		url,
		originFavicons,
	);
	const faviconCandidates = [bookmarkFavicon, originFavicon].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);
	const candidateKey = faviconCandidates.join("\u0000");
	const [failureState, setFailureState] = useState<{
		key: string;
		urls: string[];
	}>({ key: "", urls: [] });
	const failedUrls =
		failureState.key === candidateKey ? failureState.urls : [];
	const resolvedFavicon = faviconCandidates.find(
		(candidate) => !failedUrls.includes(candidate),
	);

	return (
		<span className={className} aria-hidden="true">
			{resolvedFavicon ? (
				<img
					src={resolvedFavicon}
					alt=""
					draggable={false}
					onError={() =>
						setFailureState((current) => {
							const urls = current.key === candidateKey ? current.urls : [];
							return urls.includes(resolvedFavicon)
								? current
								: { key: candidateKey, urls: [...urls, resolvedFavicon] };
						})
					}
				/>
			) : (
				bookmarkBarGlyph(title, url)
			)}
		</span>
	);
}
