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
			await page.locator("#new-tab-title").click({ force: true });
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

export async function openKestrelDestination(page, label) {
	await openCommandCenter(page);
	const destination = page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first();
	await destination.waitFor();
	await destination.evaluate((button) => button.click());
}

export async function selectSettingsSection(page, value, label) {
	const scopeLabel = value === "browser" ? "Browser" : "Agent";
	const scopeTab = page
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
	const compactPicker = page.locator(".settings-section-picker select");
	if (await compactPicker.isVisible().catch(() => false)) {
		await compactPicker.selectOption(value);
		return;
	}
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: label, exact: true })
		.click();
}
