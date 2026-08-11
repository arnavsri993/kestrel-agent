export async function openKestrelDestination(page, label) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("heading", { name: "Kestrel", exact: true }).waitFor();
  const destination = page
    .locator(".command-groups button")
    .filter({ hasText: label })
    .first();
  await destination.waitFor();
  await destination.click();
}
