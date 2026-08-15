import type { SkinDefinition, SkinStatus } from "@kestrel/shared-types";

export function applySkin(skin: SkinDefinition): void {
	const root = document.documentElement;
	root.style.colorScheme = skin.mode;
	for (const [key, value] of Object.entries(skin.colors)) {
		const cssKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
		root.style.setProperty(`--${cssKey}`, value);
	}
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
