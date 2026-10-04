import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

/**
 * This is a tripwire, not the safety boundary. Runtime invariant samples and
 * the absence of a fallback are enforced by ComputerUseManager and the native
 * bridge. Keep these patterns narrow so harmless cursor/activity reads are not
 * mistaken for input injection.
 */
export const FORBIDDEN_BACKGROUND_COMPUTER_USE_PATTERNS = [
	/\bCGWarpMouseCursorPosition\b/,
	/\bCGEventPost\b/,
	/\bCGEvent\.post(?:ToPid)?\b/,
	/\bCGEventTapCreate(?:ForPid)?\b/,
	/\bcghidEventTap\b/,
	/\bcgSessionEventTap\b/,
	/\bannotatedSessionEventTap\b/,
	/\bNSRunningApplication\s*\.\s*activate(?:WithOptions)?\b/,
	/\bactivateWithOptions\b/,
	/\bactivateIgnoringOtherApps\b/,
	/\bmakeKeyAndOrderFront\b/,
	/\bAXRaise\b/,
	/\bNSPasteboard\b/,
	/\bosascript\b/,
	/\bpyautogui\b/i,
	/\brobotjs\b/i,
	/\bcliclick\b/i,
	/\bnut\.js\b/i,
	/\bCGS(?:MainConnection|SetWindow|OrderWindow)\b/,
	/\bSLS(?:MainConnection|SetWindow|OrderWindow)\b/,
];

export const BACKGROUND_COMPUTER_USE_IMPLEMENTATION_FILES = [
	"apps/desktop/native/background-computer-use.mm",
	"apps/desktop/src/main/computer-use.ts",
	"packages/agent-core/src/computer-use.ts",
];

export function findForbiddenBackgroundComputerUseApis(
	root = process.cwd(),
	files = BACKGROUND_COMPUTER_USE_IMPLEMENTATION_FILES,
) {
	const violations = [];
	for (const relativePath of files) {
		const path = resolve(root, relativePath);
		let source;
		try {
			source = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const lines = source.split(/\r?\n/);
		for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
			for (const pattern of FORBIDDEN_BACKGROUND_COMPUTER_USE_PATTERNS) {
				if (!pattern.test(lines[lineNumber])) continue;
				pattern.lastIndex = 0;
				violations.push({
					path,
					line: lineNumber + 1,
					text: lines[lineNumber].trim().slice(0, 240),
					pattern: pattern.source,
				});
			}
		}
	}
	return violations;
}

export function verifyBackgroundComputerUseSafety(root = process.cwd()) {
	const violations = findForbiddenBackgroundComputerUseApis(root);
	if (violations.length > 0) {
		throw new Error(
			`Forbidden API found in the background computer-use implementation:\n${violations
				.map((violation) => `${violation.path}:${violation.line}: ${violation.text}`)
				.join("\n")}`,
		);
	}
	return { checkedFiles: BACKGROUND_COMPUTER_USE_IMPLEMENTATION_FILES.map((file) => join(root, file)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	verifyBackgroundComputerUseSafety();
	console.log("Background computer-use forbidden-API audit passed.");
}
