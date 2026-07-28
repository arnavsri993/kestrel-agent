import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const appArgument = process.argv[2];
if (process.platform !== "darwin")
  throw new Error("Development app signing is only available on macOS.");
if (!appArgument) throw new Error("Pass the packaged .app path to sign.");

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
const expectedBundles = [
  [appInfo, "com.kestrel.desktop.dev"],
  [
    join(
      appPath,
      "Contents",
      "Frameworks",
      "Kestrel Helper.app",
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper",
  ],
  [
    join(
      appPath,
      "Contents",
      "Frameworks",
      "Kestrel Helper (Renderer).app",
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper.Renderer",
  ],
  [
    join(
      appPath,
      "Contents",
      "Frameworks",
      "Kestrel Helper (GPU).app",
      "Contents",
      "Info.plist",
    ),
    "com.kestrel.desktop.dev.helper.GPU",
  ],
  [
    join(
      appPath,
      "Contents",
      "Frameworks",
      "Kestrel Helper (Plugin).app",
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

runCodesign(["--force", "--deep", "--sign", "-", appPath], {
  stdio: "inherit",
});
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

console.log(`Verified ad-hoc development signature: ${appPath}`);
