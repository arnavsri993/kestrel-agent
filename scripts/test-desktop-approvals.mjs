import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-approvals-test-"));
let application;

try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
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

  await openKestrelDestination(page, "Approvals");
  await page.getByRole("heading", { name: "Review this action" }).waitFor();

  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await edit.click();
  const messageBody = page.getByRole("textbox", { name: "Message body" });
  await messageBody.waitFor();
  assert.equal(
    await messageBody.evaluate((field) => document.activeElement === field),
    true,
    "entering edit mode did not focus the message textarea",
  );
  await messageBody.fill(
    "Hi Ms. Rivera,\n\nMonday still works best. Thank you.\n\nBest,\nJordan",
  );
  await page.getByRole("button", { name: "Save draft" }).click();
  await edit.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "Edit",
  );
  assert.equal(
    await edit.evaluate((button) => document.activeElement === button),
    true,
    "saving the edit did not restore focus to its originating action",
  );

  const approvalId = await page.evaluate(async () => {
    const response = await window.kestrel.request({ type: "snapshot" });
    if (!response.ok || !response.snapshot)
      throw new Error("Approval fixture snapshot was unavailable.");
    const approval = response.snapshot.approvals.find(
      (candidate) => candidate.status === "pending",
    );
    if (!approval) throw new Error("Pending approval fixture was unavailable.");
    return approval.id;
  });
  const directApproval = await page.evaluate(
    (id) => window.kestrel.request({ type: "approve", approvalId: id }),
    approvalId,
  );
  assert.equal(
    directApproval.ok,
    true,
    "could not prepare the stale approval failure fixture",
  );

  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await reject.click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(
    (await alert.textContent()) ?? "",
    /cannot be retroactively rejected/i,
    "the rejected approval promise did not surface its recovery message",
  );
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "Reject",
  );
  assert.equal(
    await reject.evaluate((button) => document.activeElement === button),
    true,
    "a failed approval action did not restore focus to its originating button",
  );

  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    "Desktop approval accessibility passed: edit focus, successful focus restoration, visible failure recovery, and rejected-promise handling are healthy.\n",
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
