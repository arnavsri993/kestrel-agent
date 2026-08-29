import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function scriptJson(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function emptyState() {
	return {
		visits: {},
		activations: {},
		fields: {},
		downloads: {},
		requests: [],
	};
}

function readBody(request, maximumBytes = 64_000) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let bytes = 0;
		request.on("data", (chunk) => {
			bytes += chunk.byteLength;
			if (bytes > maximumBytes) {
				reject(new Error("Benchmark fixture request body is too large."));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function fieldMarkup(field) {
	const required = field.required ? " required" : "";
	const name = escapeHtml(field.name);
	const label = escapeHtml(field.label);
	if (field.kind === "textarea")
		return `<label>${label}<textarea name="${name}"${required}></textarea></label>`;
	if (field.kind === "select") {
		const options = (field.options ?? [])
			.map(
				(option) =>
					`<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
			)
			.join("");
		return `<label>${label}<select name="${name}"${required}>${options}</select></label>`;
	}
	if (field.kind === "checkbox")
		return `<label class="choice"><input type="checkbox" name="${name}" value="true"> ${label}</label>`;
	if (field.kind === "radio") {
		return `<fieldset><legend>${label}</legend>${(field.options ?? [])
			.map(
				(option, index) =>
					`<label class="choice"><input type="radio" name="${name}" value="${escapeHtml(option.value)}"${field.required && index === 0 ? " required" : ""}> ${escapeHtml(option.label)}</label>`,
			)
			.join("")}</fieldset>`;
	}
	if (field.kind === "file")
		return `<label>${label}<input type="file" name="${name}"${required}></label>`;
	return `<label>${label}<input type="text" name="${name}" autocomplete="off"${required}></label>`;
}

function controlMarkup(control) {
	return `<button id="${escapeHtml(control.id)}" type="submit" data-action-id="${escapeHtml(control.id)}"${control.delayMs ? " hidden" : ""}>${escapeHtml(control.label)}</button>`;
}

export class BrowserAgentBenchmarkFixture {
	#servers = new Map();
	#origins = new Map();
	#runs = new Map();

	async start() {
		if (this.#servers.size > 0) return this.origins;
		for (const site of ["primary", "secondary"]) {
			const server = createServer((request, response) => {
				void this.#handle(site, request, response).catch((error) => {
					if (response.headersSent) {
						response.destroy(error);
						return;
					}
					response.writeHead(500, {
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "no-store",
					});
					response.end("Benchmark fixture error.");
				});
			});
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address !== "object")
				throw new Error("Benchmark fixture server address is unavailable.");
			this.#servers.set(site, server);
			this.#origins.set(site, `http://127.0.0.1:${address.port}`);
		}
		return this.origins;
	}

	get origins() {
		return Object.fromEntries(this.#origins);
	}

	registerRun(runId, workflow) {
		if (!/^[a-z0-9-]{3,160}$/.test(runId))
			throw new Error("Benchmark fixture run ID is invalid.");
		if (this.#runs.has(runId))
			throw new Error(`Benchmark fixture run already exists: ${runId}`);
		this.#runs.set(runId, {
			workflow,
			state: emptyState(),
			pageTokens: new Map(),
		});
	}

	state(runId) {
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Unknown benchmark fixture run: ${runId}`);
		return structuredClone(run.state);
	}

	url(runId, site, path) {
		const origin = this.#origins.get(site);
		if (!origin) throw new Error(`Unknown benchmark fixture site: ${site}`);
		if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path))
			throw new Error(`Benchmark fixture path is invalid: ${path}`);
		return `${origin}/runs/${encodeURIComponent(runId)}${path}`;
	}

	async close() {
		await Promise.all(
			[...this.#servers.values()].map(
				(server) =>
					new Promise((resolve) => {
						server.closeAllConnections?.();
						server.close(() => resolve());
					}),
			),
		);
		this.#servers.clear();
		this.#origins.clear();
		this.#runs.clear();
	}

	async #handle(site, request, response) {
		const base = this.#origins.get(site) ?? "http://127.0.0.1";
		const url = new URL(request.url ?? "/", base);
		const match = url.pathname.match(/^\/runs\/([^/]+)(\/.*)$/);
		if (!match) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Not found.");
			return;
		}
		const runId = decodeURIComponent(match[1]);
		const fixturePath = match[2];
		const run = this.#runs.get(runId);
		if (!run) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Unknown fixture run.");
			return;
		}
		if (fixturePath === "/__state" && request.method === "POST") {
			const payload = JSON.parse(await readBody(request));
			if (
				!payload ||
				typeof payload !== "object" ||
				typeof payload.pagePath !== "string" ||
				typeof payload.pageToken !== "string" ||
				payload.pageToken.length > 64 ||
				typeof payload.actionId !== "string" ||
				payload.actionId.length > 100 ||
				!payload.fields ||
				typeof payload.fields !== "object" ||
				Array.isArray(payload.fields)
			)
				throw new Error("Benchmark fixture state payload is invalid.");
			const expectedPageUrl = this.url(runId, site, payload.pagePath);
			const tokenPage = run.pageTokens.get(payload.pageToken);
			if (
				request.headers.origin !== this.#origins.get(site) ||
				request.headers.referer !== expectedPageUrl ||
				!tokenPage ||
				tokenPage.site !== site ||
				tokenPage.path !== payload.pagePath
			)
				throw new Error("Benchmark fixture page binding is invalid.");
			const sourcePage = run.workflow.pages.find(
				(page) => page.site === site && page.path === payload.pagePath,
			);
			if (
				!sourcePage ||
				!(sourcePage.controls ?? []).some(
					(control) => control.id === payload.actionId,
				)
			)
				throw new Error("Benchmark fixture action is not declared on its page.");
			const declaredFields = new Set(
				(sourcePage.fields ?? []).map((field) => field.name),
			);
			for (const [name, value] of Object.entries(payload.fields)) {
				if (
					!declaredFields.has(name) ||
					name.length > 100 ||
					!(
						typeof value === "string" ||
						typeof value === "boolean" ||
						typeof value === "number"
					)
				)
					throw new Error("Benchmark fixture field is not declared on its page.");
			}
			run.pageTokens.delete(payload.pageToken);
			run.state.activations[payload.actionId] =
				(run.state.activations[payload.actionId] ?? 0) + 1;
			for (const [name, value] of Object.entries(payload.fields)) {
				run.state.fields[name] = value;
			}
			run.state.requests.push({ kind: "activation", site, id: payload.actionId });
			if (run.state.requests.length > 500) run.state.requests.shift();
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			});
			response.end('{"ok":true}');
			return;
		}
		if (fixturePath.startsWith("/__download/") && request.method === "GET") {
			const filename = decodeURIComponent(fixturePath.slice("/__download/".length));
			const download = run.workflow.pages
				.flatMap((page) => page.downloads ?? [])
				.find((candidate) => candidate.filename === filename);
			if (!download) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				response.end("Unknown download.");
				return;
			}
			const body = Buffer.from(download.content ?? "Fixture download\n", "utf8");
			run.state.downloads[filename] =
				(run.state.downloads[filename] ?? 0) + 1;
			response.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": String(body.byteLength),
				"content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
				"cache-control": "no-store",
			});
			response.end(body);
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { allow: "GET, POST" });
			response.end();
			return;
		}
		const page = run.workflow.pages.find(
			(candidate) => candidate.site === site && candidate.path === fixturePath,
		);
		if (!page) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Unknown fixture page.");
			return;
		}
		const visitKey = `${site}:${fixturePath}`;
		run.state.visits[visitKey] = (run.state.visits[visitKey] ?? 0) + 1;
		run.state.requests.push({ kind: "visit", site, path: fixturePath });
		if (page.redirectTo) {
			response.writeHead(302, {
				location: this.url(runId, page.redirectTo.site, page.redirectTo.path),
				"cache-control": "no-store",
			});
			response.end();
			return;
		}
		const cookie = request.headers.cookie ?? "";
		const authorized =
			!page.requiresCookie ||
			cookie
				.split(";")
				.map((value) => value.trim())
				.includes(page.requiresCookie);
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'",
		});
		response.end(
			authorized
					? this.#renderPage(runId, page, run)
				: this.#renderExpiredPage(page.title),
		);
	}

	#renderExpiredPage(title) {
		return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>Session expired</h1><p>The local fixture requires an authentication handoff.</p></main></body></html>`;
	}

	#renderPage(runId, page, run) {
		const pageToken = randomBytes(24).toString("base64url");
		if (run.pageTokens.size >= 256)
			run.pageTokens.delete(run.pageTokens.keys().next().value);
		run.pageTokens.set(pageToken, { site: page.site, path: page.path });
		const controls = page.controls ?? [];
		const controlConfiguration = Object.fromEntries(
			controls.map((control) => [
				control.id,
				{
					kind: control.kind,
					resultText: control.resultText ?? "Action recorded",
					...(control.navigate
						? {
							navigateUrl: this.url(
								runId,
								control.navigate.site,
								control.navigate.path,
							),
						}
						: {}),
					...(control.popup
						? {
							popupUrl: this.url(
								runId,
								control.popup.site,
								control.popup.path,
							),
						}
						: {}),
					...(control.cookie ? { cookie: control.cookie } : {}),
					...(control.clearCookie
						? { clearCookie: control.clearCookie }
						: {}),
				},
			]),
		);
		const delayConfiguration = Object.fromEntries(
			controls
				.filter((control) => control.delayMs)
				.map((control) => [control.id, control.delayMs]),
		);
		const links = (page.links ?? [])
			.map(
				(link) =>
					`<li><a href="${escapeHtml(this.url(runId, link.site, link.path))}">${escapeHtml(link.label)}</a></li>`,
			)
			.join("");
		const downloads = (page.downloads ?? [])
			.map(
				(download) =>
					`<li><a href="${escapeHtml(this.url(runId, page.site, `/__download/${encodeURIComponent(download.filename)}`))}">${escapeHtml(download.label)}</a></li>`,
			)
			.join("");
		const modal = page.modal
			? `<dialog id="fixture-modal"><h2>${escapeHtml(page.modal.heading)}</h2><p>${escapeHtml(page.modal.text)}</p><button type="button" id="dismiss-modal">${escapeHtml(page.modal.dismissLabel)}</button></dialog>`
			: "";
		return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)}</title>
  <style>
    :root { color-scheme: light; font: 16px/1.45 system-ui, sans-serif; }
    body { margin: 0; color: #171717; background: #fafafa; }
    main { width: min(760px, calc(100% - 48px)); margin: 32px auto; padding: 28px; background: white; border: 1px solid #d8d8d8; border-radius: 12px; }
    h1 { margin-top: 0; }
    form { display: grid; gap: 16px; margin-top: 20px; }
    label:not(.choice), fieldset { display: grid; gap: 6px; }
    input, textarea, select, button { font: inherit; }
    input, textarea, select { padding: 9px 10px; border: 1px solid #888; border-radius: 6px; }
    textarea { min-height: 96px; }
    button { width: fit-content; padding: 9px 14px; border: 1px solid #555; border-radius: 6px; background: #f5f5f5; }
    output { min-height: 24px; font-weight: 600; }
    dialog[open] { position: fixed; inset: 0; width: min(420px, calc(100% - 48px)); margin: auto; padding: 28px; border: 2px solid #333; border-radius: 10px; background: white; z-index: 1000; }
    dialog[open]::backdrop { background: rgba(0,0,0,.4); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.heading)}</h1>
    ${(page.text ?? []).map((text) => `<p>${escapeHtml(text)}</p>`).join("")}
    ${links ? `<nav aria-label="Fixture sources"><ul>${links}</ul></nav>` : ""}
    ${downloads ? `<section aria-label="Fixture downloads"><ul>${downloads}</ul></section>` : ""}
    <form id="fixture-form">
      ${(page.fields ?? []).map(fieldMarkup).join("")}
      <div>${controls.map(controlMarkup).join(" ")}</div>
      <output id="fixture-result" aria-live="polite"></output>
    </form>
  </main>
  ${modal}
  <script>
    const controls = ${scriptJson(controlConfiguration)};
	    const delays = ${scriptJson(delayConfiguration)};
	    const stateEndpoint = ${scriptJson(this.url(runId, page.site, "/__state"))};
	    const pageToken = ${scriptJson(pageToken)};
    const form = document.querySelector("#fixture-form");
    const result = document.querySelector("#fixture-result");
    function fields() {
      const values = {};
      for (const field of form.elements) {
        if (!field.name) continue;
        if (field.type === "checkbox") values[field.name] = field.checked;
        else if (field.type === "radio") {
          if (field.checked) values[field.name] = field.value;
        } else if (field.type === "file") {
          values[field.name] = field.files?.[0]?.name ?? "";
        } else values[field.name] = field.value;
      }
      return values;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const actionId = event.submitter?.dataset.actionId;
      const config = controls[actionId];
      if (!actionId || !config) return;
      const response = await fetch(stateEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
		body: JSON.stringify({ pagePath: ${scriptJson(page.path)}, pageToken, actionId, fields: fields() }),
      });
      if (!response.ok) throw new Error("Fixture state write failed.");
      if (config.cookie) document.cookie = config.cookie + "; Path=/; SameSite=Lax";
      if (config.clearCookie) document.cookie = config.clearCookie + "=; Path=/; Max-Age=0; SameSite=Lax";
      result.textContent = config.resultText;
      if (config.popupUrl) window.open(config.popupUrl, "_blank", "noopener");
      if (config.navigateUrl) location.assign(config.navigateUrl);
    });
    for (const [actionId, delay] of Object.entries(delays)) {
      setTimeout(() => {
        const node = document.querySelector('[data-action-id="' + CSS.escape(actionId) + '"]');
        if (node) node.hidden = false;
      }, delay);
    }
    document.querySelector("#dismiss-modal")?.addEventListener("click", () => {
      document.querySelector("#fixture-modal")?.close();
    });
    document.querySelector("#fixture-modal")?.showModal();
  </script>
</body>
</html>`;
	}
}
