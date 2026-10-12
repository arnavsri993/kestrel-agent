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
async function decodedFrame(media, kind) {
  await expect.poll(() => media.evaluate(el => el.readyState >= 2 && !el.seeking)).toBe(true);
  if (kind !== "video") return;
  await media.evaluate(el => new Promise((resolveFrame, rejectFrame) => {
    const callback = el.requestVideoFrameCallback(() => {
      clearTimeout(timeout); el.pause(); resolveFrame();
    });
    const timeout = setTimeout(() => {
      el.cancelVideoFrameCallback(callback); rejectFrame(new Error("Video frame was not presented."));
    }, 10_000);
    el.play().catch(error => {
      clearTimeout(timeout); el.cancelVideoFrameCallback(callback); rejectFrame(error);
    });
  }));
  assert.deepEqual(await media.evaluate(el => [el.videoWidth, el.videoHeight]), [320, 180]);
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
    await decodedFrame(media, kind);
    assert.equal(await media.evaluate(el => el.muted), false);
    const original = await media.elementHandle(); const source = await media.evaluate(el => el.currentSrc);
    await media.evaluate(el => { el.pause(); el.currentTime = 0.4; });
    await expect.poll(() => media.evaluate(el => el.currentTime)).toBeCloseTo(0.4, 1);
    await expect.poll(() => media.evaluate(el => !el.seeking && el.readyState >= 2)).toBe(true);
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
    await decodedFrame(media, kind);
    assert.equal((await state()).tabs.find(tab => tab.id === id).muted, true);
    await menu(id, "Unmute tab");
    await expect.poll(() => media.evaluate(el => el.muted)).toBe(false);
    await capture(`${kind}-unmuted.png`);
    assert.equal(await window.evaluate(window => window.contentView.children.filter(view => view.webContents).length), 0);
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    actualMenuAudioAndVideo: true, realMediaDecoded: true, videoFramePresented: true, mediaElementAndSourcePreserved: true,
    pausedPositionAndPlayingStatePreserved: true, nativePlayerStateSyncVerified: false,
    mutedTabReselectionPreserved: true, nativeWebViews: 0, fixtureProcessId: app.process().pid,
    silentFixtures: true, physicalAudioVerified: false, realProfileVerified: false }, null, 2));
  console.log("File media mute smoke passed: audio/video menu mute, unchanged playback, muted tab reselection, no native web view.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {}); rmSync(root, { recursive: true, force: true });
}
