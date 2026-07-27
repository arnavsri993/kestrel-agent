import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const captureName = process.argv.includes("--final-native-graphite")
  ? "final-native-graphite"
  : process.argv.includes("--natural-controls")
    ? "natural-controls"
    : process.argv.includes("--model-tiers")
      ? "model-tiers"
      : process.argv.includes("--native-graphite")
        ? "native-graphite"
        : process.argv.includes("--mineral-current")
          ? "mineral-current"
          : process.argv.includes("--setup-revised")
            ? "setup-revised"
            : process.argv.includes("--workstrand-pass1")
              ? "workstrand-pass1"
              : process.argv.includes("--workstrand-revised")
                ? "workstrand-revised"
                : process.argv.includes("--revised")
                  ? "revised"
                  : "initial";
const output = join(
  root,
  "artifacts",
  "screenshots",
  "desktop",
  captureName,
);
const testData = join(root, ".tmp", "desktop-capture-data");
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;

await rm(testData, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const application = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: packagedExecutable, args: [] }
    : {
        args: [
          join(root, "apps", "desktop", "out", "main", "index.js"),
        ],
      }),
  env: { ...process.env, KESTREL_TEST_USER_DATA: testData },
});

async function settle(page: Page, duration = 260) {
  await page.waitForTimeout(duration);
}

async function capture(page: Page, name: string, duration = 260) {
  await settle(page, duration);
  await page.screenshot({ path: join(output, name), fullPage: false });
}

async function assertNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  if (overflow) throw new Error(`${label} has page-level horizontal overflow.`);
}

async function openTool(page: Page, label: string) {
  if ((await page.locator(".tools-disclosure").count()) === 0)
    await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page
    .locator(".tools-disclosure")
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.locator(".page-content").waitFor();
}

const page = await application.firstWindow();
const runtimeErrors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") runtimeErrors.push(message.text());
});
page.on("pageerror", (error) => runtimeErrors.push(error.message));

try {
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1320, height: 860 });

  await page
    .getByRole("heading", { name: /Your AI answers/ })
    .waitFor();
  await capture(page, "setup-01-welcome.png");

  await page.getByRole("button", { name: "Get started" }).click();
  await page
    .getByRole("heading", { name: "Know what leaves this Mac." })
    .waitFor();
  await capture(page, "setup-02-before-you-begin.png");
  await page.locator(".warning-panel details").first().locator("summary").click();
  await capture(page, "setup-02-boundary-detail.png", 120);
  await page.getByLabel("I understand these boundaries").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("heading", { name: "Choose a model." }).waitFor();
  await capture(page, "setup-03-choose-model.png");

  await page.getByRole("button", { name: /Use an account/ }).click();
  await page.getByRole("heading", { name: "Connect an account." }).waitFor();
  await capture(page, "setup-04-account.png");

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Try free providers/ }).click();
  await page
    .getByRole("heading", { name: "Connect a free account." })
    .waitFor();
  await capture(page, "setup-04-free-providers.png");

  await page.setViewportSize({ width: 640, height: 760 });
  await capture(page, "setup-04-free-providers-compact.png");
  await assertNoPageOverflow(page, "Compact provider setup");
  const railRows = await page.locator(".setup-rail ol").evaluate((rail) => {
    const items = [...rail.querySelectorAll("li")].map((item) =>
      Math.round(item.getBoundingClientRect().top),
    );
    return new Set(items).size;
  });
  if (railRows !== 1)
    throw new Error("Compact setup progress no longer fits on one row.");

  await page.setViewportSize({ width: 1320, height: 860 });
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Run on this Mac/ }).click();
  await page
    .getByRole("heading", { name: "Set up a local model." })
    .waitFor();
  await capture(page, "setup-04-local-model.png");

  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByRole("heading", {
      name: /Kestrel is ready|Your model route is configured\.|Your workspace is ready\./,
    })
    .waitFor();
  await capture(page, "setup-05-ready.png");

  await page
    .getByRole("button", {
      name: /Start using Kestrel|Open Kestrel|Open local preview/,
    })
    .click();
  await page
    .getByRole("heading", { name: "What should we get done?" })
    .waitFor();
  await capture(page, "workspace-new-chat.png", 360);

  await page.getByLabel("Task settings").click();
  await page.getByText("Task settings", { exact: true }).waitFor();
  await capture(page, "workspace-task-settings.png", 120);
  await page.getByLabel("Task settings").click();

  const firstSession = page.locator(".recent-section button").first();
  if (await firstSession.count()) {
    await firstSession.click();
    await page.locator(".conversation-view").waitFor();
    await capture(page, "workspace-conversation.png");
  }
  await page.getByRole("button", { name: "New chat", exact: true }).click();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByLabel("Kestrel tools").waitFor();
  await capture(page, "workspace-tools.png", 160);

  await openTool(page, "Readiness");
  await page
    .getByRole("heading", { name: /Ready for work|Needs attention/ })
    .waitFor();
  await capture(page, "surface-readiness.png");

  await openTool(page, "Approvals");
  await page
    .getByRole("heading", { name: /Review this action|No approvals waiting/ })
    .waitFor();
  await capture(page, "surface-approvals.png");

  await openTool(page, "Memory");
  await page.getByRole("heading", { name: "Memory", exact: true }).waitFor();
  await capture(page, "surface-memory.png");

  await openTool(page, "Research");
  await page.getByRole("heading", { name: "Research", exact: true }).waitFor();
  await capture(page, "surface-research.png");

  await openTool(page, "Artifacts");
  await page.getByRole("heading", { name: "Artifacts", exact: true }).waitFor();
  await capture(page, "surface-artifacts.png");

  await openTool(page, "Work");
  await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await capture(page, "surface-work.png");

  await openTool(page, "Opportunities");
  await page.locator(".event-applications-page").waitFor();
  await capture(page, "surface-opportunities.png");

  await openTool(page, "Activity");
  await page.getByRole("heading", { name: "Activity", exact: true }).waitFor();
  await capture(page, "surface-activity.png");

  await openTool(page, "Extensions");
  await page.locator(".dashboard-extensions").waitFor();
  await capture(page, "surface-extensions.png");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await capture(page, "settings-connections.png");

  const settingsSections = [
    ["General", "settings-general.png"],
    ["Models", "settings-models.png"],
    ["Memory", "settings-memory.png"],
    ["Extensions", "settings-extensions.png"],
    ["Privacy", "settings-privacy.png"],
    ["Advanced", "settings-advanced.png"],
  ] as const;
  for (const [label, filename] of settingsSections) {
    await page
      .locator(".settings-nav")
      .getByRole("button", { name: new RegExp(`^${label}`) })
      .click();
    await capture(page, filename, 120);
  }

  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 760 });
  await page
    .getByRole("heading", { name: "What should we get done?" })
    .waitFor();
  await capture(page, "compact-new-chat.png");
  await assertNoPageOverflow(page, "Compact workspace");

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByLabel("Kestrel tools").waitFor();
  await capture(page, "compact-tools.png", 160);
  const toolsBounds = await page.locator(".tools-disclosure").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  if (toolsBounds.top < 0 || toolsBounds.bottom > toolsBounds.viewportHeight - 64)
    throw new Error("Compact Tools disclosure is outside the usable viewport.");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".tools-disclosure").waitFor({ state: "detached" });
  if ((await page.locator(".tools-disclosure").count()) !== 0)
    throw new Error("Tools disclosure stayed open after Settings navigation.");
  await capture(page, "compact-settings.png");
  await assertNoPageOverflow(page, "Compact Settings");

  const toolsTrigger = page.getByRole("button", { name: "Tools", exact: true });
  await page.getByRole("button", { name: "New chat", exact: true }).focus();
  await page.keyboard.press("Tab");
  const focusStyle = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const style = element ? getComputedStyle(element) : null;
    return {
      label:
        element?.getAttribute("aria-label") ??
        element?.textContent?.trim() ??
        "",
      outline: style?.outlineStyle ?? "none",
      width: style?.outlineWidth ?? "0px",
    };
  });
  if (
    focusStyle.label !== "Tools" ||
    focusStyle.outline === "none" ||
    focusStyle.width === "0px"
  )
    throw new Error("Keyboard focus is not visibly represented.");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
  await toolsTrigger.click();
  await page
    .locator(".tools-disclosure")
    .getByRole("button", { name: "Approvals", exact: true })
    .click();
  await settle(page, 30);
  const runningAnimations = await page.locator("body").evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const duration = animation.effect?.getComputedTiming().duration;
        return (
          animation.playState === "running" &&
          typeof duration === "number" &&
          duration > 50
        );
      })
      .map((animation) => {
        const target = animation.effect instanceof KeyframeEffect
          ? animation.effect.target
          : null;
        return {
          duration: animation.effect?.getComputedTiming().duration,
          target:
            target instanceof HTMLElement
              ? `${target.tagName}.${target.className}`
              : "unknown",
        };
      }),
  );
  if (runningAnimations.length > 0)
    throw new Error(
      `Reduced motion left a running interface animation: ${JSON.stringify(runningAnimations)}`,
    );
  await capture(page, "compact-reduced-motion.png", 20);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const transparency = await page
    .locator(".tools-disclosure")
    .evaluate((element) => getComputedStyle(element).backdropFilter);
  if (transparency !== "none")
    throw new Error("Reduced transparency did not remove disclosure blur.");
  await capture(page, "compact-reduced-transparency.png", 20);

  if (runtimeErrors.length > 0)
    throw new Error(`Renderer errors: ${runtimeErrors.join(" | ")}`);
} finally {
  await application.close();
}

console.log(output);
