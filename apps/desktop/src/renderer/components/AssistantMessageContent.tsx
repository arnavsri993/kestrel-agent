import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./assistant-message-content.css";

export function assistantLinkUrl(value: string): string {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
	} catch { return ""; }
}

const plugins = [remarkGfm];
export const AssistantMessageContent = memo(function AssistantMessageContent({ content }: { content: string }) {
	const [linkError, setLinkError] = useState("");
	async function openLink(url: string) {
		setLinkError("");
		try {
			const result = await window.kestrel.request({ type: "browser-create-tab", input: url, active: true });
			if (!result.ok) setLinkError("Could not open this link. Try opening it from the address bar.");
		} catch { setLinkError("Could not open this link. Try opening it from the address bar."); }
	}
	return (
		<div className="assistant-content">
			<Markdown skipHtml remarkPlugins={plugins} urlTransform={assistantLinkUrl} components={{
				a: ({ href, children }) => href ? <a href={href} onClick={event => { event.preventDefault(); void openLink(href); }}>{children}</a> : <span>{children}</span>,
				// Model output cannot silently fetch remote images or run HTML.
				img: ({ alt }) => <span className="assistant-image-reference">{alt ? `Image: ${alt}` : "Image reference"}</span>,
				table: ({ children }) => <div className="assistant-table-scroll" tabIndex={0} role="region" aria-label="Answer table"><table>{children}</table></div>,
				pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
			}}>{content}</Markdown>
			{linkError && <small role="alert">{linkError}</small>}
		</div>
	);
});
