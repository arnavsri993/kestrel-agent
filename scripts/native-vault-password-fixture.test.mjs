import assert from "node:assert/strict";
import { test } from "vitest";
import { autofillGeneratedVaultLogin } from "./native-vault-password-fixture.mjs";

const generated = { expectedUrl: "http://127.0.0.1:43123/login", username: `kestrel_login_${"a".repeat(24)}`, password: "generated-fixture-value-".repeat(2) };

test("rejects targets outside the generated form before any browser action", async () => {
 for (const expectedUrl of ["https://example.com/login", "http://localhost:43123/login", "http://127.0.0.1/login", "http://127.0.0.1:43123/other", "http://127.0.0.1:43123/login?other=1", "http://user@127.0.0.1:43123/login", "http://127.0.0.1:43123/login#other"]) {
  let touched = false;
  const page = new Proxy({}, { get() { touched = true; throw Error("Unexpected browser action."); } });
  await assert.rejects(autofillGeneratedVaultLogin({ ...generated, page, expectedUrl }), /Only the generated loopback login form/);
  assert.equal(touched, false);
 }
});

test("refuses a changed target before focusing it", async () => {
 let focused = false;
 const page = { url: () => "http://127.0.0.1:43123/other", bringToFront: async () => { focused = true; } };
 await assert.rejects(autofillGeneratedVaultLogin({ ...generated, page }), /target changed/);
 assert.equal(focused, false);
});

test("navigation during focus prevents clicks and keys", async () => {
 let current = generated.expectedUrl, input = false;
 const page = { url: () => current, bringToFront: async () => { current = "http://127.0.0.1:43123/other"; },
  locator() { input = true; throw Error("Unexpected click."); }, keyboard: { press() { input = true; throw Error("Unexpected key."); } } };
 await assert.rejects(autofillGeneratedVaultLogin({ ...generated, page }), /target changed/);
 assert.equal(input, false);
});

test("accepts exact browser autofill without submitting the filled form", async () => {
 const page = { url: () => generated.expectedUrl, bringToFront: async () => {},
  evaluate: async () => ({ usernameMatched: true, passwordMatched: true }),
  locator() { throw Error("Already filled form must not be clicked."); },
  keyboard: { press() { throw Error("Already filled form must not be submitted."); } } };
 assert.equal(await autofillGeneratedVaultLogin({ ...generated, page }), true);
});

test("navigation after the suggestion key prevents Enter on the new document", async () => {
 let current = generated.expectedUrl;
 const keys = [];
 const page = { url: () => current, bringToFront: async () => {}, evaluate: async () => ({ usernameMatched: false, passwordMatched: false }), locator: () => ({ click: async () => {} }),
  keyboard: { press: async key => { keys.push(key); current = "http://127.0.0.1:43123/other"; } } };
 await assert.rejects(autofillGeneratedVaultLogin({ ...generated, page }), /target changed/);
 assert.deepEqual(keys, ["ArrowDown"]);
});
