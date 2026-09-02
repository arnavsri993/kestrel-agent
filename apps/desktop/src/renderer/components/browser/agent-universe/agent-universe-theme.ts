export type AgentUniverseColorId =
	| "red"
	| "yellow"
	| "green";

export interface AgentUniverseSystemColor {
	id: AgentUniverseColorId;
	label: string;
	css: string;
}

export const AGENT_UNIVERSE_SYSTEM_COLORS: readonly AgentUniverseSystemColor[] = [
	// Use the familiar macOS traffic-light hues as small, solid identity
	// accents. The scene controls opacity and contrast; the palette itself does
	// not invent gradients, provider colors, or decorative neon variants.
	{ id: "red", label: "Red", css: "#ff5f57" },
	{ id: "yellow", label: "Yellow", css: "#febc2e" },
	{ id: "green", label: "Green", css: "#28c840" },
];

const SYSTEM_COLOR_STORAGE_KEY = "kestrel:agent-universe-system-colors";

function stableHash(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function isColorId(value: unknown): value is AgentUniverseColorId {
	return AGENT_UNIVERSE_SYSTEM_COLORS.some((color) => color.id === value);
}


export function defaultAgentUniverseColorId(
	systemId: string,
	_status?: unknown,
): AgentUniverseColorId {
	// System color is identity, not status. A stable traffic-light assignment
	// keeps a busy overview legible without turning every active session green;
	// status is communicated separately by size, opacity, and rim treatment.
	return AGENT_UNIVERSE_SYSTEM_COLORS[stableHash(systemId) % AGENT_UNIVERSE_SYSTEM_COLORS.length]!.id;
}

export function agentUniverseColorFor(
	systemId: string,
	overrides: Readonly<Record<string, AgentUniverseColorId>> = {},
	status?: unknown,
): AgentUniverseSystemColor {
	const requested = overrides[systemId];
	const id = requested ?? defaultAgentUniverseColorId(systemId, status);
	return (
		AGENT_UNIVERSE_SYSTEM_COLORS.find((color) => color.id === id) ??
		AGENT_UNIVERSE_SYSTEM_COLORS[0]!
	);
}

export function readAgentUniverseSystemColors(): Record<string, AgentUniverseColorId> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(SYSTEM_COLOR_STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, AgentUniverseColorId] =>
				typeof entry[0] === "string" && isColorId(entry[1]),
		));
	} catch {
		return {};
	}
}

export function writeAgentUniverseSystemColors(
	colors: Readonly<Record<string, AgentUniverseColorId>>,
): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(SYSTEM_COLOR_STORAGE_KEY, JSON.stringify(colors));
	} catch {
		// Local preferences are optional. A storage failure must not block the map.
	}
}
