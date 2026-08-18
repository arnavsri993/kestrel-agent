export async function openKestrelDestination(page, label) {
	await page
		.locator(".agent-sidebar-footer")
		.getByRole("button", { name: "Browser", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Capabilities and commands", exact: true })
		.click();
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	const destination = page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first();
	await destination.waitFor();
	await destination.click();
}
