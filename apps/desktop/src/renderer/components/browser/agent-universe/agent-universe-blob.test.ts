import { describe, expect, it } from "vitest";
import {
	agentUniverseBlobPath,
	agentUniverseBlobTension,
	createAgentUniverseBlobGeometry,
} from "./agent-universe-blob";

describe("agent universe blob geometry", () => {
	it("keeps a stable, closed organic silhouette for an agent", () => {
		const first = createAgentUniverseBlobGeometry("worker-a", 40);
		const second = createAgentUniverseBlobGeometry("worker-a", 40);

		expect(first).toEqual(second);
		const path = agentUniverseBlobPath(first);
		expect(path.startsWith("M ")).toBe(true);
		expect(path.endsWith(" Z")).toBe(true);
		expect((path.match(/ C /g) ?? []).length).toBe(first.points.length);
	});

	it("deforms toward the parent without allowing unbounded tension", () => {
		const geometry = createAgentUniverseBlobGeometry("worker-b", 42);
		const resting = agentUniverseBlobPath(geometry);
		const pulled = agentUniverseBlobPath(geometry, 0.75, Math.PI);

		expect(pulled).not.toBe(resting);
		expect(agentUniverseBlobTension(1, 42)).toBeLessThan(0.01);
		expect(agentUniverseBlobTension(10_000, 42)).toBe(1);
	});
});
