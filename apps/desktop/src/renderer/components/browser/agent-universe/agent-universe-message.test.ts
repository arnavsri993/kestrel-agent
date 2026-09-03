import { describe, expect, it } from "vitest";
import {
	beginAgentUniverseMessage,
	createAgentUniverseMessageLifecycle,
	finishAgentUniverseMessage,
	isCurrentAgentUniverseMessage,
	isCurrentAgentUniverseStream,
	resetAgentUniverseMessage,
	unmountAgentUniverseMessage,
} from "./agent-universe-message";

describe("agent universe direct-message lifecycle", () => {
	it("rejects duplicate sends until the active request finishes", () => {
		const lifecycle = createAgentUniverseMessageLifecycle();
		const first = beginAgentUniverseMessage(lifecycle, "session-1", "stream-1");

		expect(first).not.toBeNull();
		expect(
			beginAgentUniverseMessage(lifecycle, "session-1", "stream-2"),
		).toBeNull();

		finishAgentUniverseMessage(lifecycle, first!);
		expect(beginAgentUniverseMessage(lifecycle, "session-1", "stream-2"))
			.toMatchObject({ requestId: 2 });
	});

	it("ignores late responses from an older request", () => {
		const lifecycle = createAgentUniverseMessageLifecycle();
		const first = beginAgentUniverseMessage(lifecycle, "session-1", "stream-1")!;
		finishAgentUniverseMessage(lifecycle, first);
		const second = beginAgentUniverseMessage(lifecycle, "session-1", "stream-2")!;

		expect(isCurrentAgentUniverseMessage(lifecycle, first)).toBe(false);
		expect(isCurrentAgentUniverseMessage(lifecycle, second)).toBe(true);
		expect(isCurrentAgentUniverseStream(lifecycle, "stream-1", "session-1")).toBe(
			false,
		);
		expect(isCurrentAgentUniverseStream(lifecycle, "stream-2", "session-2")).toBe(
			false,
		);
	});

	it("invalidates active work on reset and unmount", () => {
		const lifecycle = createAgentUniverseMessageLifecycle();
		const first = beginAgentUniverseMessage(lifecycle, "session-1", "stream-1")!;
		resetAgentUniverseMessage(lifecycle);
		expect(isCurrentAgentUniverseMessage(lifecycle, first)).toBe(false);

		const second = beginAgentUniverseMessage(lifecycle, "session-2", "stream-2")!;
		unmountAgentUniverseMessage(lifecycle);
		expect(isCurrentAgentUniverseMessage(lifecycle, second)).toBe(false);
		expect(
			beginAgentUniverseMessage(lifecycle, "session-2", "stream-3"),
		).toBeNull();
	});
});
