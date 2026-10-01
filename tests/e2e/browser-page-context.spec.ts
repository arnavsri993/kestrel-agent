import { expect, test } from "@playwright/test";
import { PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT } from "../../apps/desktop/src/main/page-context-visible-text";

test("reads the visible middle of long single-node source without its offscreen prefix", async ({ page }) => {
  await page.setContent('<style>body{margin:0}pre{margin:0;font:16px/24px monospace}</style><main><pre id="code"></pre></main>');
  await page.locator("#code").evaluate(node => {
    node.textContent = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}: const value = ${i};`).join("\n");
  });
  await page.evaluate(() => window.scrollTo(0, 24 * 303));
  const text = await page.evaluate(PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT);
  expect(text).toContain("line-304:");
  expect(text).not.toContain("line-1:");
  expect(text).not.toContain("line-1000:");
  expect(text).toMatch(/line-304:.*\nline-305:/);
});

test("omits hidden ancestors, offscreen content and form values", async ({ page }) => {
  await page.setContent(`<main>Visible evidence <span style="display:none">hidden-display</span>
    <span style="opacity:0"><span>hidden-opacity</span></span>
    <span style="position:absolute;top:10000px">offscreen-secret</span>
    <input type="password" value="password-secret"><textarea>textarea-secret</textarea>
    <select><option>select-secret</option></select></main>`);
  const text = await page.evaluate(PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT);
  expect(text).toContain("Visible evidence");
  expect(text).not.toMatch(/hidden-|offscreen-secret|password-secret|textarea-secret|select-secret/);
});

test("preserves source token spacing and clips horizontal offscreen text", async ({ page }) => {
  await page.setContent('<style>pre{font:16px/24px monospace;margin:0}</style><pre><span>const </span><span>answer</span><span> = 42;</span>\nnext line</pre><span style="position:absolute;left:10000px">far-right-secret</span>');
  const text = await page.evaluate(PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT);
  expect(text).toContain("const answer = 42;");
  expect(text).toContain("next line");
  expect(text).not.toContain("far-right-secret");
});

test("does not fall back to hidden body text when the viewport has no readable text", async ({ page }) => {
  await page.setContent('<main style="display:none">hidden-body-secret</main>');
  expect(await page.evaluate(PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT)).toBe("");
});
