// Chrome serializes this function into an isolated world in one specific
// document. Keep it self-contained: no page globals, eval, or host bridge.
export function capturePageContext(tabId) {
	const sourceUrl = location.href;
	const pageUrl = (value) => {
		try {
			const url = new URL(value);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
			url.search = ""; url.hash = "";
			return url.href;
		} catch { return; }
	};
	if (!pageUrl(sourceUrl)) throw new Error("Only HTTP(S) user pages can be read.");
	// Redact before any context leaves the worker. Agent Core independently
	// validates and redacts this response again at its own process boundary.
	const text = (value, limit) => String(value ?? "")
		.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted private key]")
		.replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g, "[redacted credential]")
		.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{20,}/gi, "$1[redacted credential]")
		.replace(/\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|password|secret|private[_ -]?key|session[_ -]?cookie|credential)\b(\s*[:=]\s*)(["'`]?)([^\s"'`,;&}]{8,})(\3)/gi, "$1$2[redacted credential]")
		.replace(/\b(?:https?|file|ftp|data|javascript|blob):[^\s<>"'{}[\]]+/gi, (url) => pageUrl(url) || "[redacted URL]")
		.replace(/\s+/g, " ").trim().slice(0, limit);
	const excluded = "input,textarea,select,option,[contenteditable]:not([contenteditable=false]),[data-private],[data-sensitive],[aria-hidden=true],script,style,noscript,template";
	const visible = (element) => {
		if (!element || element.closest(excluded)) return false;
		const style = getComputedStyle(element);
		if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
	};
	const deadline = performance.now() + 250;
	let visited = 0;
	const safeText = (root, maximum) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const parts = []; let length = 0; let node;
		while ((node = walker.nextNode()) && length < maximum && ++visited <= 20_000 && performance.now() < deadline) {
			if (!visible(node.parentElement)) continue;
			const value = node.textContent.slice(0, maximum - length);
			parts.push(value); length += value.length + 1;
		}
		return text(parts.join(" "), maximum);
	};
	// Capture the small structured sections first, sharing the same work budget.
	const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).slice(0, 200)
		.filter(visible).map(node => safeText(node, 500)).filter(Boolean).slice(0, 60);
	const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 500)
		.filter(visible).flatMap(node => {
			const url = pageUrl(node.href);
			return url ? [{ text: safeText(node, 500), url }] : [];
		}).slice(0, 100);
	const fields = Array.from(document.querySelectorAll("input,textarea,select,button,[contenteditable]:not([contenteditable=false])")).slice(0, 500);
	const forms = fields.filter(element => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return !element.closest("[data-private],[data-sensitive],[aria-hidden=true]") && style.display !== "none" && style.visibility === "visible" && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
	}).slice(0, 60).map(element => {
		const type = (element.getAttribute("type") || element.tagName.toLowerCase()).slice(0, 100);
		const hints = [type, element.name, element.id, element.autocomplete, element.getAttribute("aria-label"), element.getAttribute("placeholder")].join(" ");
		if (/password|one[-_ ]?time|\botp\b|recovery|verification|security[-_ ]?code|cvv|cvc|cc-|credit[-_ ]?card|api[-_ ]?key|access[-_ ]?token|private[-_ ]?key/i.test(hints))
			return { label: "Sensitive field", type: "sensitive", name: "" };
		const label = element.labels?.[0] ? safeText(element.labels[0], 500) : element.getAttribute("aria-label") || element.getAttribute("placeholder") || (element.tagName === "BUTTON" ? safeText(element, 500) : "");
		return { label: text(label, 500), type: text(type, 100), name: text(element.name, 500) };
	});
	let selectedText = "";
	const selection = getSelection();
	if (selection?.rangeCount && !document.activeElement?.closest(excluded)) {
		// A selection spanning editable/private content must not reveal its text.
		const privateNodes = document.querySelectorAll(excluded);
		let safe = privateNodes.length <= 1_000 && selection.rangeCount <= 16;
		for (let i = 0; safe && i < selection.rangeCount; ++i) {
			const range = selection.getRangeAt(i);
			for (const node of privateNodes) if (range.intersectsNode(node)) { safe = false; break; }
		}
		if (safe) selectedText = text(selection.toString(), 20_000);
	}
	return { sourceUrl, context: {
		tabId, url: pageUrl(sourceUrl), title: text(document.title, 500) || "Untitled page",
		description: text(document.querySelector('meta[name="description"]')?.content, 2_000),
		selectedText, visibleText: document.body ? safeText(document.body, 40_000) : "",
		headings, links, forms,
		viewport: { width: Math.min(10_000, Math.max(1, Math.round(innerWidth))), height: Math.min(10_000, Math.max(1, Math.round(innerHeight))), scrollX, scrollY },
		capturedAt: new Date().toISOString(), trust: "untrusted_browser",
	} };
}
