import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "workstrand-setup-test-"));
const testHome = join(root, "home");
const testCodexHome = join(root, "codex-home");
mkdirSync(testHome, { recursive: true });
mkdirSync(testCodexHome, { recursive: true });
const testEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);
let application;

try {
	application = await electron.launch({
		args: [
			resolve("apps/desktop/out/main/index.js"),
			...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
		],
		env: {
			...testEnvironment,
			HOME: testHome,
			USER: "kestrel-test",
			LOGNAME: "kestrel-test",
			CODEX_HOME: testCodexHome,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
		},
	});
	const page = await application.firstWindow();
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");

	const legacySkinSelection = await page.evaluate(async () =>
		window.kestrel.request({ type: "skin-select", skinId: "daylight" }),
	);
	assert.equal(legacySkinSelection.ok, true);
	await page.reload();

	await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
	const setupTheme = await page
		.locator(".setup-onboarding")
		.evaluate((element) => ({
			canvas: getComputedStyle(element).getPropertyValue("--canvas").trim(),
			solid: getComputedStyle(element).getPropertyValue("--solid").trim(),
			colorScheme: getComputedStyle(element).colorScheme,
			color: getComputedStyle(element).color,
		}));
	assert.equal(setupTheme.canvas, "#0d0e11");
	assert.equal(setupTheme.solid, "#f3f4f6");
	assert.equal(setupTheme.colorScheme, "dark");
	assert.equal(setupTheme.color, "rgb(243, 244, 246)");
	await page.waitForFunction(
		() =>
			getComputedStyle(document.documentElement)
				.getPropertyValue("--canvas")
			.trim() === "#0d0e11",
	);
	assert.equal(await page.locator(".setup-product-anchor").count(), 0);
	assert.deepEqual(
		await page.locator(".setup-rail li strong").allTextContents(),
		["Welcome", "Before you begin", "Choose a model", "Model setup", "Ready"],
	);
	assert.equal(
		await page
			.getByRole("button", { name: "Welcome, current step" })
			.isDisabled(),
		true,
	);
	assert.equal(
		await page
			.getByRole("button", { name: "Before you begin, upcoming" })
			.isDisabled(),
		true,
	);
	await page.getByRole("button", { name: "Get started" }).click();
	await page.waitForFunction(() => document.activeElement?.tagName === "H1");
	assert.equal(
		await page
			.getByRole("heading", { name: "Know what leaves this Mac." })
			.evaluate((heading) => document.activeElement === heading),
		true,
	);
	assert.equal(
		await page.getByRole("button", { name: "Welcome, completed" }).isEnabled(),
		true,
	);
	const continueButton = page.getByRole("button", { name: "Continue" });
	assert.equal(await continueButton.isDisabled(), true);
	const firstBoundary = page.locator(".warning-panel details").first();
	await firstBoundary.locator("summary").click();
	await page.getByText(/retention and training terms/).waitFor();
	await page.getByLabel("I understand these boundaries").check();
	assert.equal(await continueButton.isEnabled(), true);

	await page.reload();
	await page
		.getByRole("heading", { name: "Know what leaves this Mac." })
		.waitFor();
	assert.equal(
		await page.getByLabel("I understand these boundaries").isChecked(),
		true,
	);
	await page.getByRole("button", { name: "Continue" }).click();

	await page
		.getByRole("heading", { name: "Where should answers come from?" })
		.waitFor();
	await page.getByRole("button", { name: /Use an account/ }).click();
	await page.getByRole("heading", { name: "Connect an account." }).waitFor();
	await page.getByText("Choose a paid provider", { exact: true }).waitFor();
	const paidProviders = page.getByRole("group", { name: "Paid AI providers" });
	const openAiProvider = paidProviders.getByRole("button", { name: /OpenAI/ });
	await openAiProvider.waitFor();
	const providerLayout = await openAiProvider.evaluate((button) => {
		const style = getComputedStyle(button);
		const group = button.parentElement;
		return {
			display: style.display,
			gridTemplateColumns: style.gridTemplateColumns,
			width: button.getBoundingClientRect().width,
			groupWidth: group?.clientWidth ?? 0,
			detailDisplay: getComputedStyle(button.querySelector("small")).display,
		};
	});
	assert.equal(providerLayout.display, "grid");
	assert.match(providerLayout.gridTemplateColumns, /^34px /);
	assert.ok(providerLayout.width >= providerLayout.groupWidth - 2);
	assert.equal(providerLayout.detailDisplay, "block");
	const cohereProvider = paidProviders.getByRole("button", { name: /Cohere/ });
	await cohereProvider.click();
	assert.equal(await cohereProvider.getAttribute("aria-pressed"), "true");
	const cohereMethods = page.locator(".paid-provider-methods");
	await cohereMethods
		.locator('input[type="password"]')
		.fill("test-cohere-account");
	await cohereMethods.getByRole("button", { name: "Save" }).click();
	await cohereMethods.getByText("Connected", { exact: true }).waitFor();
	assert.equal(
		await page.getByRole("button", { name: "Do this later" }).count(),
		0,
	);
	const removedCohere = await page.evaluate(async () =>
		window.kestrel.request({
			type: "credential-remove",
			credentialId: "cohere",
		}),
	);
	assert.equal(removedCohere.ok, true);
	await page.reload();
	await page.getByRole("heading", { name: "Connect an account." }).waitFor();
	await page.getByText("Codex CLI", { exact: true }).waitFor();
	const openAiMethods = page.locator(".paid-provider-methods");
	await openAiMethods.getByLabel("Account 1").fill("test-openai-account-one");
	await openAiMethods.getByRole("button", { name: "Save" }).first().click();
	await openAiMethods.getByText("Connected", { exact: true }).waitFor();
	await openAiMethods.getByLabel("Account 2").fill("test-openai-account-two");
	await openAiMethods.getByRole("button", { name: "Save" }).click();
	await page.waitForFunction(
		() =>
			document.querySelectorAll(".paid-provider-methods .configured-account")
				.length === 2,
	);
	await paidProviders.getByRole("button", { name: /Anthropic/ }).click();
	await page.getByText("Claude Code CLI", { exact: true }).waitFor();
	await paidProviders.getByRole("button", { name: /Microsoft Azure/ }).click();
	await page
		.getByText(
			"Additional enterprise adapters for this provider are not available in this build yet.",
			{ exact: true },
		)
		.waitFor();
	await page.getByLabel("Find a provider").fill("Groq");
	assert.equal(await paidProviders.getByRole("button").count(), 1);
	await page.getByLabel("Find a provider").fill("");
	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Run on this Mac/ }).click();
	await page.getByRole("heading", { name: "Set up a local model." }).waitFor();
	await page.locator(".recommended-model-tiers article").first().waitFor();
	const tierNames = page.locator(".model-tier-name strong");
	await tierNames.first().waitFor();
	const names = await tierNames.allTextContents();
	assert.ok(names.includes("Light"));
	assert.ok(names.length >= 1 && names.length <= 3);
	if (names.length === 3) {
		assert.deepEqual(names, ["Light", "Balanced", "Power"]);
		await page.locator(".recommended-model-tiers article.preferred").waitFor();
		await page.getByText("Recommended", { exact: true }).waitFor();
	} else {
		assert.ok(!names.includes("Balanced"));
		assert.equal(
			await page.locator(".recommended-model-tiers article.preferred").count(),
			0,
			"A constrained CI device must not claim a nonexistent balanced tier is recommended.",
		);
	}
	const tierDetails = page.locator(".model-tier-details");
	const detailIndex = Math.min(1, (await tierDetails.count()) - 1);
	assert.equal(
		await tierDetails.nth(detailIndex).evaluate((details) => details.open),
		false,
	);
	await tierDetails
		.nth(detailIndex)
		.getByText("Details", { exact: true })
		.click();
	await tierDetails
		.nth(detailIndex)
		.getByText(/GB · 256K context/, { exact: true })
		.waitFor();
	assert.equal(
		await page.getByText("Automatic setup", { exact: true }).count(),
		0,
	);
	await page
		.getByText("huihui_ai/qwen3.5-abliterated:4b", { exact: true })
		.count()
		.then((count) => assert.equal(count, 0));
	assert.equal(await page.getByText("Fast path", { exact: true }).count(), 0);
	assert.equal(
		await page.getByText("Standard Qwen models", { exact: true }).count(),
		0,
	);
	assert.equal(await page.getByText("qwen3.5:9b", { exact: true }).count(), 0);
	await page.getByText(/These models use reduced filtering/).waitFor();
	await page.getByRole("button", { name: /Manual setup/ }).click();
	await page
		.getByRole("link", { name: "Install Ollama from its official download" })
		.waitFor();
	await page.getByText("Any other Ollama model", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Try free providers/ }).click();
	await page
		.getByRole("heading", { name: "Set up free provider accounts." })
		.waitFor();
	await page.getByText("More ways to run models", { exact: true }).waitFor();
	await page
		.getByRole("link", { name: /Hugging Face Inference Providers/ })
		.waitFor();
	const freeProviderNames = [
		"TokenRouter",
		"B.AI",
		"InferX",
		"ZenMux",
		"OpenCode Zen",
		"SenseNova",
		"GMI Cloud",
		"Token Harbor",
		"Cline",
		"OpenRouter",
		"Groq Cloud",
		"Google Gemini",
		"Mistral",
		"Command Code",
		"Kilo",
		"OrcaRouter",
		"AIHubMix",
	];
	assert.deepEqual(
		await page.locator(".provider-heading > div > strong").allTextContents(),
		freeProviderNames,
	);
	assert.deepEqual(
		await page.locator(".open-access-list a strong").allTextContents(),
		[
			"Hugging Face Inference Providers",
			"Ollama model library",
			"OpenCode AI",
			"AutoClaw",
			"WorkBuddy",
			"Antigravity",
		],
	);

	await page.setViewportSize({ width: 640, height: 760 });
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	assert.equal(overflow, false);
	assert.equal(await page.locator(".setup-product-anchor").count(), 0);
	const railLayout = await page.locator(".setup-rail ol").evaluate((rail) => {
		const items = [...rail.querySelectorAll("li")].map((item) =>
			item.getBoundingClientRect(),
		);
		return {
			rows: getComputedStyle(rail).gridTemplateRows.split(" ").filter(Boolean)
				.length,
			topEdges: [...new Set(items.map((item) => Math.round(item.top)))],
		};
	});
	assert.equal(railLayout.rows, 1);
	assert.equal(railLayout.topEdges.length, 1);

	for (const credentialId of ["openai", "openai-secondary"]) {
		const removed = await page.evaluate(
			async (id) =>
				window.kestrel.request({
					type: "credential-remove",
					credentialId: id,
				}),
			credentialId,
		);
		assert.equal(removed.ok, true);
	}
	await page.reload();
	await page
		.getByRole("button", { name: "Model setup, current step" })
		.waitFor();
	await page.setViewportSize({ width: 1320, height: 860 });
	const doThisLater = page.getByRole("button", { name: "Do this later" });
	if ((await doThisLater.count()) > 0) {
		await doThisLater.click();
	} else {
		await page.getByRole("button", { name: "Continue" }).click();
	}
	await page
		.getByRole("heading", { name: /You're set\.|Ready for a first task/ })
		.waitFor();
	await page
		.getByRole("button", { name: "Finish with setup help" })
		.click({ timeout: 120_000 });
	await page
		.getByRole("button", { name: "New task", exact: true })
		.first()
		.waitFor();
	assert.equal(
		await page.locator('.conversation-view > [role="status"]').count(),
		1,
	);
	assert.equal(await page.locator(".message-list[aria-live]").count(), 0);
	await page.evaluate(() => {
		const fixture = document.createElement("div");
		fixture.id = "daylight-contrast-fixture";
		fixture.style.cssText =
			"position:fixed;left:320px;top:24px;z-index:99999;padding:12px;";
		fixture.innerHTML = `
      <button id="contrast-primary" class="button primary">Continue</button>
      <div id="contrast-composer" class="composer">
        <textarea id="contrast-placeholder" placeholder="Ask Kestrel"></textarea>
      </div>
      <span id="contrast-avatar" class="assistant-avatar">K</span>
    `;
		document.body.append(fixture);
	});
	await page.locator("#contrast-primary").hover();
	const daylightContrast = await page.evaluate(() => {
		function channels(value) {
			const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
			if (value.startsWith("color(srgb"))
				return numbers.slice(0, 3).map((channel) => channel * 255);
			return numbers.slice(0, 3);
		}
		function luminance(value) {
			const [red = 0, green = 0, blue = 0] = channels(value).map((channel) => {
				const normalized = channel / 255;
				return normalized <= 0.04045
					? normalized / 12.92
					: ((normalized + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
		}
		function contrast(foreground, background) {
			const first = luminance(foreground);
			const second = luminance(background);
			return (
				(Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
			);
		}
		const primary = getComputedStyle(
			document.querySelector("#contrast-primary"),
		);
		const composer = getComputedStyle(
			document.querySelector("#contrast-composer"),
		);
		const placeholder = getComputedStyle(
			document.querySelector("#contrast-placeholder"),
			"::placeholder",
		);
		const avatar = getComputedStyle(document.querySelector("#contrast-avatar"));
		const values = {
			primary: [primary.color, primary.backgroundColor],
			placeholder: [placeholder.color, composer.backgroundColor],
			avatar: [avatar.color, avatar.backgroundColor],
		};
		return Object.fromEntries(
			Object.entries(values).map(([label, [foreground, background]]) => [
				label,
				{ foreground, background, ratio: contrast(foreground, background) },
			]),
		);
	});
	for (const [label, result] of Object.entries(daylightContrast))
		assert.ok(
			result.ratio >= 4.5,
			`${label} contrast was ${result.ratio.toFixed(2)}:1 (${result.foreground} on ${result.background})`,
		);
	await page
		.locator("#daylight-contrast-fixture")
		.evaluate((fixture) => fixture.remove());
	const setupAssistantPrompt = await page
		.getByLabel("Message Kestrel")
		.inputValue();
	assert.match(setupAssistantPrompt, /Help me finish setting up Kestrel/);
	assert.match(setupAssistantPrompt, /Current non-secret setup state:/);
	assert.match(setupAssistantPrompt, /Protected API credentials configured:/);
	assert.match(
		setupAssistantPrompt,
		/Project access, tools\/MCP, skills\/plugins, channels, and automations/,
	);
	assert.equal(
		await page.evaluate(() =>
			localStorage.getItem("kestrel:setup-coach-context"),
		),
		null,
	);
	assert.equal(
		await page.evaluate(() => localStorage.getItem("kestrel:onboarded")),
		"yes",
	);
	const defaultBrowserModal = page.locator(".default-browser-modal");
	if (await defaultBrowserModal.isVisible().catch(() => false)) {
		await page
			.getByRole("heading", { name: "Set Kestrel as your default browser?" })
			.waitFor();
		await page.getByRole("button", { name: "Not Now" }).click();
	}
	const newAgentButton = page
		.locator(".kestrel-sidebar")
		.getByRole("button", { name: "New task" });
	await newAgentButton.click();
	assert.equal(
		await newAgentButton.getAttribute("aria-keyshortcuts"),
		"Meta+N",
	);
	await page
		.getByRole("button", {
			name: /Add (?:context files|files or choose folder)/,
		})
		.waitFor();
	await page.locator("#runtime-prompt").waitFor();
	assert.equal(await page.getByRole("button", { name: /Review a project/ }).count(), 0);
	assert.equal(await page.getByRole("button", { name: /Plan a task/ }).count(), 0);
	const preservedDraft = "Keep this draft while I check Settings.";
	await page.getByLabel("Message Kestrel").fill(preservedDraft);
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText("Settings", { exact: true }) })
		.first()
		.click();
	await page.getByRole("heading", { name: "Preferences" }).waitFor();
	assert.equal(
		await page.getByLabel("Message Kestrel").inputValue(),
		preservedDraft,
	);
	await page.getByLabel("Message Kestrel").fill("");
	await page.setViewportSize({ width: 640, height: 760 });
	await page.locator(".kestrel-sidebar").waitFor({ state: "visible" });
	assert.equal(
		await page.locator(".kestrel-sidebar-brand span").evaluate(
			(node) => window.getComputedStyle(node).display === "none",
		),
		true,
		"The Kestrel navigation rail should collapse to icon-only mode on narrow widths",
	);
	assert.equal(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		),
		false,
	);
	await page.keyboard.press("Meta+K");
	await page.getByLabel("Search Kestrel").waitFor();
	const compactCommandCenter = page.locator(".command-center");
	await compactCommandCenter.evaluate(async (element) => {
		await Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
	const compactCommands = await compactCommandCenter
		.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			return {
				bottom: bounds.bottom,
				viewport: window.innerHeight,
				scrollable: element.scrollHeight >= element.clientHeight,
			};
		});
	assert.ok(compactCommands.bottom <= compactCommands.viewport);
	assert.equal(compactCommands.scrollable, true);
	await page
		.locator(".command-groups button")
		.filter({ hasText: "Readiness" })
		.click();
	await page
		.getByRole("heading", { name: /Ready for work|Needs attention/ })
		.waitFor();
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText("Settings", { exact: true }) })
		.first()
		.click();
	await page.locator(".command-center").waitFor({ state: "detached" });
	assert.equal(await page.locator(".command-center").count(), 0);
	await page.setViewportSize({ width: 1320, height: 860 });
	await page.getByRole("heading", { name: "Preferences" }).waitFor();
	assert.equal(await page.locator(".page-header .eyebrow").count(), 0);
	assert.equal(await page.locator(".page-header > p").count(), 0);
	await page.getByRole("heading", { name: "Accounts and access" }).waitFor();
	const chatGptConnection = page
		.locator(".oauth-connection")
		.filter({ hasText: "ChatGPT" });
	await chatGptConnection.getByText("ChatGPT", { exact: true }).waitFor();
	assert.equal(
		await chatGptConnection
			.getByRole("button", {
				name: /Sign in with ChatGPT|Enable model route|Disable model route|Codex not found/,
			})
			.count(),
		1,
	);
	await page.getByLabel("Desktop OAuth client ID").waitFor();
	assert.equal(
		await page
			.getByRole("button", { name: "Connect with Google" })
			.isDisabled(),
		true,
	);
	await page
		.getByLabel("Desktop OAuth client ID")
		.fill(
			"1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com",
		);
	assert.equal(
		await page.getByRole("button", { name: "Connect with Google" }).isEnabled(),
		true,
	);
	await page.getByRole("link", { name: "Google Cloud Console" }).waitFor();
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: /General & Autonomy/ })
		.click();
	const communicationStyle = page.getByRole("group", {
		name: "Communication style",
	});
	await communicationStyle.waitFor();
	assert.equal(
		await communicationStyle.locator('button[aria-pressed="true"]').count(),
		1,
	);
	assert.equal(
		await communicationStyle.locator("button:not([aria-pressed])").count(),
		0,
	);
	const selectedButtonShadows = await page
		.locator(
			'.sidebar-bottom > button.active, .nav-section button.active, .new-task-button.active, .settings-nav button.active, [role="option"][aria-selected="true"], .event-application-rail button.active',
		)
		.evaluateAll((buttons) =>
			buttons.map((button) => getComputedStyle(button).boxShadow),
		);
	assert.equal(
		selectedButtonShadows.some((shadow) => shadow.includes("inset 3px 0")),
		false,
	);
	await page.keyboard.press("Meta+N");
	await page.locator("#runtime-prompt").waitFor();
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText("Settings", { exact: true }) })
		.first()
		.click();
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: /General & Autonomy/ })
		.click();
	await page.getByRole("button", { name: "Open setup guide" }).click();
	await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
	assert.equal(
		await page.evaluate(() => localStorage.getItem("kestrel:onboarded")),
		null,
	);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		"Five-step desktop setup persistence, automatic/manual local setup, setup-assistant handoff, ChatGPT and Google OAuth connection entries, compact reflow, completion, and Settings re-entry passed.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
