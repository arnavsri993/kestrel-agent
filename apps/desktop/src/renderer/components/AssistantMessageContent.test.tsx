import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMessageContent, assistantLinkUrl } from "./AssistantMessageContent";

describe("assistant answer rendering", () => {
	it("renders model headings, lists, emphasis, code and tables as readable content", () => {
		const markup = renderToStaticMarkup(<AssistantMessageContent content={'## Verification\n\n- **Heading:** `Kestrel local verification`\n- Observed URL\n\n```js\nconst value = "<fixture>";\n```\n\n| Step | State |\n| --- | --- |\n| Read | Done |'} />);
		expect(markup).toContain("<h2>Verification</h2>");
		expect(markup).toContain("<strong>Heading:</strong>");
		expect(markup).toContain("<code>Kestrel local verification</code>");
		expect(markup).toContain("<ul>");
		expect(markup).toContain("&lt;fixture&gt;");
		expect(markup).toContain('aria-label="Answer table"');
		expect(markup).toContain("<th>Step</th>");
	});
	it("does not execute raw HTML, unsafe links or remote image requests", () => {
		const markup = renderToStaticMarkup(<AssistantMessageContent content={'<script>alert("bad")</script>\n\n[Run](javascript:alert%281%29)\n\n![Hidden beacon](https://remote.example.test/beacon)\n\n<img src="https://remote.example.test/html-beacon" onerror="alert(1)">'} />);
		expect(markup).not.toContain("<script");
		expect(markup).not.toContain("<img");
		expect(markup).not.toContain("javascript:");
		expect(markup).not.toContain("remote.example.test");
		expect(markup).toContain("Image: Hidden beacon");
	});
	it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>", "//example.test", "/relative", "https://user:password@example.test", "mailto:user@example.test", "codex://thread"])("rejects %s navigation", url => {
		expect(assistantLinkUrl(url)).toBe("");
	});
	it("retains explicit web URLs and renders protected schemes as text", () => {
		expect(assistantLinkUrl("http://127.0.0.1:4321/page?q=1")).toBe("http://127.0.0.1:4321/page?q=1");
		const markup = renderToStaticMarkup(<AssistantMessageContent content="[Reference](https://example.test/read) and [Local file](file:///private/file)" />);
		expect(markup).toContain('href="https://example.test/read"');
		expect(markup).toContain("<span>Local file</span>");
	});
});
