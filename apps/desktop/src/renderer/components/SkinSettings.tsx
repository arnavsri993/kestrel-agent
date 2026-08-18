import type { SkinDefinition, SkinStatus } from "@kestrel/shared-types";

// Skin IDs, imports, and persistence remain part of the public application
// contract. Rendering is intentionally narrower: Kestrel is a monochrome
// instrument, so legacy and custom palettes are mapped onto one grayscale
// semantic ramp instead of leaking color into the UI.
const MONOCHROME_TOKENS = {
	canvas: "#0e0e10",
	sidebar: "#131316",
	sidebarHover: "#1e1e22",
	surface: "#1e1e22",
	surfaceStrong: "#26262b",
	panel: "#17171a",
	ink: "#f4f4f6",
	muted: "#9c9ca6",
	faint: "#6e6e78",
	line: "rgba(255, 255, 255, 0.08)",
	lineStrong: "rgba(255, 255, 255, 0.16)",
	solid: "#f4f4f6",
	solidHover: "#ffffff",
	solidText: "#0e0e10",
	signal: "#f4f4f6",
	signalDeep: "#ffffff",
	statusSoft: "#2d2d31",
	statusInk: "#f4f4f6",
	healthy: "#f4f4f6",
	warning: "#c8c8cc",
	warningSoft: "#2a2a2e",
	warningInk: "#e8e8eb",
	danger: "#a8a8ae",
	dangerSoft: "#242428",
	dangerInk: "#dedee2",
	brand: "#ffffff",
} as const;

export function applySkin(skin: SkinDefinition): void {
	void skin;
	const root = document.documentElement;
	root.style.colorScheme = "dark";
	root.dataset.kestrelMonochrome = "true";
	for (const [key, value] of Object.entries(MONOCHROME_TOKENS)) {
		const cssKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
		root.style.setProperty(`--${cssKey}`, value);
	}
	root.style.setProperty("--ink-secondary", MONOCHROME_TOKENS.muted);
	root.style.setProperty("--overlay", MONOCHROME_TOKENS.surfaceStrong);
	root.style.setProperty("--signal-strong", MONOCHROME_TOKENS.signalDeep);
	root.style.setProperty("--signal-soft", MONOCHROME_TOKENS.statusSoft);
	root.style.setProperty("--signal-ink", MONOCHROME_TOKENS.statusInk);
	root.style.setProperty("--on-signal", MONOCHROME_TOKENS.solidText);
	root.style.setProperty("--info", MONOCHROME_TOKENS.muted);
	root.style.setProperty("--info-soft", MONOCHROME_TOKENS.statusSoft);
	root.style.setProperty(
		"--glow-signal",
		"0 0 0 1px rgba(255, 255, 255, 0.34), 0 0 24px rgba(255, 255, 255, 0.1)",
	);
	root.style.setProperty(
		"--focus-ring",
		"0 0 0 2px var(--canvas), 0 0 0 4px var(--signal)",
	);
}

export function SkinSettings({
	status,
	onChange,
}: {
	status: SkinStatus | null;
	onChange(status: SkinStatus): void;
}) {
	return null;
}
