import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vscodeRoot = resolve(root, "editors/vscode-kestrel");
const jetbrainsRoot = resolve(root, "editors/jetbrains-kestrel");
const manifest = JSON.parse(
	readFileSync(resolve(vscodeRoot, "package.json"), "utf8"),
);
if (
	manifest.main !== "./extension.js" ||
	!manifest.contributes?.commands?.some(
		(command) => command.command === "kestrel.startTask",
	)
)
	throw new Error("VS Code manifest does not expose the Kestrel task command.");
execFileSync(
	process.execPath,
	["--check", resolve(vscodeRoot, "extension.js")],
	{ stdio: "inherit" },
);
const vscode = readFileSync(resolve(vscodeRoot, "extension.js"), "utf8");
for (const marker of [
	"session/request_permission",
	"fs/read_text_file",
	"fs/write_text_file",
	"terminal/create",
	"session/cancel",
	"shell: false",
])
	if (!vscode.includes(marker))
		throw new Error(`VS Code integration is missing ${marker}.`);
const pluginXml = readFileSync(
	resolve(jetbrainsRoot, "src/main/resources/META-INF/plugin.xml"),
	"utf8",
);
if (
	!pluginXml.includes('toolWindow id="Kestrel"') ||
	!pluginXml.includes("KestrelToolWindowFactory")
)
	throw new Error(
		"JetBrains plugin does not register its native Kestrel tool window.",
	);
const build = readFileSync(resolve(jetbrainsRoot, "build.gradle.kts"), "utf8");
if (
	!build.includes('org.jetbrains.intellij.platform") version "2.18.1"') ||
	!build.includes('intellijIdea("2026.1")')
)
	throw new Error(
		"JetBrains plugin does not target the reviewed platform contract.",
	);
const jetbrains = readFileSync(
	resolve(
		jetbrainsRoot,
		"src/main/java/dev/kestrel/jetbrains/KestrelToolWindowFactory.java",
	),
	"utf8",
);
for (const marker of [
	"session/request_permission",
	"fs/read_text_file",
	"fs/write_text_file",
	"terminal/create",
	"session/cancel",
	"new ProcessBuilder(command)",
])
	if (!jetbrains.includes(marker))
		throw new Error(`JetBrains integration is missing ${marker}.`);
process.stdout.write(
	"Editor integration manifests, syntax, and ACP client surfaces verified.\n",
);
