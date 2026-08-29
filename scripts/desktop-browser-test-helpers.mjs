const commandCenterHeading = (page) =>
	page.getByRole("heading", { name: "Capabilities", exact: true });

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
			const toolbarButton = page.getByRole("button", {
				name: "Capabilities and commands",
				exact: true,
			});
			if (!(await toolbarButton.isVisible().catch(() => false)))
				throw new Error("Capabilities toolbar button is not visible.");
			await toolbarButton.click();
		},
		async () => {
			const sidebarSearch = page.getByRole("button", {
				name: "Search capabilities and shortcuts",
				exact: true,
			});
			if (!(await sidebarSearch.isVisible().catch(() => false)))
				throw new Error("Sidebar capabilities search button is not visible.");
			await sidebarSearch.click();
		},
		async () => {
			const sidebarCapabilities = page
				.locator(".kestrel-sidebar-primary")
				.getByRole("button", { name: "Capabilities", exact: true });
			if (!(await sidebarCapabilities.isVisible().catch(() => false)))
				throw new Error("Sidebar Capabilities button is not visible.");
			await sidebarCapabilities.click();
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
