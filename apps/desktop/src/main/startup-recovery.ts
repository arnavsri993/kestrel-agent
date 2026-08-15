import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isProtectedDatabaseError } from "@kestrel/database";
import { isSecureStorageError } from "./credential-broker";

export type StartupRecoveryKind = "secure-storage" | "protected-database" | "core";

export interface StartupRecoveryCopy {
	kind: StartupRecoveryKind;
	message: string;
	detail: string;
}

export interface ProtectedProfileArchive {
	archivePath: string;
	movedPaths: string[];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function archiveTimestamp(now: Date): string {
	return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * Move only the protected database and secure-storage directories into a
 * unique recovery folder. This deliberately leaves the original bytes intact
 * and does not reset the rest of the Kestrel user-data directory.
 */
export async function archiveProtectedProfile(
	userDataPath: string,
	now: Date = new Date(),
): Promise<ProtectedProfileArchive> {
	const sources = [
		join(userDataPath, "database"),
		join(userDataPath, "secure"),
	];
	const existingSources: string[] = [];
	for (const source of sources) {
		if (await pathExists(source)) existingSources.push(source);
	}
	if (existingSources.length === 0)
		throw new Error("No protected Kestrel profile files were found to archive.");

	const recoveryRoot = join(userDataPath, "recovery");
	await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
	const archivePath = join(
		recoveryRoot,
		`protected-profile-${archiveTimestamp(now)}-${randomUUID()}`,
	);
	await mkdir(archivePath, { mode: 0o700 });

	const movedPaths: string[] = [];
	try {
		for (const source of existingSources) {
			const destination = join(archivePath, basename(source));
			await rename(source, destination);
			movedPaths.push(destination);
		}
	} catch (error) {
		for (const destination of movedPaths.slice().reverse()) {
			const source = join(userDataPath, basename(destination));
			await rename(destination, source).catch(() => undefined);
		}
		await rm(archivePath, { recursive: true, force: true }).catch(
			() => undefined,
		);
		throw error;
	}

	return { archivePath, movedPaths };
}

function errorDetail(cause: unknown): string {
	return cause instanceof Error
		? cause.message.trim()
		: typeof cause === "string"
			? cause.trim()
			: "An unknown startup error occurred.";
}

export function startupRecoveryCopy(cause: unknown): StartupRecoveryCopy {
	const detail = errorDetail(cause);
	if (isProtectedDatabaseError(cause))
		return {
			kind: "protected-database",
			message: "Kestrel's encrypted profile could not be opened.",
			detail: `${detail}\n\nKestrel will not overwrite or delete this profile. Choose “Start fresh (keep backup)” to move the encrypted database and secure files into a timestamped recovery folder, then open a new empty profile. Choose Try again after restoring the original protected database key.`,
		};
	if (isSecureStorageError(cause))
		return {
			kind: "secure-storage",
			message: "Kestrel needs access to its encrypted data.",
			detail: `${detail}\n\nKestrel will not open your data without its encryption boundary. Unlock the login keychain and choose “Always Allow” for Kestrel Safe Storage, then try again.`,
		};
	return {
		kind: "core",
		message: "Kestrel's local Agent Core could not start.",
		detail: `${detail}\n\nThis is separate from Keychain access. Fix the reported Agent Core error or choose Try again.`,
	};
}
