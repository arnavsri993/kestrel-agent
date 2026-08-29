import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repositoryRoot, "packages/database/migrations");

if (!existsSync(join(source, "001_initial.sql"))) {
	throw new Error("Canonical database migrations are missing from the repository.");
}

for (const target of process.argv.slice(2)) {
	const resolved = join(repositoryRoot, target);
	mkdirSync(resolved, { recursive: true });
	cpSync(source, resolved, { recursive: true });
	process.stdout.write(`Copied database migrations to ${resolved}\n`);
}
