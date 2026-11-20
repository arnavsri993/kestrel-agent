import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Operate only the caller's generated form through its owned browser connection.
// No plaintext-password export, clipboard access, preference mutation, renderer
// bridge injection, authentication override or page-script value assignment.
export async function autofillGeneratedVaultLogin({ page, expectedUrl, username, password, checkInterrupt = () => {} }) {
 assert.match(username, /^kestrel_login_[a-f0-9]{24}$/);
 assert(typeof password === "string" && password.length >= 32 && password.length <= 128);
 const url = new URL(expectedUrl);
 assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/login" &&
  !url.username && !url.password && !url.search && !url.hash, "Only the generated loopback login form is eligible.");
 const assertTarget = () => assert.equal(page.url(), expectedUrl, "Generated login target changed before input.");
 const isFilled = async () => {
  assertTarget();
  const result = await page.evaluate(expected => ({
   usernameMatched: document.querySelector('input[name="username"]')?.value === expected.username,
   passwordMatched: document.querySelector('input[name="password"]')?.value === expected.password,
  }), { username, password });
  return result?.usernameMatched === true && result?.passwordMatched === true;
 };
 assertTarget();
 checkInterrupt(); await page.bringToFront();
 assertTarget();
 // Chromium can fill a recognized login form on activation. Do not submit an
 // already filled form just to force the suggestion-popup branch of the check.
 if (await isFilled()) return true;
 await page.locator('input[name="username"]').click({ timeout: 15000 });
 assertTarget();
 if (await isFilled()) return true;
 checkInterrupt(); await page.keyboard.press("ArrowDown");
 // The password-store response and native suggestion popup are asynchronous.
 // Allow the popup to settle before Enter; the exact field-value observation
 // below, rather than elapsed time, determines whether autofill succeeded.
 await delay(500);
 assertTarget();
 if (await isFilled()) return true;
 checkInterrupt(); await page.keyboard.press("Enter");
 const deadline = Date.now() + 10000;
 while (Date.now() < deadline) {
  checkInterrupt(); assert.equal(page.url(), expectedUrl, "Generated form navigated instead of accepting autofill.");
  if (await isFilled()) return true;
  await delay(100);
 }
 throw Error("Generated password did not autofill after restart.");
}
