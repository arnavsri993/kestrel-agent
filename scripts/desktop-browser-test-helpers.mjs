export async function openKestrelDestination(page, label) {
	await page.locator("#runtime-prompt").waitFor({ state: "attached" });
	const capabilities = page.getByRole("button", {
		name: "Capabilities and commands",
		exact: true,
	});
	if (await capabilities.isVisible()) {
		await capabilities.click();
	} else {
		await page.keyboard.press("Meta+K");
	}
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	const destination = page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first();
	await destination.waitFor();
	await destination.evaluate((button) => button.click());
}
