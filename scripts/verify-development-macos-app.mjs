import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const appArgument = process.argv[2];
if (process.platform !== "darwin")
  throw new Error("Development app verification is only available on macOS.");
if (!appArgument) throw new Error("Pass the packaged .app path to verify.");

const appPath = resolve(process.cwd(), appArgument);
if (
  !appPath.endsWith(".app") ||
  !existsSync(appPath) ||
  !statSync(appPath).isDirectory()
)
  throw new Error(`Packaged app not found: ${appPath}`);

const runCodesign = (arguments_, options = {}) => {
  const result = spawnSync("/usr/bin/codesign", arguments_, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `codesign ${arguments_.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
};

const readPlistValue = (path, key) => {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `Could not read ${key} from ${path}${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result.stdout.trim();
};

const appInfo = join(appPath, "Contents", "Info.plist");
const helperApps = [
  "Kestrel Helper.app",
  "Kestrel Helper (Renderer).app",
  "Kestrel Helper (GPU).app",
  "Kestrel Helper (Plugin).app",
].map((name) => join(appPath, "Contents", "Frameworks", name));
const expectedBundles = [
  [appInfo, "com.kestrel.desktop.dev"],
  [
    join(
      helperApps[0],
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper",
  ],
  [
    join(
      helperApps[1],
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper.Renderer",
  ],
  [
    join(
      helperApps[2],
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper.GPU",
  ],
  [
    join(
      helperApps[3],
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper.Plugin",
  ],
];
for (const [plist, expectedIdentifier] of expectedBundles) {
  const identifier = readPlistValue(plist, "CFBundleIdentifier");
  if (identifier !== expectedIdentifier)
    throw new Error(
      `Development bundle identity is ${identifier}; expected ${expectedIdentifier}.`,
    );
}
const releaseChannel = readPlistValue(
  appInfo,
  "LSEnvironment.KESTREL_RELEASE_CHANNEL",
);
if (releaseChannel !== "development")
  throw new Error(
    `Development launch channel is ${releaseChannel}; expected development.`,
  );

const executablePath = join(appPath, "Contents", "MacOS", "Kestrel");
const architecture = spawnSync("/usr/bin/lipo", ["-archs", executablePath], {
  encoding: "utf8",
});
if (architecture.status !== 0 || architecture.stdout.trim() !== "arm64") {
  const detail = `${architecture.stdout ?? ""}${architecture.stderr ?? ""}`.trim();
  throw new Error(
    `Development app architecture must be arm64${detail ? `; received ${detail}` : "."}`,
  );
}

runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  stdio: "inherit",
});

const evidence = runCodesign(["-dv", "--verbose=4", appPath]);
const signature = `${evidence.stdout}${evidence.stderr}`;
for (const marker of [
  "Identifier=com.kestrel.desktop.dev",
  "Signature=adhoc",
  "TeamIdentifier=not set",
]) {
  if (!signature.includes(marker))
    throw new Error(`Development app signature is missing ${marker}.`);
}
if (!/flags=.*\([^)]*runtime/.test(signature))
  throw new Error("Development app signature is missing hardened runtime.");

const requiredEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];
for (const target of [appPath, ...helperApps]) {
  const entitlementResult = runCodesign(["-d", "--entitlements", "-", target]);
  const entitlements = `${entitlementResult.stdout}${entitlementResult.stderr}`;
  for (const entitlement of requiredEntitlements) {
    if (!entitlements.includes(entitlement))
      throw new Error(`${target} is missing the ${entitlement} entitlement.`);
  }

  const targetEvidence = runCodesign(["-dv", "--verbose=4", target]);
  const targetSignature = `${targetEvidence.stdout}${targetEvidence.stderr}`;
  if (
    !targetSignature.includes("Signature=adhoc") ||
    !/flags=.*\([^)]*runtime/.test(targetSignature)
  )
    throw new Error(`${target} is not ad-hoc signed with hardened runtime.`);
}

console.log(`Verified ad-hoc development signature: ${appPath}`);
