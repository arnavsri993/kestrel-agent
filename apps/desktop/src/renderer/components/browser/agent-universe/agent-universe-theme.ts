export type AgentUniverseColorId =
	| "red"
	| "yellow"
	| "green";

export interface AgentUniverseSystemColor {
	id: AgentUniverseColorId;
	label: string;
	css: string;
	surface: string;
	core: string;
	highlight: string;
}

export const AGENT_UNIVERSE_SYSTEM_COLORS: readonly AgentUniverseSystemColor[] = [
	// These are the same identifying hues as Kestrel's triangular macOS window
	// controls. The scene renders them through a graphite mix so a large body
	// keeps the hue without turning into a neon disc.
	{
		id: "red",
		label: "Red",
		css: "#f45146",
		surface: "#a94b44",
		core: "#63302d",
		highlight: "#ed9189",
	},
	{
		id: "yellow",
		label: "Yellow",
		css: "#fcb600",
		surface: "#b4861e",
		core: "#705311",
		highlight: "#f1cc6d",
	},
	{
		id: "green",
		label: "Green",
		css: "#00bc00",
		surface: "#3b8f4d",
		core: "#225f30",
		highlight: "#8bd399",
	},
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
