import { readFile } from "node:fs/promises";
import process from "node:process";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const fail = (message) => {
  console.error(`Market release gate failed: ${message}`);
  process.exitCode = 1;
};

const [builder, desktopPackage, workflow, websiteWorkflow, privacy, support, rootPackage] = await Promise.all([
  read("apps/desktop/electron-builder.yml"),
  read("apps/desktop/package.json"),
  read(".github/workflows/release-macos.yml"),
  read(".github/workflows/deploy-website.yml"),
  read("apps/website/src/app/privacy/page.tsx"),
  read("apps/website/src/app/support/page.tsx"),
  read("package.json")
]);

for (const [name, source] of [["privacy", privacy], ["support", support]]) {
  if (/TODO|TBD|example\\.com|your[- ]?(email|company)/i.test(source)) fail(`${name} route contains a release placeholder.`);
}

for (const marker of ["arch: [arm64]", "Kestrel-Apple-Silicon-", "hardenedRuntime: true", "target: dmg", "target: zip", "target: pkg", "provider: generic", "${env.KESTREL_UPDATE_URL}", "channel: latest"]) {
  if (!builder.includes(marker)) fail(`desktop packaging is missing ${marker}.`);
}
for (const forbidden of ["universal", "x64", "mas", "app-store"]) {
  if (builder.toLowerCase().includes(forbidden)) fail(`desktop packaging still contains unsupported target ${forbidden}.`);
}
for (const marker of ["--arm64", "uname -m", "test:local-ai:real", "codesign --verify", "stapler validate", "spctl --assess", "pkgutil --check-signature", 'lipo -archs', '= \"arm64\"', "KESTREL_UPDATE_URL", "release/*.dmg", "release/*.zip", "release/*.pkg", "release/*.blockmap", "latest-mac.yml", "SHA256SUMS", "release-manifest.json"]) {
  if (!workflow.includes(marker)) fail(`macOS release workflow is missing ${marker}.`);
}
for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
  if (!workflow.includes(secret)) fail(`macOS release workflow is missing ${secret}.`);
}
if (!workflow.includes("test:packaged-desktop:arm64")) fail("macOS release workflow does not smoke-test the signed packaged application.");
for (const marker of ["actions/configure-pages@v5", "actions/upload-pages-artifact@v3", "actions/deploy-pages@v4", "NEXT_PUBLIC_BASE_PATH", "NEXT_PUBLIC_SITE_URL"]) {
  if (!websiteWorkflow.includes(marker)) fail(`website deployment workflow is missing ${marker}.`);
}
if (!desktopPackage.includes('"package:mac:dev"') || !desktopPackage.includes("--arm64")) fail("desktop development packaging must target arm64.");
if (!desktopPackage.includes('"package:mac:mdm"') || !desktopPackage.includes("--mac pkg")) fail("desktop MDM packaging must provide an arm64 PKG target.");
if (/package:mac:universal|test:packaged-desktop:universal/.test(`${desktopPackage}\n${rootPackage}`)) fail("universal desktop scripts remain configured.");
if (!rootPackage.includes("pnpm test:desktop-setup")) fail("the market verification command does not exercise guided local-AI setup.");

if (process.argv.includes("--distribution")) {
  for (const name of ["PUBLIC_SITE_URL", "PUBLIC_SUPPORT_URL", "PUBLIC_PRIVACY_URL", "PUBLIC_DOWNLOAD_URL", "PUBLIC_RELEASE_MANIFEST_URL", "PUBLIC_RELEASE_CHECKSUMS_URL", "PUBLIC_PUBLISHER_NAME", "PUBLIC_SUPPORT_EMAIL"]) {
    if (!process.env[name]?.trim()) fail(`${name} is required for distribution.`);
  }
  for (const name of ["PUBLIC_SITE_URL", "PUBLIC_SUPPORT_URL", "PUBLIC_PRIVACY_URL", "PUBLIC_DOWNLOAD_URL", "PUBLIC_RELEASE_MANIFEST_URL", "PUBLIC_RELEASE_CHECKSUMS_URL"]) {
    try {
      const url = new URL(process.env[name]);
      if (url.protocol !== "https:") fail(`${name} must use HTTPS.`);
    } catch {
      fail(`${name} must be a valid absolute URL.`);
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(process.env.PUBLIC_SUPPORT_EMAIL ?? "")) {
    fail("PUBLIC_SUPPORT_EMAIL must be a valid public email address.");
  }
  for (const [name, marker] of [["PUBLIC_SITE_URL", "Kestrel"], ["PUBLIC_SUPPORT_URL", "Product support"], ["PUBLIC_PRIVACY_URL", "Privacy boundary"]]) {
    try {
      const response = await fetch(process.env[name], { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const body = await response.text();
      if (!response.ok) fail(`${name} returned HTTP ${response.status}.`);
      if (!body.includes(marker)) fail(`${name} does not contain the expected Kestrel release marker.`);
      if (response.url.startsWith("http:")) fail(`${name} redirected away from HTTPS.`);
    } catch (error) {
      fail(`${name} could not be verified: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
}

if (!process.exitCode) {
  console.log(`Apple Silicon internet release gate passed (${process.argv.includes("--distribution") ? "distribution" : "repository"} mode).`);
}
