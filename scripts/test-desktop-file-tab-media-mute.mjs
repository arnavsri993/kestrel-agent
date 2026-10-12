import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-media-mute-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
// Two seconds of actual silent PCM WAV and FFmpeg-generated VP8/Opus WebM.
// Fixtures decode through Chromium; no sound, external encoder or disk stubs at runtime.
const audio = Buffer.alloc(44 + 8000 * 2 * 2);
audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
const paths = { audio: join(root, "silent.wav"), video: join(root, "silent.webm") };
writeFileSync(paths.audio, audio);
writeFileSync(paths.video, Buffer.from("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", "base64"));
const evidence = process.env.KESTREL_MEDIA_MUTE_EVIDENCE_DIR ?? ".tmp/file-tab-media-mute/source";
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "media-mute-fixture", LOGNAME: "media-mute-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let app; let page; let window;
const errors = [];
async function request(input) {
  const result = await page.evaluate(input => window.kestrel.request(input), input);
  assert(result.ok, result.error); return result;
}
async function state() { return (await request({ type: "browser-get-state" })).browserState; }
async function capture(name) {
  if (!page) return;
  if (name !== "failure.png") {
    await expect(page.getByText("Starting on this Mac…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".file-tab-view")).toBeVisible();
  }
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const png = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
async function menu(id, name) {
  await page.locator(`.browser-tab[data-tab-id="${id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}
try {
  app = await electron.launch({
    executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env,
  });
  assert.equal(realpathSync(await app.evaluate(({ app }) => app.getPath("userData"))), join(root, "profile"));
  page = await app.firstWindow(); page.setDefaultTimeout(15_000); window = await app.browserWindow(page);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload(); await window.evaluate(window => window.setSize(1100, 800));
  for (const kind of ["audio", "video"]) {
    const opened = (await request({ type: "browser-open-file-tabs", paths: [paths[kind]], active: true })).browserState;
    const id = opened.activeTabId; const otherId = opened.tabs.find(tab => !tab.file).id;
    const media = page.locator(`.file-tab-media-preview ${kind}`);
    await expect(media).toBeVisible();
    await expect.poll(() => media.evaluate(el => Number.isFinite(el.duration) && el.duration > 1 && el.readyState >= 2)).toBe(true);
    assert.equal(await media.evaluate(el => el.muted), false);
    const original = await media.elementHandle(); const source = await media.evaluate(el => el.currentSrc);
    await media.evaluate(el => { el.pause(); el.currentTime = 0.4; });
    await expect.poll(() => media.evaluate(el => el.currentTime)).toBeCloseTo(0.4, 1);
    await menu(id, "Mute tab");
    await expect.poll(() => media.evaluate(el => el.muted)).toBe(true);
    assert.equal((await state()).tabs.find(tab => tab.id === id).muted, true);
    assert(await media.evaluate((el, before) => el === before, original));
    assert.equal(await media.evaluate(el => el.currentSrc), source);
    assert(Math.abs(await media.evaluate(el => el.currentTime) - 0.4) < 0.1);
    await capture(`${kind}-muted.png`);
    await media.evaluate(async el => { el.loop = true; await el.play(); });
    await expect.poll(() => media.evaluate(el => el.paused)).toBe(false);
    await menu(id, "Unmute tab");
    await expect.poll(() => media.evaluate(el => el.muted)).toBe(false);
    assert.equal((await state()).tabs.find(tab => tab.id === id).muted, false);
    assert(await media.evaluate((el, before) => el === before, original));
    assert.equal(await media.evaluate(el => el.currentSrc), source);
    assert.equal(await media.evaluate(el => el.paused), false);
    await media.evaluate(el => el.pause());
    await menu(id, "Mute tab");
    await request({ type: "browser-select-tab", tabId: otherId });
    await request({ type: "browser-select-tab", tabId: id });
    await expect(media).toBeVisible();
    await expect.poll(() => media.evaluate(el => el.muted)).toBe(true);
    assert.equal((await state()).tabs.find(tab => tab.id === id).muted, true);
    await menu(id, "Unmute tab");
    await expect.poll(() => media.evaluate(el => el.muted)).toBe(false);
    await capture(`${kind}-unmuted.png`);
    assert.equal(await window.evaluate(window => window.contentView.children.filter(view => view.webContents).length), 0);
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    actualMenuAudioAndVideo: true, realMediaDecoded: true, mediaElementAndSourcePreserved: true,
    pausedPositionAndPlayingStatePreserved: true, nativePlayerStateSyncVerified: false,
    mutedTabReselectionPreserved: true, nativeWebViews: 0, fixtureProcessId: app.process().pid,
    silentFixtures: true, physicalAudioVerified: false, realProfileVerified: false }, null, 2));
  console.log("File media mute smoke passed: audio/video menu mute, unchanged playback, muted tab reselection, no native web view.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {}); rmSync(root, { recursive: true, force: true });
}
