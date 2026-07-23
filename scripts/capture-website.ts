import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts", "screenshots", "website", process.argv.includes("--revised") ? "revised" : "initial");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
await desktop.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
await desktop.screenshot({ path: join(output, "homepage-desktop.png"), fullPage: true });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, reducedMotion: "reduce" });
await mobile.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
await mobile.screenshot({ path: join(output, "homepage-mobile.png"), fullPage: true });
await browser.close();
console.log(output);
