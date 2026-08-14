export async function openKestrelDestination(page, label) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("heading", { name: "Capabilities", exact: true }).waitFor();
  const destination = page
    .locator(".command-groups button")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  await destination.waitFor();
  await destination.click();
}
