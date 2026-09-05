import type { AgentUniversePoint } from "./agent-universe-camera";
import type { AgentUniverseSystemPosition } from "./agent-universe-layout";

const AGENT_UNIVERSE_POSITIONS_STORAGE_KEY =
	"kestrel:agent-universe-system-positions";
const MIN_STORED_POSITION = -3;
const MAX_STORED_POSITION = 4;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function safeDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function isStoredPosition(value: unknown): value is AgentUniverseSystemPosition {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<AgentUniverseSystemPosition>;
	return (
		typeof candidate.x === "number" &&
		Number.isFinite(candidate.x) &&
		typeof candidate.y === "number" &&
		Number.isFinite(candidate.y)
	);
}

/** Convert a map-plane point into a size-independent persisted placement. */
export function normalizedAgentUniversePositionForPoint(
	point: AgentUniversePoint,
	width: number,
	height: number,
): AgentUniverseSystemPosition | undefined {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
	return {
		x: clamp(point.x / safeWidth, MIN_STORED_POSITION, MAX_STORED_POSITION),
		y: clamp(point.y / safeHeight, MIN_STORED_POSITION, MAX_STORED_POSITION),
	};
}

export function readAgentUniverseSystemPositions(): Record<
	string,
	AgentUniverseSystemPosition
> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(AGENT_UNIVERSE_POSITIONS_STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).flatMap(([id, value]) => {
				if (!id || !isStoredPosition(value)) return [];
				return [
					[
						id,
						{
							x: clamp(value.x, MIN_STORED_POSITION, MAX_STORED_POSITION),
							y: clamp(value.y, MIN_STORED_POSITION, MAX_STORED_POSITION),
						},
					] as const,
				];
			}),
		);
	} catch {
		return {};
	}
}

export function writeAgentUniverseSystemPositions(
	positions: Readonly<Record<string, AgentUniverseSystemPosition>>,
): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			AGENT_UNIVERSE_POSITIONS_STORAGE_KEY,
			JSON.stringify(positions),
		);
	} catch {
		// Placement is a local preference. A storage failure must not block dragging.
	}
}
