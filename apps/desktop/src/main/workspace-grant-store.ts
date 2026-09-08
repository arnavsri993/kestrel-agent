import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import {
	type Project,
	ProjectSchema,
} from "@kestrel/shared-types";

const mutationQueues = new Map<string, Promise<void>>();
const LEGACY_PROJECT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Project identity is derived from the canonical folder path for legacy
 * grants. That lets an existing workspace grant acquire a stable project ID
 * without guessing which conversations belong together or writing a second
 * project registry.
 */
export function projectIdForPath(path: string): string {
	return `project-${createHash("sha256")
		.update(`kestrel-project:${resolve(path)}`)
		.digest("hex")
		.slice(0, 32)}`;
}

type StoredProject = Omit<Project, "available">;

function projectWithoutAvailability(project: Project): StoredProject {
	const { available: _available, ...stored } = project;
	return stored;
}

function sameProjectRecord(value: unknown, project: StoredProject): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return JSON.stringify(value) === JSON.stringify(project);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function validDate(value: unknown): value is string {
	return ProjectSchema.shape.createdAt.safeParse(value).success;
}

function fallbackProjectName(path: string): string {
	return (basename(path) || "Project").slice(0, 200);
}

/**
 * Normalize persisted paths without making a missing project unrecoverable.
 * Existing paths use their realpath; missing paths retain a resolved absolute
 * path so statusList() can continue to show them for explicit recovery.
 */
function normalizeStoredPath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || value.length > 4_096) return undefined;
	let resolved: string;
	try {
		resolved = resolve(value);
	} catch {
		return undefined;
	}
	let canonical = resolved;
	try {
		canonical = realpathSync(resolved);
	} catch {
		// The project may be unavailable; keep the resolved path for recovery.
	}
	if (canonical === parse(canonical).root) return undefined;
	try {
		if (canonical === realpathSync(homedir())) return undefined;
	} catch {
		// homedir() should be available, but a failure must not discard a project.
	}
	return canonical;
}

export class WorkspaceGrantStore {
	constructor(
		private readonly filename: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async configuredPaths(): Promise<string[]> {
		return (await this.projects()).map((project) => project.path);
	}

	/** List currently available project folders without status decorations. */
	async list(): Promise<Project[]> {
		const configured = await this.projects();
		const grants: Project[] = [];
		for (const project of configured) {
			try {
				const canonical = this.validateRoot(project.path);
				if ((await stat(canonical)).isDirectory())
					grants.push({ ...project, path: canonical });
			} catch {
				// Missing, moved, or newly unsafe roots remain configured but are not active.
			}
		}
		return [...new Map(grants.map((project) => [project.id, project])).values()];
	}

	/** List every project, retaining unavailable folders for explicit recovery. */
	async statusList(): Promise<Project[]> {
		const configured = await this.projects();
		const projects: Project[] = [];
		for (const project of configured) {
			let available = false;
			try {
				const canonical = this.validateRoot(project.path);
				available = (await stat(canonical)).isDirectory();
			} catch {
				// Keep unavailable grants visible so the user can explicitly revoke them.
			}
			projects.push({ ...project, available });
		}
		return projects;
	}

	/** The project-aware name makes the single source of truth explicit. */
	async projects(): Promise<Project[]> {
		return this.mutate(async () => {
			const { projects, needsMigration } = await this.readProjects();
			if (needsMigration) await this.save(projects);
			return projects;
		});
	}

	async add(path: string): Promise<Project[]> {
		const canonical = this.validateRoot(path);
		await this.mutate(async () => {
			if (!(await stat(canonical)).isDirectory())
				throw new Error("Workspace grants require a directory.");
			const { projects } = await this.readProjects();
			if (!projects.some((project) => project.path === canonical)) {
				const timestamp = this.now();
				projects.push(
					ProjectSchema.parse({
						id: projectIdForPath(canonical),
						path: canonical,
						name: basename(canonical),
						createdAt: timestamp,
						updatedAt: timestamp,
						order: projects.length,
					}),
				);
			}
			await this.save(projects);
		});
		return this.list();
	}

	async update(
		projectId: string,
		update: { name?: string; instructions?: string },
	): Promise<Project[]> {
		await this.mutate(async () => {
			const { projects } = await this.readProjects();
			const index = projects.findIndex((project) => project.id === projectId);
			if (index < 0) throw new Error("Project was not found.");
			const current = projects[index]!;
			const name = update.name === undefined ? current.name : update.name.trim();
			if (!name) throw new Error("Project name cannot be empty.");
			if (name.length > 200) throw new Error("Project name is too long.");
			const instructions =
				update.instructions === undefined
					? current.instructions
					: update.instructions.trim();
			if (instructions && instructions.length > 20_000)
				throw new Error("Project instructions are too long.");
			const timestamp = this.now();
			const next = {
				...current,
				name,
				updatedAt: timestamp,
			};
			if (instructions) next.instructions = instructions;
			else delete next.instructions;
			projects[index] = ProjectSchema.parse(next);
			await this.save(projects);
		});
		return this.statusList();
	}

	async remove(projectIdOrPath: string): Promise<Project[]> {
		let normalizedPath: string | undefined;
		if (!projectIdOrPath.startsWith("project-"))
			normalizedPath = normalizeStoredPath(projectIdOrPath);
		await this.mutate(async () => {
			const { projects } = await this.readProjects();
			const remaining = projects.filter(
				(project) =>
					project.id !== projectIdOrPath &&
					project.path !== projectIdOrPath &&
					project.path !== normalizedPath,
			);
			if (remaining.length === projects.length) return;
			await this.save(
				remaining.map((project, index) => ({ ...project, order: index })),
			);
		});
		return this.statusList();
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		const previous = mutationQueues.get(this.filename) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.catch(() => undefined).then(() => current);
		mutationQueues.set(this.filename, queued);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (mutationQueues.get(this.filename) === queued)
				mutationQueues.delete(this.filename);
		}
	}

	private async readProjects(): Promise<{
		projects: Project[];
		needsMigration: boolean;
	}> {
		let values: unknown;
		try {
			values = JSON.parse(await readFile(this.filename, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { projects: [], needsMigration: false };
			throw error;
		}
		if (!Array.isArray(values))
			throw new Error("Workspace project store must contain an array.");
		const projects: Project[] = [];
		const ids = new Set<string>();
		const paths = new Set<string>();
		let needsMigration = false;
		for (const [index, value] of values.entries()) {
			const record = recordFromUnknown(value);
			const path = normalizeStoredPath(record?.path);
			if (!record || !path) {
				needsMigration = true;
				continue;
			}
			if (paths.has(path)) {
				needsMigration = true;
				continue;
			}
			paths.add(path);
			const candidateId =
				typeof record.id === "string" && record.id.trim().length > 0 &&
					record.id.length <= 200
					? record.id.trim()
					: projectIdForPath(path);
			const uniqueId = ids.has(candidateId)
				? projectIdForPath(path)
				: candidateId;
			if (ids.has(uniqueId)) {
				// A duplicate path or a pathological ID/hash collision must never
				// produce two rows that cannot be addressed independently.
				needsMigration = true;
				continue;
			}
			ids.add(uniqueId);
			const createdAt = validDate(record.createdAt)
				? record.createdAt
				: LEGACY_PROJECT_TIMESTAMP;
			const updatedAt = validDate(record.updatedAt) ? record.updatedAt : createdAt;
			const name =
				typeof record.name === "string" &&
				record.name.trim().length > 0 &&
				record.name.trim().length <= 200
					? record.name.trim()
					: fallbackProjectName(path);
			const instructions =
				typeof record.instructions === "string" &&
				record.instructions.trim().length > 0 &&
				record.instructions.length <= 20_000
					? record.instructions.trim()
					: undefined;
			const order =
				typeof record.order === "number" &&
				Number.isInteger(record.order) &&
				record.order >= 0
					? record.order
					: index;
			const project = ProjectSchema.parse({
				id: uniqueId,
				path,
				name,
				...(instructions ? { instructions } : {}),
				createdAt,
				updatedAt,
				order,
			});
			const stored = projectWithoutAvailability(project);
			if (!sameProjectRecord(value, stored)) needsMigration = true;
			projects.push(project);
		}
		projects.sort(
			(left, right) =>
				left.order - right.order ||
				left.createdAt.localeCompare(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
		const normalizedProjects = projects.map((project, index) => {
			if (project.order === index) return project;
			needsMigration = true;
			return { ...project, order: index };
		});
		return { projects: normalizedProjects, needsMigration };
	}

	private validateRoot(path: string): string {
		const canonical = realpathSync(resolve(path));
		const volumeRoot = parse(canonical).root;
		if (canonical === volumeRoot)
			throw new Error(
				"A whole filesystem volume cannot be granted as a workspace.",
			);
		if (canonical === realpathSync(homedir()))
			throw new Error(
				"Grant a project folder instead of the entire home directory.",
			);
		return canonical;
	}

	private async save(projects: Project[]): Promise<void> {
		await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
		const temporary = `${this.filename}.tmp`;
		try {
			const stored = projects.map(projectWithoutAvailability);
			await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "w",
			});
			await rename(temporary, this.filename);
			await chmod(this.filename, 0o600);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}
