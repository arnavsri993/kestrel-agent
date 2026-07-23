import { expect, test } from "@playwright/test";

test("01 has the product title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Kestrel/);
});

test("02 has one decisive headline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Bring the outcome\.\s*Kestrel handles the work\./);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
});

test("03 exposes the primary navigation", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Kestrel/ })).toBeVisible();
  await expect(navigation.locator('a[href="#release"]')).toHaveCount(2);
  for (const href of ["#decision", "#memory", "#control", "#architecture"]) await expect(navigation.locator(`a[href="${href}"]`)).toHaveCount(2);
  if ((page.viewportSize()?.width ?? 0) <= 1080) {
    const menu = navigation.locator(".nav-menu");
    await navigation.getByText("Menu", { exact: true }).click();
    await expect(navigation.locator(".nav-menu").getByRole("link", { name: "Release status" })).toBeVisible();
    await navigation.locator(".nav-menu").getByRole("link", { name: "Release status" }).click();
    await expect(menu).not.toHaveAttribute("open", "");
  } else {
    await expect(navigation.locator(".nav-release")).toBeVisible();
  }
});

test("04 keeps unavailable releases disabled", async ({ page }) => {
  await page.goto("/#release");
  await expect(page.getByRole("button", { name: /Download for Apple Silicon/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Verify this release/ })).toBeDisabled();
});

test("05 presents all six agent stages", async ({ page }) => {
  await page.goto("/");
  const workflow = page.getByLabel("Kestrel decision path");
  for (const label of ["Notice", "Retrieve", "Plan", "Approve", "Act", "Verify"]) await expect(workflow.getByText(label, { exact: true })).toBeVisible();
});

test("06 explains the teacher decision", async ({ page }) => {
  await page.goto("/#decision");
  await expect(page.getByText("Monday looks better.").first()).toBeVisible();
  await expect(page.getByText(/Friday is compressed by swim/).first()).toBeVisible();
});

test("07 explains scoped DJI context", async ({ page }) => {
  await page.goto("/#memory");
  await expect(page.getByText(/software compatibility now outranks a dead controller/)).toBeVisible();
  await expect(page.getByText("Decision-changing context only")).toBeVisible();
});

test("08 labels external communication risk", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".risk-ladder li", { hasText: "External communication" })).toBeVisible();
  await expect(page.getByText("Level 2", { exact: true })).toBeVisible();
});

test("09 documents the sandbox boundary", async ({ page }) => {
  await page.goto("/#architecture");
  await expect(page.getByRole("heading", { name: "Sandboxed interface" })).toBeVisible();
  await expect(page.getByText(/No Node integration/)).toBeVisible();
});

test("10 keeps fal in development provenance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/fal is used only by deliberate development scripts/)).toBeVisible();
});

test("11 does not advertise a video editor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation").getByText(/video editor/i)).toHaveCount(0);
  await expect(page.locator("section").filter({ hasText: /^Video editor/i })).toHaveCount(0);
});

test("12 makes no fal or agent API request", async ({ page }) => {
  const suspect: string[] = [];
  page.on("request", (request) => { if (/fal\.ai|\/api\//i.test(request.url())) suspect.push(request.url()); });
  await page.goto("/", { waitUntil: "networkidle" });
  expect(suspect).toEqual([]);
});

test("13 has valid local anchors", async ({ page }) => {
  await page.goto("/");
  const missing = await page.locator('a[href^="#"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")!).filter((href) => href.length > 1 && !document.querySelector(href)));
  expect(missing).toEqual([]);
});

test("14 avoids horizontal page overflow", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("15 provides visible keyboard focus", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
});

test("16 uses still media under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".hero-media video")).toHaveCount(0);
  await expect(page.locator(".hero-media img")).toBeVisible();
});

test("17 loads every rendered image", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const failed = await page.locator("img").evaluateAll((images) => images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")));
  expect(failed).toEqual([]);
});

test("18 preserves semantic heading order", async ({ page }) => {
  await page.goto("/");
  const levels = await page.locator("h1,h2,h3").evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  expect(levels[0]).toBe(1);
  for (let index = 1; index < levels.length; index += 1) expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1);
});

test("19 exposes release status without a false download", async ({ page }) => {
  await page.goto("/#release");
  await expect(page.getByText("0.1.0 development")).toBeVisible();
  await expect(page.getByText(/Developer ID signing and notarization/)).toBeVisible();
  await expect(page.locator('a[download]')).toHaveCount(0);
});

test("20 includes descriptive social metadata", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /local-first macOS agent/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /Kestrel/);
});

test("21 makes the approval preview functional without implying an external action", async ({ page }) => {
  await page.goto("/#control");
  await page.getByRole("button", { name: "Approve preview" }).click();
  await expect(page.getByText("Preview approved.")).toBeVisible();
  await expect(page.getByText(/No email was sent and no event was created/)).toBeVisible();
  const reset = page.getByRole("button", { name: "Reset preview" });
  await expect(reset).toBeFocused();
  await reset.click();
  const approve = page.getByRole("button", { name: "Approve preview" });
  await expect(approve).toBeVisible();
  await expect(approve).toBeFocused();
});

test("22 edits and returns a recommendation to review", async ({ page }) => {
  await page.goto("/#control");
  await page.getByRole("button", { name: "Edit recommendation" }).click();
  await page.getByRole("button", { name: "Friday" }).click();
  await page.getByRole("button", { name: "Return to review" }).click();
  await expect(page.getByText(/Friday keeps the original week/)).toBeVisible();
});

for (const [index, route, heading, sectionCount] of [
  ["23", "/privacy", "Your context is not the product.", 8],
  ["24", "/support", "Recover from evidence, not guesswork.", 7]
] as const) {
  test(`${index} renders the ${route.slice(1)} release surface`, async ({ page }) => {
    const failed: string[] = [];
    page.on("pageerror", (error) => failed.push(error.message));
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.locator("main section")).toHaveCount(sectionCount);
    await expect(page.getByRole("navigation", { name: "Legal and support" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect(failed).toEqual([]);
  });
}

test("25 links the public privacy and support routes from the product", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator(".site-footer");
  await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  await expect(footer.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
});
