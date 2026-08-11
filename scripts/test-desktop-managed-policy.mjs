import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const root = mkdtempSync(join(tmpdir(), "kestrel-managed-policy-test-"));
const policyPath = join(root, "policy.json");
const publicKeyPath = join(root, "policy.pub");
const userDataPath = join(root, "user-data");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const policy = {
  organizationId: "org-desktop-test",
  version: 1,
  allowedProviders: ["local"],
  deniedTools: ["shell.run"],
  maximumWorkers: 2,
  retentionDays: 30,
  analyticsEnabled: true,
};
const signatureBase64 = sign(
  null,
  Buffer.from(canonical(policy)),
  privateKey,
).toString("base64");
writeFileSync(
  policyPath,
  JSON.stringify({ algorithm: "Ed25519", policy, signatureBase64 }),
  { mode: 0o600 },
);
chmodSync(policyPath, 0o600);
writeFileSync(
  publicKeyPath,
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o644 },
);

let application;
try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_MANAGED_POLICY: policyPath,
      KESTREL_MANAGED_POLICY_KEY: publicKeyPath,
      KESTREL_TEST_USER_DATA: userDataPath,
    },
  });
  const page = await application.firstWindow();
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("heading", { name: "How can I help?" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Preferences" }).waitFor();
  await page
    .locator(".settings-nav button")
    .filter({ hasText: "Advanced" })
    .click();

  const managedCard = page
    .locator(".setting-row")
    .filter({ hasText: `${policy.organizationId} organization controls` });
  await managedCard.waitFor();
  await managedCard.getByText("Managed", { exact: true }).waitFor();
  await managedCard.getByText("Signed policy v1", { exact: false }).waitFor();
  await managedCard.getByText("2 workers", { exact: false }).waitFor();
  await managedCard.getByText("retention 30 days", { exact: false }).waitFor();

  const summary = await page.evaluate(async () => {
    const response = await window.kestrel.request({ type: "enterprise-summary" });
    if (!response.ok) throw new Error(response.error);
    return response.enterprisePolicy;
  });
  assert.equal(summary.organizationId, policy.organizationId);
  assert.equal(summary.maximumWorkers, policy.maximumWorkers);
  assert.equal(summary.retentionDays, policy.retentionDays);

  await managedCard
    .getByRole("button", { name: "Enforce retention now" })
    .click();
  await managedCard.getByText(/Retention enforced through/, { exact: false }).waitFor();
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    "Signed managed-policy desktop bootstrap passed: policy loaded, admin surface managed, policy values visible, and retention action verified.\n",
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
