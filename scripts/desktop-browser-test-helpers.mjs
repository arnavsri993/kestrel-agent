const commandCenterHeading = (page) =>
	page.getByRole("heading", { name: "Command Center", exact: true });

export async function dismissDefaultBrowserPrompt(page) {
	const defaultBrowserModal = page.locator(".default-browser-modal");
	if (await defaultBrowserModal.isVisible().catch(() => false)) {
		await page
			.getByRole("heading", { name: "Set Kestrel as your default browser?" })
			.waitFor();
		await page.getByRole("button", { name: "Not Now" }).click();
		await defaultBrowserModal.waitFor({ state: "detached" });
	}
}

export async function revealNewTabControl(page) {
	const tabRow = page.locator(".browser-tab-row-horizontal");
	await tabRow.hover();
	const control = page.getByRole("button", {
		name: "New Tab",
		exact: true,
	});
	await control.waitFor({ state: "visible" });
	return control;
}

export async function openCommandCenter(page) {
	await page.locator("#runtime-prompt").waitFor({ state: "attached" });
	await dismissDefaultBrowserPrompt(page);

	const heading = commandCenterHeading(page);
	if (await heading.isVisible().catch(() => false)) {
		const search = page.getByLabel("Search Kestrel");
		await search.waitFor();
		return search;
	}

	const openers = [
		async () => {
			const commandCenterButton = page.getByRole("button", {
				name: "Open command center",
				exact: true,
			});
			if (!(await commandCenterButton.isVisible().catch(() => false)))
				throw new Error("Command Center button is not visible.");
			await commandCenterButton.click();
		},
		async () => {
			// Destination pages do not contain the New Tab heading. Foreground
			// the fixture window before using its supported global shortcut.
			await page.bringToFront();
			await page.keyboard.press("Meta+K");
		},
		async () => {
			const response = await page.evaluate(() =>
				window.kestrel.request({
					type: "browser-create-tab",
					input: "kestrel://commands",
					active: true,
				}),
			);
			if (!response.ok)
				throw new Error("Could not open Command Center through browser IPC.");
		},
	];

	let lastError;
	for (const open of openers) {
		try {
			await open();
			await heading.waitFor({ timeout: 4_000 });
			const search = page.getByLabel("Search Kestrel");
			await search.waitFor();
			return search;
		} catch (error) {
			lastError = error;
			if (await heading.isVisible().catch(() => false)) {
				const search = page.getByLabel("Search Kestrel");
				await search.waitFor();
				return search;
			}
		}
	}

	throw lastError ?? new Error("Command Center did not open.");
}

export async function openKestrelDestination(page, label, { beforeSelect } = {}) {
	await openCommandCenter(page);
	const destination = page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first();
	await destination.waitFor();
	await beforeSelect?.();
	await destination.click();
	if (label === "Settings") {
		await page.waitForFunction(() => {
			const routes = [...document.querySelectorAll('.browser-app-page[data-app-page="settings"]')];
			if (routes.length !== 1) return false;
			const route = routes[0];
			const bounds = route.getBoundingClientRect();
			return getComputedStyle(route).pointerEvents !== "none" &&
				bounds.width > 0 && bounds.height > 0 &&
				!route.closest("[inert]");
		});
	}
}

export async function selectSettingsSection(page, value, label) {
	const legacySectionAliases = {
		general: "agent-general",
		connections: "agent-connections",
		models: "agent-models",
		intelligence: "agent-memory",
		extensions: "agent-tools",
		privacy: "agent-permissions",
		advanced: "agent-diagnostics",
	};
	const sectionValue = legacySectionAliases[value] ?? value;
	const legacyLabels = {
		Models: "Models & routing",
		Memory: "Memory & context",
		Plugins: "Tools, MCP & skills",
		Privacy: "Permissions & sandbox",
		Advanced: "Diagnostics",
	};
	const sectionLabel = legacyLabels[label] ?? label;
	const settingsPage = page.locator('.browser-app-page[data-app-page="settings"]');
	await page.waitForFunction(() => {
		const routes = [...document.querySelectorAll('.browser-app-page[data-app-page="settings"]')];
		return routes.length === 1 &&
			getComputedStyle(routes[0]).pointerEvents !== "none" &&
			!routes[0].closest("[inert]");
	});
	const scopeLabel = sectionValue === "browser" || sectionValue.startsWith("browser-")
		? "Browser"
		: "Agent";
	const scopeTab = settingsPage
		.locator(".settings-scope-switcher")
		.getByRole("tab", { name: new RegExp(`^${scopeLabel}`) });
	if ((await scopeTab.getAttribute("aria-selected")) !== "true") {
		await scopeTab.click();
		await page.waitForFunction(
			(scope) =>
				[...document.querySelectorAll(".settings-scope-switcher [role=tab]")].some(
					(tab) =>
						tab.textContent?.trim().startsWith(scope) &&
						tab.getAttribute("aria-selected") === "true",
				),
			scopeLabel,
		);
	}
	const compactPicker = settingsPage.locator(".settings-section-picker select");
	if (await compactPicker.isVisible().catch(() => false)) {
		await compactPicker.selectOption(sectionValue);
	} else {
		const sectionButton = settingsPage
			.getByRole("navigation", { name: "Settings sections" })
			.getByRole("button", { name: sectionLabel, exact: true });
		try {
			await sectionButton.click();
		} catch (error) {
			const geometry = await page.evaluate((targetLabel) => {
				const viewport = document.querySelector("#browser-viewport");
				const routes = [...document.querySelectorAll('.browser-app-page[data-app-page="settings"]')];
				const route = routes.find(node => getComputedStyle(node).pointerEvents !== "none") ?? routes[0];
				const buttons = route ? [...route.querySelectorAll('.settings-nav button')] : [];
				const button = buttons.find(node => node.textContent?.trim() === targetLabel);
				const rect = (node) => node ? Object.fromEntries(["x", "y", "top", "right", "bottom", "left", "width", "height"].map(key => [key, node.getBoundingClientRect()[key]])) : null;
				const buttonBounds = button?.getBoundingClientRect();
				const hit = buttonBounds ? document.elementFromPoint(buttonBounds.x + buttonBounds.width / 2, buttonBounds.y + buttonBounds.height / 2) : null;
				return {
					viewport: rect(viewport),
					routes: routes.map(node => ({ bounds: rect(node), pointerEvents: getComputedStyle(node).pointerEvents })),
					navigation: rect(route?.querySelector(".settings-nav")),
					button: rect(button),
					hit: hit ? { tag: hit.tagName, id: hit.id, className: typeof hit.className === "string" ? hit.className : "" } : null,
				};
			}, sectionLabel).catch(() => null);
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nSettings click geometry: ${JSON.stringify(geometry)}`, { cause: error });
		}
	}
	await page.waitForFunction(({ value: expectedValue, label: expectedLabel }) => {
		const routes = [...document.querySelectorAll('.browser-app-page[data-app-page="settings"]')];
		if (routes.length !== 1 || getComputedStyle(routes[0]).pointerEvents === "none" || routes[0].closest("[inert]")) return false;
		const picker = routes[0].querySelector(".settings-section-picker select");
		if (picker && picker.checkVisibility()) return picker.value === expectedValue;
		return [...routes[0].querySelectorAll('.settings-nav button')].some(button =>
			button.textContent?.trim() === expectedLabel && button.getAttribute("aria-current") === "page",
		);
	}, { value: sectionValue, label: sectionLabel });
}
