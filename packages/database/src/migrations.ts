import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_INITIAL_MIGRATION = "001_initial.sql";

function resolveMigrationsDirectory(): string {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDirectory, "../migrations"),
		join(moduleDirectory, "migrations"),
	];
	if (typeof process === "object" && process !== null) {
		const resourcesPath = Reflect.get(process, "resourcesPath");
		if (typeof resourcesPath === "string") {
			candidates.push(join(resourcesPath, "database-migrations"));
		}
	}
	let workspaceRoot = process.cwd();
	for (let depth = 0; depth < 8; depth += 1) {
		candidates.push(join(workspaceRoot, "packages/database/migrations"));
		const parent = dirname(workspaceRoot);
		if (parent === workspaceRoot) break;
		workspaceRoot = parent;
	}
	try {
		const require = createRequire(import.meta.url);
		candidates.unshift(
			dirname(
				require.resolve(
					`@kestrel/database/migrations/${CANONICAL_INITIAL_MIGRATION}`,
				),
			),
		);
	} catch {
		// Packaged CLI bundles inline migration code without the workspace package.
	}
	for (const candidate of candidates) {
		if (existsSync(join(candidate, CANONICAL_INITIAL_MIGRATION))) return candidate;
	}
	throw new Error(
		`Kestrel database migrations are unavailable (searched: ${candidates.join(", ")}).`,
	);
}

const migrationsDirectory = resolveMigrationsDirectory();

export const MIGRATION_SQL_FILES: Record<number, string> = {
	1: "001_initial.sql",
	2: "002_agent_runtime.sql",
	3: "003_runtime_history.sql",
	4: "004_agent_loop.sql",
	5: "005_runtime_message_order.sql",
	6: "006_private_runtime_state.sql",
	7: "007_idempotency_claims.sql",
	8: "008_memory_metadata.sql",
	9: "009_agent_configuration.sql",
	10: "010_browser_activity.sql",
	11: "011_action_receipts.sql",
	12: "012_memory_substrate.sql",
	13: "013_memory_timeline_links.sql",
	14: "014_memory_entity_ambiguity.sql",
	15: "015_memory_provenance_updated_at.sql",
	16: "016_memory_timeline_source_metadata.sql",
};

export const LATEST_SCHEMA_VERSION = Math.max(
	...Object.keys(MIGRATION_SQL_FILES).map(Number),
);

let migrationSqlOverridesForTests: Map<number, string> | undefined;

export function setMigrationSqlOverridesForTests(
	overrides: Map<number, string> | undefined,
): void {
	migrationSqlOverridesForTests = overrides;
}

export function loadMigrationSql(version: number): string {
	const override = migrationSqlOverridesForTests?.get(version);
	if (override !== undefined) return override;
	const filename = MIGRATION_SQL_FILES[version];
	if (!filename)
		throw new Error(`Unknown schema migration version ${version}.`);
	return readFileSync(join(migrationsDirectory, filename), "utf8");
}

export function listMigrationVersions(): number[] {
	return Object.keys(MIGRATION_SQL_FILES)
		.map(Number)
		.sort((left, right) => left - right);
}

export function resolveMigrationBackupDirectory(databasePath: string): string {
	return join(dirname(databasePath), "backups");
}

export function backupDatabaseBeforeMigration(
	databasePath: string,
	nextVersion: number,
	now: Date = new Date(),
): string {
	const backupsDirectory = resolveMigrationBackupDirectory(databasePath);
	mkdirSync(backupsDirectory, { recursive: true, mode: 0o700 });
	const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const backupName = `pre-migrate-v${String(nextVersion).padStart(3, "0")}-${timestamp}.sqlite`;
	const backupPath = join(backupsDirectory, backupName);
	const temporaryPath = `${backupPath}.${process.pid}.tmp`;

	copyFileSync(databasePath, temporaryPath);
	for (const suffix of ["-wal", "-shm"]) {
		const sidecarPath = `${databasePath}${suffix}`;
		if (existsSync(sidecarPath))
			copyFileSync(sidecarPath, `${temporaryPath}${suffix}`);
	}

	renameSync(temporaryPath, backupPath);
	for (const suffix of ["-wal", "-shm"]) {
		const temporarySidecar = `${temporaryPath}${suffix}`;
		if (existsSync(temporarySidecar))
			renameSync(temporarySidecar, `${backupPath}${suffix}`);
	}

	return backupPath;
}
