import type {
	CoreResponse,
	RuntimeSession,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { userFacingError } from "./error-copy";

type StartupRequest = { type: "snapshot" } | { type: "runtime-list-sessions" };

export interface InitialDesktopState {
	snapshot: WorkspaceSnapshot;
	sessions: RuntimeSession[];
	selectedSessionId: string | null;
	sessionsLoadError?: string;
}

export async function loadInitialDesktopState(
	request: (input: StartupRequest) => Promise<CoreResponse>,
	onSnapshot?: (snapshot: WorkspaceSnapshot) => void,
): Promise<InitialDesktopState> {
	const snapshotResponse = await request({ type: "snapshot" });
	if (!snapshotResponse.ok)
		throw new Error(
			snapshotResponse.error || "The local core rejected startup.",
		);
	if (!("snapshot" in snapshotResponse) || !snapshotResponse.snapshot)
		throw new Error("The local core returned no workspace state.");
	onSnapshot?.(snapshotResponse.snapshot);

	let sessions: RuntimeSession[] = [];
	let selectedSessionId: string | null = null;
	let sessionsLoadError: string | undefined;
	try {
		const sessionsResponse = await request({ type: "runtime-list-sessions" });
		if (!sessionsResponse.ok) {
			sessionsLoadError = sessionsResponse.error || "Session list unavailable.";
		} else if ("sessions" in sessionsResponse) {
			sessions = sessionsResponse.sessions ?? [];
			const candidate = sessionsResponse.selectedSessionId;
			if (
				typeof candidate === "string" &&
				sessions.some(
					(session) => session.id === candidate && !session.forgottenAt,
				)
			)
				selectedSessionId = candidate;
		}
	} catch (cause) {
		// A saved-chat list is recoverable; the conversation can still start from
		// the verified snapshot and create a new session.
		sessionsLoadError =
			cause instanceof Error ? cause.message : "Session list unavailable.";
	}

	return {
		snapshot: snapshotResponse.snapshot,
		sessions,
		selectedSessionId,
		...(sessionsLoadError ? { sessionsLoadError } : {}),
	};
}

// A snapshot event received while the initial request is in flight is newer
// than that request's response and must remain visible.
export function createStartupSnapshotGate(
	apply: (snapshot: WorkspaceSnapshot) => void,
) {
	let receivedEvent = false;
	return {
		initial(snapshot: WorkspaceSnapshot) {
			if (!receivedEvent) apply(snapshot);
		},
		event(snapshot: WorkspaceSnapshot) {
			receivedEvent = true;
			apply(snapshot);
		},
	};
}

export function startupFailureMessage(cause: unknown): string {
	const detail = userFacingError(cause, "");
	return detail
		? `Kestrel's local core could not start: ${detail}. Quit Kestrel completely and reopen it to retry.`
		: "Kestrel's local core could not start. Quit the app completely and reopen it to retry.";
}
