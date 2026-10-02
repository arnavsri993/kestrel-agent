import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
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
  args: packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
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
		if (id.startsWith("page-") || id.startsWith("settings-")) await assertReadableSurface(id);
    if (id.startsWith("menu-") && await page.locator(".browser-toolbar-popover").count()) {
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
	const chatToggle = page.locator("#browser-agent-toggle");
	if (await chatToggle.isVisible().catch(() => false) && await chatToggle.getAttribute("aria-expanded") === "true") {
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

try {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
		// Keep the conversation dock from stealing compact destination-page width.
		localStorage.setItem("kestrel:agent-sidebar", "collapsed");
  });
  await page.reload();
  await page.locator("#browser-address-input").waitFor();
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
	await page.getByRole("button", { name: `Open settings for ${agentName}`, exact: true }).waitFor();
	}
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

  for (const size of [{ name: "desktop", width: 1440, height: 900 }, { name: "compact", width: 800, height: 660 }]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const id of Object.keys(KESTREL_APP_PAGES)) {
      await audit(`page-${id}`, size.name, async () => {
        await navigate(id);
        const content = await page.locator(`.browser-app-page[data-app-page="${id}"]`).innerText();
        assert(content.trim().length > 0, `${id} rendered no readable content`);
      });
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
		});
		await page.getByRole("group", { name: "Agent workspace view" }).getByRole("button", { name: "List", exact: true }).click();
		if (size.name === "compact") {
			await audit("compact-chat-overlay", size.name, async () => {
				const toggle = page.locator("#browser-agent-toggle");
				await toggle.click();
				const chat = page.locator(".agent-sidebar");
				try {
					assert.equal(await chat.getAttribute("aria-modal"), "true");
					assert.equal(await chat.getAttribute("aria-hidden"), "false");
					assert.equal(await page.locator(".browser-main-plane").evaluate(element => getComputedStyle(element).visibility), "hidden");
					assert.equal(await page.locator(".agent-compact-dock").evaluate(element => getComputedStyle(element).display), "none");
					assert.equal(await chat.evaluate(element => element.contains(document.activeElement)), true, "Opening compact chat moves focus inside its modal");
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
		await audit("memory-note-details", size.name, async () => {
			await navigate("memory");
			await page.getByRole("button", { name: "Notes", exact: true }).click();
			await page.getByRole("button", { name: /Release audit fixture note/ }).click();
			await page.getByRole("heading", { name: "Release audit fixture note", exact: true }).waitFor();
			await page.getByText("Evidence and visibility", { exact: true }).click();
			await page.getByRole("button", { name: "Edit note", exact: true }).click();
		});
		await audit("memory-note-editor", size.name, async () => {
			await navigate("memory");
			await page.getByRole("button", { name: "Notes", exact: true }).click();
			await page.getByRole("button", { name: /Release audit fixture note/ }).click();
			await page.getByRole("button", { name: "Edit note", exact: true }).click();
			assert.equal(await page.getByLabel("Title (optional)", { exact: true }).inputValue(), "Release audit fixture note");
		});
		await navigate("agent");
		await page.getByRole("button", { name: "All work", exact: true }).click();
		await page.locator('.browser-app-page[data-app-page="work"]').waitFor();
		for (const label of ["Goals", "Schedules", "Delegation", "Teams"] as const) {
			await audit(`work-${label.toLowerCase()}`, size.name, async () => {
				await page.getByRole("button", { name: label, exact: true }).click();
				assert((await page.locator('.browser-app-page[data-app-page="work"]').innerText()).trim().length > 0);
			});
		}
		if (size.name === "desktop") {
			// Include deeper controls as independent evidence states, not only each
			// route's empty landing panel.
			await navigate("connections");
			const connectionMore = page.getByLabel("More connection settings", { exact: true });
			for (const section of ["local", "models", "access"]) {
				if (await connectionMore.locator(`option[value="${section}"]`).count()) {
					await audit(`connections-${section}`, size.name, async () => {
						await connectionMore.selectOption(section);
						assert((await page.locator(".browser-app-page").last().innerText()).trim().length > 0);
					});
				}
			}
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
        const trigger = page.getByRole("button", { name: label, exact: true });
        if (await trigger.isVisible()) {
          await trigger.click();
          assert.equal(await trigger.getAttribute("aria-expanded"), "true", `${label} did not open`);
        } else {
          await page.getByRole("button", { name: "Browser menu", exact: true }).click();
          await page.getByRole("menuitem", { name: label, exact: true }).click();
          await page.getByRole("menu", { name: label, exact: true }).waitFor();
        }
      });
      await page.keyboard.press("Escape");
    }
  }
} finally {
  writeFileSync(join(evidence, "manifest.json"), JSON.stringify({ mode: packaged ? "packaged" : "source", fixture, results, lifecycle, pageErrors }, null, 2) + "\n");
  await application.close();
  rmSync(fixture, { recursive: true, force: true });
  console.log(`Release surface evidence: ${evidence}`);
  console.log(`${results.filter(item => item.status === "passed").length}/${results.length} surface states passed; ${pageErrors.length} renderer errors.`);
}
assert.equal(results.filter(item => item.status === "failed").length, 0, "Some surfaces failed; inspect the manifest and screenshots.");
assert.equal(pageErrors.length, 0, "Renderer errors occurred during the audit.");
