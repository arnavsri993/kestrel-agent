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
}

export async function loadInitialDesktopState(
	request: (input: StartupRequest) => Promise<CoreResponse>,
): Promise<InitialDesktopState> {
	const snapshotResponse = await request({ type: "snapshot" });
	if (!snapshotResponse.ok)
		throw new Error(
			snapshotResponse.error || "The local core rejected startup.",
		);
	if (!("snapshot" in snapshotResponse) || !snapshotResponse.snapshot)
		throw new Error("The local core returned no workspace state.");

	let sessions: RuntimeSession[] = [];
	try {
		const sessionsResponse = await request({ type: "runtime-list-sessions" });
		if (sessionsResponse.ok && "sessions" in sessionsResponse)
			sessions = sessionsResponse.sessions ?? [];
	} catch {
		// A saved-chat list is recoverable; the conversation can still start from
		// the verified snapshot and create a new session.
	}

	return { snapshot: snapshotResponse.snapshot, sessions };
}

export function startupFailureMessage(cause: unknown): string {
	const detail = userFacingError(cause, "");
	return detail
		? `Kestrel's local core could not start: ${detail}. Quit Kestrel completely and reopen it to retry.`
		: "Kestrel's local core could not start. Quit the app completely and reopen it to retry.";
}
