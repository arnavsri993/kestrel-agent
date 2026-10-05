import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { KESTREL_APP_PAGES } from "../apps/desktop/src/utility/browser-app-pages";
import { SETTINGS_SECTIONS } from "../apps/desktop/src/renderer/settings-catalog";
import { revealNewTabControl, selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

// Evidence and profile are fresh, bounded fixtures. Never erase an output path
// supplied by the caller, and never attach to the person's running profile.
const fixture = mkdtempSync(join(tmpdir(), "kestrel-release-surfaces-"));
const evidence = resolve(".tmp", "release-surfaces", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(evidence, { recursive: true });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const application = await electron.launch({
  executablePath: packaged ? resolve(packaged) : requireFromDesktop("electron"),
  args: [...(packaged ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
  env: {
    ...process.env,
    KESTREL_TEST_USER_DATA: join(fixture, "profile"),
    KESTREL_DISABLE_UPDATES: "1",
    KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
    KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
    KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
  },
});
const page = await application.firstWindow();
page.setDefaultTimeout(12_000);
await page.setViewportSize({ width: 1024, height: 684 });
const specialistTargets = [];
const results: Array<{ id: string; viewport: string; status: string; file?: string; error?: string }> = [];
const pageErrors: string[] = [];
const lifecycle: string[] = [];
application.process().stderr?.on("data", data => lifecycle.push(String(data)));
application.process().on("exit", (code, signal) => lifecycle.push(`process exit: ${code}, signal: ${signal}`));
page.on("crash", () => lifecycle.push("renderer crash"));
page.on("close", () => lifecycle.push("window closed"));
page.on("pageerror", error => pageErrors.push(error.message));

async function assertReadableSurface(id: string) {
	const surface = page.locator(".browser-app-page").last();
	const layout = await surface.evaluate(element => {
		const rect = element.getBoundingClientRect();
		const headings = [...element.querySelectorAll("h1, h2")]
			.filter(item => item.getClientRects().length > 0)
			.map(item => {
				const box = item.getBoundingClientRect();
				const parent = item.parentElement;
				const parentBox = parent?.getBoundingClientRect();
				return {
					text: item.textContent?.trim() ?? "",
					left: box.left,
					right: box.right,
					parentLeft: parentBox?.left ?? box.left,
					parentRight: parentBox?.right ?? box.right,
					parentClientWidth: parent?.clientWidth ?? box.width,
					parentScrollWidth: parent?.scrollWidth ?? box.width,
				};
			});
		return { width: rect.width, height: rect.height, headings };
	});
	assert(layout.width >= 220 && layout.height >= 160, `${id} main surface is too small (${layout.width}x${layout.height})`);
	assert(layout.headings.some(item => item.text.length > 0), `${id} has no visible heading`);
	for (const heading of layout.headings) {
		assert(heading.right <= heading.parentRight + 1 && heading.left >= heading.parentLeft - 1,
			`${id} heading “${heading.text}” is clipped by its immediate layout parent`);
		assert(heading.parentScrollWidth <= heading.parentClientWidth + 2,
			`${id} heading “${heading.text}” sits in a horizontally overflowing layout row (${heading.parentScrollWidth}/${heading.parentClientWidth})`);
	}
}

async function audit(id: string, viewport: string, action: () => Promise<void>) {
  try {
    await action();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		assert(overflow <= 1, `${id} causes ${overflow}px of document overflow`);
		if (id.startsWith("page-") || id.startsWith("settings-") || id.startsWith("menu-destination-")) await assertReadableSurface(id);
    if (id.startsWith("menu-") && !id.startsWith("menu-destination-") && await page.locator(".browser-toolbar-popover").count()) {
      await page.waitForFunction(() => {
        const menu = document.querySelector(".browser-toolbar-popover");
        return menu && getComputedStyle(menu).opacity === "1";
      });
      const menu = await page.locator(".browser-toolbar-popover").evaluate(element => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          background: getComputedStyle(element).backgroundColor,
          toolbarFilter: getComputedStyle(document.querySelector(".browser-toolbar")!).backdropFilter,
          width: innerWidth, height: innerHeight };
      });
      assert(menu.top >= 0 && menu.left >= 0 && menu.bottom <= menu.height + 1 && menu.right <= menu.width + 1, `${id} extends outside the window`);
      assert.equal(menu.toolbarFilter, "none", `${id} has a filtered positioning ancestor`);
      assert(!menu.background.includes("rgba(") && !menu.background.includes(" / "), `${id} must remain opaque over page content`);
    }
    await page.screenshot({ path: join(evidence, `${viewport}-${id}.png`) });
    results.push({ id, viewport, status: "passed", file: `${viewport}-${id}.png` });
  } catch (error) {
    await page.screenshot({ path: join(evidence, `${viewport}-${id}-failure.png`) }).catch(() => {});
    results.push({ id, viewport, status: "failed", error: error instanceof Error ? error.message : String(error) });
    if (page.isClosed()) throw error;
  }
}

async function navigate(id: string) {
	// Creating an agent opens its conversation. At compact widths that modal
	// hides the browser toolbar, so close it before trying to use the address.
	const compactClose = page.locator(".agent-sidebar").getByRole("button", { name: "Close chat", exact: true });
	const chatToggle = page.locator("#browser-agent-toggle");
	if (await compactClose.isVisible().catch(() => false)) {
		await compactClose.click();
		await expect(chatToggle).toHaveAttribute("aria-expanded", "false");
	} else if (await chatToggle.isVisible().catch(() => false) && await chatToggle.getAttribute("aria-expanded") === "true") {
		await chatToggle.click();
	}
  const address = page.locator("#browser-address-input");
  const targetUrl = `kestrel://${id}`;
  await address.fill(targetUrl);
  assert.equal(await address.inputValue(), targetUrl, `${id} address text was changed before submit`);
  // Clear any inline autocomplete selection so Enter submits the route visibly
  // present in the field, rather than the prior URL's completion state.
  await address.press("Escape");
  assert.equal(await address.inputValue(), targetUrl, `${id} address text changed while dismissing suggestions`);
  await address.press("Enter");
  const destination = page.locator(`.browser-app-page[data-app-page="${id}"]`);
  await destination.waitFor();
  // Wait for the previous page's exit transition to finish, so controls belong
  // to the destination being audited rather than an outgoing page.
		await page.waitForFunction(() => document.querySelectorAll(".browser-app-page").length === 1);
}

async function openToolbarMenu(label: string) {
	const toolbar = page.locator(".browser-toolbar");
	// Tab tools belongs to the tab strip; the other menus belong to the toolbar.
	const trigger = (label === "Tab tools" ? page : toolbar).getByRole("button", { name: label, exact: true });
	if (await trigger.isVisible()) {
		await trigger.click();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
	} else {
		await toolbar.getByRole("button", { name: "Browser menu", exact: true }).click();
		await page.getByRole("menuitem", { name: label, exact: true }).click();
		await page.getByRole("menu", { name: label, exact: true }).waitFor();
	}
}

try {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
		// Keep the conversation dock from stealing compact destination-page width.
		localStorage.setItem("kestrel:agent-sidebar", "collapsed");
  });
  // Owned-fixture failure injection applies only to session-list reads.
  await application.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers?.get("kestrel:request");
    if (typeof original !== "function") throw new Error("Cannot inspect owned request handler");
    const fixture = { fail: true, failures: 0 };
    globalThis.__ownedSessionListFailure = fixture;
    ipcMain.removeHandler("kestrel:request");
    ipcMain.handle("kestrel:request", (event, request) => {
      if (request.type === "runtime-list-sessions" && fixture.fail) {
        fixture.failures += 1;
        return { ok: false, error: "Owned session-list failure." };
      }
      return original(event, request);
    });
  });
  await page.reload();
  await page.locator("#browser-address-input").waitFor();
  await navigate("agent");
  for (const size of [{name:"desktop",width:1440,height:900},{name:"compact",width:800,height:660}]) {
    await page.setViewportSize(size);
    await audit("agent-initial-load-failure",size.name,async()=>{
      const alert=page.locator(".agent-universe-state-message[role=alert]");
      await expect(alert).toContainText("Agent systems could not be loaded");
      const retry=alert.getByRole("button",{name:"Try again",exact:true});
      await retry.focus(); await expect(retry).toBeFocused();
      const bounds=await retry.boundingBox(); assert(bounds && bounds.x>=0 && bounds.x+bounds.width<=size.width+1);
    });
  }
  await application.evaluate(()=>{globalThis.__ownedSessionListFailure.fail=false;});
  await page.locator(".agent-universe-state-message").getByRole("button",{name:"Try again",exact:true}).press("Enter");
  await expect(page.locator(".agent-universe-state-message.is-error")).toHaveCount(0);
  await page.getByRole("heading",{name:"No agents yet",exact:true}).waitFor();
  await page.setViewportSize({width:1024,height:684});
  await page.emulateMedia({ reducedMotion: "reduce" });

	// Seed one persistent agent through the supported UI flow so list/search/map,
	// settings, and populated Memory states are exercised without provider auth.
	await navigate("agent");
	const agentName = "Release audit fixture";
	if (!(await page.getByRole("button", { name: `Open settings for ${agentName}`, exact: true }).count())) {
		await audit("agent-create-dialog", "desktop", async () => {
			await page.getByRole("button", { name: "New agent", exact: true }).click();
			await page.getByRole("dialog", { name: "Create persistent agent" }).waitFor();
		});
		const create = page.getByRole("dialog", { name: "Create persistent agent" });
		await create.locator("input").fill(agentName);
		await create.getByRole("button", { name: "Create agent", exact: true }).click();
		await expect(create).not.toBeVisible();
		await navigate("agent");
		await page.getByRole("button", { name: `Open settings for ${agentName}`, exact: true }).waitFor();
	}
  await application.evaluate(()=>{globalThis.__ownedSessionListFailure.fail=true;});
  const refreshTrigger=await page.evaluate(()=>window.kestrel.request({type:"runtime-create-session",title:"Owned refresh trigger"}));
  assert(refreshTrigger.ok);
  for (const size of [{name:"desktop",width:1440,height:900},{name:"compact",width:800,height:660}]) {
    await page.setViewportSize(size);
    await audit("agent-stale-list-retry",size.name,async()=>{
      const notice=page.locator(".agent-universe-session-notice[role=status]");
      await expect(notice).toContainText("Showing the last known map.");
      await expect(page.getByRole("button",{name:`Open settings for ${agentName}`,exact:true})).toBeVisible();
      const retry=notice.getByRole("button",{name:"Retry",exact:true}); await retry.focus(); await expect(retry).toBeFocused();
      const bounds=await retry.boundingBox(); assert(bounds && bounds.x>=0 && bounds.x+bounds.width<=size.width+1);
      assert(bounds.height >= 40, "Retry keeps a usable pointer target");
      const geometry = await notice.evaluate(element => {
        const box = element.getBoundingClientRect();
        const header = document.querySelector(".agent-universe-mapbar");
        const controls = [...header.querySelectorAll("button, input, summary")].filter(control => !element.contains(control) && control.checkVisibility());
        const overlaps = controls.filter(control => { const other = control.getBoundingClientRect(); return box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom; }).map(control => control.getAttribute("aria-label") ?? control.textContent);
        return {overlaps, noticeBottom: box.bottom, listTop: document.querySelector(".agent-workspace-list").getBoundingClientRect().top};
      });
      assert.deepEqual(geometry.overlaps, [], "Session notice cannot cover Agent navigation or search");
      assert(geometry.listTop >= geometry.noticeBottom - 1, "Retained agents begin below the session notice");
    });
  }
  await application.evaluate(()=>{globalThis.__ownedSessionListFailure.fail=false;});
  await page.locator(".agent-universe-session-notice").getByRole("button",{name:"Retry",exact:true}).press("Enter");
  await expect(page.locator(".agent-universe-session-notice")).toHaveCount(0);
  await expect(page.getByRole("button",{name:`Open settings for ${agentName}`,exact:true})).toBeVisible();
  await page.setViewportSize({width:1024,height:684});
	const memorySeed = await page.evaluate(async () => {
		const now = new Date().toISOString();
		return window.kestrel.request({ type: "memory-document-save", document: {
			viewerId: "user", kind: "memory", title: "Release audit fixture note",
			text: "Synthetic note for release surface rendering and edit-state review.",
			tier: "mid_term", domainIds: [], sharing: "owner_only", sourceIds: [],
			confidence: 1, confirmation: "confirmed", sensitivity: "personal", passages: [], origin: "manual",
		} });
	});
	if (!memorySeed.ok || !memorySeed.memoryDocument?.id) throw new Error("Could not seed the isolated Memory fixture.");
	const activitySeed = await page.evaluate(async () => {
		const created = await window.kestrel.request({ type: "runtime-create-session", title: "Release Activity fixture" });
		if (!created.ok || !created.session) throw new Error("Could not create the isolated Activity fixture.");
		const result = await window.kestrel.request({ type: "runtime-call-tool", sessionId: created.session.id,
			toolName: "tools.search", input: { query: "browser" } });
		if (!result.ok || result.execution?.status !== "verified") throw new Error("Could not seed a verified Activity result.");
		return { executionId: result.execution.id, sessionId: created.session.id };
	});

	await page.setViewportSize({ width: 1320, height: 860 });
	await audit("agent-header-with-navigation-and-chat", "desktop-split", async () => {
		await navigate("agent");
		const expandNavigation = page.getByRole("button", { name: "Expand sidebar", exact: true });
		if (await expandNavigation.isVisible()) await expandNavigation.click();
		const toggle = page.locator("#browser-agent-toggle");
		await toggle.click();
		await page.waitForFunction(() => {
			const workspace = document.querySelector(".agent-universe-workspace");
			return workspace && workspace.getBoundingClientRect().width < 700 && !document.querySelector(".agent-sidebar-settling");
		});
			const bounds = await page.locator(".agent-universe-mapbar").evaluate(header => {
				const root = header.closest(".agent-universe-workspace")!.getBoundingClientRect();
				const controls = [...header.querySelectorAll<HTMLElement>("button, input, summary")].filter(element => element.checkVisibility()).map(element => ({ label: element.getAttribute("aria-label") ?? element.textContent, rect: element.getBoundingClientRect().toJSON() }));
				return { root: root.toJSON(), controls, header: header.getBoundingClientRect().toJSON(), list: header.parentElement!.querySelector(".agent-workspace-list")!.getBoundingClientRect().toJSON() };
			});
			for (const { label, rect } of bounds.controls) {
				assert(rect.x >= bounds.root.x - 1 && rect.right <= bounds.root.right + 1, `${label} escapes the Agent workspace`);
			}
			for (let i = 0; i < bounds.controls.length; i++) for (let j = i + 1; j < bounds.controls.length; j++) {
				const a = bounds.controls[i]!, b = bounds.controls[j]!;
				assert(!(a.rect.x < b.rect.right - 1 && b.rect.x < a.rect.right - 1 && a.rect.y < b.rect.bottom - 1 && b.rect.y < a.rect.bottom - 1), `${a.label} overlaps ${b.label}`);
			}
			assert(bounds.list.y >= bounds.header.bottom - 1, "Agent list is covered by its header");
			assert(bounds.header.height <= 116, "Agent header must stay in two rows with navigation and Chat open");
			writeFileSync(join(evidence, "desktop-split-agent-header-geometry.json"), JSON.stringify(bounds, null, 2));
	});
	if (await page.locator("#browser-agent-toggle").getAttribute("aria-expanded") === "true") await page.locator("#browser-agent-toggle").click();

  for (const size of [{ name: "desktop", width: 1440, height: 900 }, { name: "compact", width: 800, height: 660 }]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const id of Object.keys(KESTREL_APP_PAGES)) {
      await audit(`page-${id}`, size.name, async () => {
        await navigate(id);
        const content = await page.locator(`.browser-app-page[data-app-page="${id}"]`).innerText();
        assert(content.trim().length > 0, `${id} rendered no readable content`);
      });
    }
		const activity = page.locator(`#activity-item-${activitySeed.executionId}`);
		await audit("activity-result-collapsed", size.name, async () => {
			await navigate("activity");
			await expect(activity.locator("strong")).toHaveText("Find a tool");
			await expect(activity.locator(".activity-status")).toHaveText("Verified");
			assert.equal(await activity.locator("details").evaluate(node => node.open), false);
			await expect(activity.getByText(activitySeed.sessionId, { exact: true })).not.toBeVisible();
		});
		await audit("activity-result-details", size.name, async () => {
			const summary = activity.locator("summary");
			await summary.focus();
			await summary.press("Enter");
			assert.equal(await activity.locator("details").evaluate(node => node.open), true);
			await expect(activity.getByText(activitySeed.sessionId, { exact: true })).toBeVisible();
			await expect(activity.getByText("tools.search", { exact: true })).toBeVisible();
		});
		await activity.locator("summary").press("Space");
		assert.equal(await activity.locator("details").evaluate(node => node.open), false);
		for (const [id, selector, field] of [
			["source-text", ".writing-draft-disclosure:first-of-type", /^Starting text/],
			["draft-options", ".writing-draft-disclosure:last-of-type", /^Tone/],
			["voice-profile", ".writing-profile-panel", /Use my voice profile/],
		] as const) {
			await audit(`writing-${id}`, size.name, async () => {
				await navigate("writing");
				const disclosure = page.locator(selector);
				if (!(await disclosure.evaluate(element => (element as HTMLDetailsElement).open))) {
					await disclosure.locator("summary").focus();
					await page.keyboard.press("Enter");
				}
				await page.getByLabel(field).waitFor({ state: "visible" });
			});
			const disclosure = page.locator(selector);
			if (await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) {
				await disclosure.locator("summary").focus();
				await page.keyboard.press("Enter");
			}
		}
		await audit("agent-search-empty", size.name, async () => {
			await navigate("agent");
			const search = page.getByRole("searchbox", { name: "Find a system or task" });
			await search.fill("no-such-release-audit-fixture");
			await search.press("Enter");
			await page.getByRole("heading", { name: "No matching agents or tasks", exact: true }).waitFor();
		});
		await audit("agent-list-search", size.name, async () => {
			await navigate("agent");
			const search = page.getByRole("searchbox", { name: "Find a system or task" });
			await search.fill("no-such-release-audit-fixture");
			await search.press("Enter");
			await page.getByRole("button", { name: "Clear search", exact: true }).click();
			await search.fill("Release audit");
			await search.press("Enter");
			await page.locator(".agent-workspace-list").waitFor();
			assert((await page.locator(".agent-workspace-list").innerText()).includes("Release audit fixture"));
		});
		await audit("agent-map", size.name, async () => {
			const workspaceView = page.getByRole("group", { name: "Agent workspace view" });
			await workspaceView.getByRole("button", { name: "Map", exact: true }).click();
			assert.equal(await workspaceView.getByRole("button", { name: "Map", exact: true }).getAttribute("aria-pressed"), "true");
			await page.locator(".agent-universe-context-surface").waitFor();
			await page.waitForFunction(() => {
				const header = document.querySelector(".agent-universe-mapbar")!.getBoundingClientRect();
				const panel = document.querySelector(".agent-universe-context-surface")!.getBoundingClientRect();
				const root = document.querySelector(".agent-universe-workspace")!.getBoundingClientRect();
				return panel.top >= header.bottom + 4 && panel.bottom <= root.bottom - 4;
			});
			const panel = page.locator(".agent-universe-context-surface");
			assert(await panel.locator(".agent-universe-context-header").evaluate(element => {
				const bounds = element.getBoundingClientRect(), panel = element.closest(".agent-universe-context-surface")!.getBoundingClientRect();
				return bounds.top >= panel.top && bounds.bottom <= panel.bottom;
			}), "The selected agent title must remain visible below the Map header");
			assert(await panel.locator(".agent-universe-context-composer").evaluate(element => {
				const bounds = element.getBoundingClientRect(), panel = element.closest(".agent-universe-context-surface")!.getBoundingClientRect();
				return bounds.top >= panel.top && bounds.bottom <= panel.bottom;
			}), "The selected agent message field must remain inside its panel");
		});
		await page.getByRole("group", { name: "Agent workspace view" }).getByRole("button", { name: "List", exact: true }).click();
		await audit("agent-secondary-options", size.name, async () => {
			const more = page.locator(".agent-workspace-options > summary");
			await more.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("group", { name: "Agent options", exact: true }).waitFor();
		});
		await page.keyboard.press("Escape");
		if (size.name === "compact") {
			const toggle = page.locator("#browser-agent-toggle");
			const chat = page.locator(".agent-sidebar");
			await audit("compact-chat-overlay", size.name, async () => {
				await toggle.click();
				assert.equal(await chat.getAttribute("aria-modal"), "true");
				assert.equal(await chat.getAttribute("aria-hidden"), "false");
				assert.equal(await page.locator(".browser-main-plane").evaluate(element => getComputedStyle(element).visibility), "hidden");
				assert.equal(await page.locator(".agent-compact-dock").evaluate(element => getComputedStyle(element).display), "none");
				assert.equal(await chat.evaluate(element => element.contains(document.activeElement)), true, "Opening compact chat moves focus inside its modal");
			});
			await audit("compact-chat-escape", size.name, async () => {
				try {
					await page.keyboard.press("Escape");
					assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Escape closes compact chat overlay");
					assert.equal(await toggle.evaluate(element => element === document.activeElement), true, "Focus returns to compact chat trigger");
				} finally {
					if (await toggle.getAttribute("aria-expanded") === "true") await chat.getByRole("button", { name: "Close chat", exact: true }).click();
				}
			});
		}
		await audit("agent-settings-dialog", size.name, async () => {
			await page.getByRole("button", { name: `Open settings for Release audit fixture`, exact: true }).click();
			await page.getByRole("dialog", { name: "Release audit fixture settings" }).waitFor();
		});
		const settings = page.getByRole("dialog", { name: "Release audit fixture settings" });
		await audit("agent-add-specialist-form", size.name, async () => {
			await settings.getByText("Add specialist", { exact: true }).first().click();
			await settings.locator("details[open] input[name='name']").waitFor();
      const target = await settings.getByRole("button", {name:"Add specialist",exact:true}).evaluate(el => ({label:el.textContent, height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width}));
      assert(target.height >= 40); specialistTargets.push({viewport:size.name,...target});
		});
		if (size.name === "desktop") {
			const addForm = settings.locator("details[open] form");
			await addForm.getByLabel("Name", { exact: true }).fill("Release audit specialist");
			await addForm.getByLabel("Purpose", { exact: true }).fill("Review synthetic release evidence only.");
			await addForm.getByRole("button", { name: "Add specialist", exact: true }).click();
			await settings.getByText("Release audit specialist", { exact: true }).waitFor();
		}
		await audit("agent-specialist-editor", size.name, async () => {
			await settings.locator("summary").filter({ hasText: /^Release audit specialist/ }).click();
			await settings.locator("details[open]").filter({ has: page.getByRole("button", { name: "Archive specialist", exact: true }) }).getByLabel("Purpose", { exact: true }).waitFor();
		});
		await settings.getByRole("button", { name: "Archive specialist", exact: true }).click();
		await audit("agent-archived-specialists", size.name, async () => {
			await settings.getByText("Archived specialists", { exact: true }).click();
			await settings.getByRole("button", { name: "Restore Release audit specialist", exact: true }).waitFor();
      const target = await settings.getByRole("button", {name:"Restore Release audit specialist",exact:true}).evaluate(el => ({label:el.textContent,height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width}));
      assert(target.height >= 40); specialistTargets.push({viewport:size.name,...target});
		});
		await settings.getByRole("button", { name: "Restore Release audit specialist", exact: true }).click();
		await settings.getByText("Release audit specialist · disabled", { exact: true }).waitFor();
		await page.getByRole("dialog", { name: "Release audit fixture settings" }).getByRole("button", { name: "Close", exact: true }).click();
		for (const [key, label] of [["timeline", "Recent activity"], ["people", "People"]] as const) {
			await audit(`memory-${key}`, size.name, async () => {
				await navigate("memory");
				await page.getByRole("button", { name: label, exact: true }).click();
				assert((await page.locator(".browser-app-page").last().innerText()).includes(label));
			});
		}
		for (const [key, value] of [["summary", "overview"], ["reference-knowledge", "knowledge"], ["tools-settings", "tools"]] as const) {
			await audit(`memory-${key}`, size.name, async () => {
				await navigate("memory");
				await page.getByLabel("More memory views", { exact: true }).selectOption(value);
				assert((await page.locator(".browser-app-page").last().innerText()).trim().length > 0);
			});
		}
		for (const label of ["Knowledge", "Work history", "Sources", "People", "Calendar", "Recovery"] as const) {
			await audit(`memory-agent-history-${label.toLowerCase().replaceAll(" ", "-")}`, size.name, async () => {
				await navigate("memory");
				const filters = page.locator(".memory-workspace-header .memory-filters-disclosure");
				if (!(await filters.evaluate(element => (element as HTMLDetailsElement).open))) await filters.locator("summary").click();
				await page.getByLabel("Viewing as", { exact: true }).selectOption({ label: agentName });
				await page.getByLabel("More memory views", { exact: true }).selectOption("agent-history");
				const history = page.getByRole("region", { name: "Scoped agent memory", exact: true });
				await history.getByRole("heading", { name: `${agentName} history`, exact: true }).waitFor();
				await expect(page.getByLabel("Domain", { exact: true })).toBeDisabled();
				if (label === "Recovery") {
					await history.getByRole("navigation", { name: "Agent memory views" }).getByRole("button", { name: "Knowledge", exact: true }).click();
					await history.getByText("Knowledge backup and recovery", { exact: true }).click();
					await history.getByRole("button", { name: "Preview recovery", exact: true }).waitFor();
					await history.getByRole("button", { name: "Preview recovery", exact: true }).scrollIntoViewIfNeeded();
				} else {
					const tab = history.getByRole("navigation", { name: "Agent memory views" }).getByRole("button", { name: label, exact: true });
					await tab.click();
					await expect(tab).toHaveAttribute("aria-current", "page");
				}
				await assertReadableSurface(`memory-agent-history-${label}`);
			});
		}
		await navigate("memory");
		const historyFilters = page.locator(".memory-workspace-header .memory-filters-disclosure");
		if (!(await historyFilters.evaluate(element => (element as HTMLDetailsElement).open))) await historyFilters.locator("summary").click();
		await page.getByLabel("Viewing as", { exact: true }).selectOption("user");
		await expect(page.locator(".scoped-agent-memory")).toHaveCount(0);
		await historyFilters.locator("summary").click();
		await audit("memory-note-details", size.name, async () => {
			await navigate("memory");
			await page.getByRole("button", { name: "Notes", exact: true }).click();
			await page.getByRole("button", { name: /Release audit fixture note/ }).click();
			await page.getByRole("heading", { name: "Release audit fixture note", exact: true }).waitFor();
			await page.getByText("Evidence and visibility", { exact: true }).click();
		});
		await audit("memory-note-editor", size.name, async () => {
			await navigate("memory");
			await page.getByRole("button", { name: "Notes", exact: true }).click();
			await page.getByRole("button", { name: /Release audit fixture note/ }).click();
			await page.getByRole("button", { name: "Edit note", exact: true }).click();
			assert.equal(await page.getByLabel("Title (optional)", { exact: true }).inputValue(), "Release audit fixture note");
		});
		await navigate("agent");
		await page.locator(".agent-workspace-options > summary").click();
		await page.getByRole("button", { name: "All work", exact: true }).click();
		await page.locator('.browser-app-page[data-app-page="work"]').waitFor();
		for (const label of ["Goals", "Schedules", "Delegation", "Teams"] as const) {
			await audit(`work-${label.toLowerCase()}`, size.name, async () => {
				await page.getByRole("button", { name: label, exact: true }).click();
				assert((await page.locator('.browser-app-page[data-app-page="work"]').innerText()).trim().length > 0);
			});
		}
		// Review deeper Connections controls at both actual viewport widths.
		await navigate("connections");
		const connectionMore = page.getByLabel("More connection settings", { exact: true });
		for (const section of ["local", "models", "access"]) {
			await audit(`connections-${section}`, size.name, async () => {
				assert.equal(await connectionMore.locator(`option[value="${section}"]`).count(), 1);
				await connectionMore.selectOption(section);
				await expect(connectionMore).toHaveValue(section);
				await assertReadableSurface(`connections-${section}`);
			});
		}
    await navigate("settings");
    for (const section of SETTINGS_SECTIONS.filter(section => section.id !== "browser")) {
      await audit(`settings-${section.id}`, size.name, async () => {
        await selectSettingsSection(page, section.id, section.label);
        const selected = page.locator(".settings-nav [aria-current='page']");
        const picker = page.locator(".settings-section-picker select");
        if (await picker.isVisible()) assert.equal(await picker.inputValue(), section.id);
        else assert.equal((await selected.innerText()).trim(), section.label);
      });
    }
    await (await revealNewTabControl(page)).click();
    await page.locator("#new-tab-title").waitFor();
    for (const label of ["Tab tools", "Tools", "History", "Downloads", "Browser menu", "Extensions", "Page options"]) {
      await audit(`menu-${label.toLowerCase().replace(/ /g, "-")}`, size.name, async () => {
        await openToolbarMenu(label);
      });
      await page.keyboard.press("Escape");
    }
		for (const [menu, command, section, sectionLabel] of [
			["Browser menu", "Clear browsing data…", "browser-reset", "Data & reset"],
			["Extensions", "Manage extensions", "browser-extensions", "Extensions"],
			["Browser menu", "Passwords", "browser-autofill", "Autofill"],
		] as const) {
			await audit(`menu-destination-${section}`, size.name, async () => {
				await openToolbarMenu(menu);
				await page.getByRole("menuitem", { name: command, exact: true }).click();
				await expect(page.locator(".browser-toolbar-popover")).toHaveCount(0);
				const destination = page.locator('.browser-app-page[data-app-page="settings"]');
				await destination.waitFor();
				await expect(destination).toHaveCount(1);
				// The picker remains mounted at both sizes. Assert its state without
				// selecting another section, which would mask a broken menu destination.
				const picker = destination.locator(".settings-section-picker select");
				await expect(picker).toHaveValue(section, { timeout: 12_000 });
				if (await picker.isVisible()) assert.equal(await picker.inputValue(), section);
				else assert.equal((await destination.locator(".settings-nav [aria-current='page']").innerText()).trim(), sectionLabel);
			});
		}
  }
} catch (error) {
	// Setup failures occur outside individual audits. Keep them visible in the
	// manifest and save the actual failing state, rather than reporting 1/1.
	results.push({ id: "audit-setup-or-navigation", viewport: "current", status: "failed",
		error: error instanceof Error ? error.message : String(error) });
	await page.screenshot({ path: join(evidence, "audit-abort-failure.png") }).catch(() => {});
	throw error;
} finally {
  writeFileSync(join(evidence,"specialist-targets.json"),JSON.stringify(specialistTargets,null,2));
  writeFileSync(join(evidence, "manifest.json"), JSON.stringify({ mode: packaged ? "packaged" : "source", sourceCommit: packaged ? JSON.parse(readFileSync(resolve(packaged, "../../Resources/build-provenance.json"), "utf8")).sourceCommit : undefined, fixture, results, lifecycle, pageErrors }, null, 2) + "\n");
  await application.close();
  rmSync(fixture, { recursive: true, force: true });
  console.log(`Release surface evidence: ${evidence}`);
  console.log(`${results.filter(item => item.status === "passed").length}/${results.length} surface states passed; ${pageErrors.length} renderer errors.`);
}
assert.equal(results.filter(item => item.status === "failed").length, 0, "Some surfaces failed; inspect the manifest and screenshots.");
assert.equal(pageErrors.length, 0, "Renderer errors occurred during the audit.");
