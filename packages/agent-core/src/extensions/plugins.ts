import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import {
  DashboardContributionSchema,
  type DashboardContribution,
} from "@kestrel/shared-types";

export interface PluginDescriptor {
  name: string;
  version: string;
  description: string;
  root: string;
  manifestPath: string;
  author?: { name: string; url?: string };
  license?: string;
  homepage?: string;
  repository?: string;
  dependencies?: Record<string, string>;
  skillsRoot?: string;
  mcpServersPath?: string;
  dashboardPath?: string;
  dashboard?: DashboardContribution;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    capabilities: string[];
    defaultPrompt: string[];
  };
  enabled: boolean;
  managed: boolean;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function resolvePluginPath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const candidate = realpathSync(resolve(root, value));
  if (!within(root, candidate)) throw new Error("Plugin manifest path escapes the plugin root.");
  return candidate;
}

function findManifests(root: string, maximumDepth = 5): string[] {
  const manifests: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (!current || current.depth > maximumDepth) continue;
    const manifest = resolve(current.path, ".codex-plugin", "plugin.json");
    if (existsSync(manifest) && statSync(manifest).isFile()) {
      manifests.push(manifest);
      continue;
    }
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      pending.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return manifests;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginDescriptor>();

  constructor(private readonly roots: string[], private readonly database?: KestrelDatabase, managedRoots: string[] = []) {
    this.managedRoots = managedRoots.filter(existsSync).map((root) => realpathSync(root));
  }

  private readonly managedRoots: string[];

  discover(): PluginDescriptor[] {
    this.plugins.clear();
    for (const configuredRoot of this.roots) {
      if (!existsSync(configuredRoot)) continue;
      const root = realpathSync(configuredRoot);
      for (const manifestPath of findManifests(root)) {
        if (statSync(manifestPath).size > 256_000) throw new Error("Plugin manifest exceeds 256 KB.");
        const manifestBytes = readFileSync(manifestPath);
        if (manifestBytes.byteLength > 256_000) throw new Error("Plugin manifest exceeds 256 KB.");
        let parsedManifest: unknown;
        try {
          parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
        } catch {
          throw new Error("Plugin manifest is invalid.");
        }
        if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) {
          throw new Error("Plugin manifest is invalid.");
        }
        const manifest = parsedManifest as Record<string, unknown>;
        const name = String(manifest.name ?? "");
        const version = String(manifest.version ?? "");
        const description = String(manifest.description ?? "");
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Plugin name is invalid.");
        if (!version || version.length > 100) throw new Error("Plugin version is invalid.");
        if (!description || description.length > 2_000) throw new Error("Plugin description is invalid.");
        if (this.plugins.has(name)) throw new Error(`Duplicate plugin ${name}.`);
        const pluginRoot = realpathSync(resolve(manifestPath, "../.."));
        const author = manifest.author && typeof manifest.author === "object" ? manifest.author as Record<string, unknown> : undefined;
        const ui = manifest.interface && typeof manifest.interface === "object" ? manifest.interface as Record<string, unknown> : undefined;
        const rawDependencies = manifest.dependencies && typeof manifest.dependencies === "object" && !Array.isArray(manifest.dependencies) ? manifest.dependencies as Record<string, unknown> : undefined;
        const dependencies = rawDependencies ? Object.fromEntries(Object.entries(rawDependencies).map(([dependency, version]) => {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dependency) || typeof version !== "string" || (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) && version !== "*")) throw new Error("Plugin dependency declaration is invalid.");
          return [dependency, version];
        })) : undefined;
        const skillsRoot = resolvePluginPath(pluginRoot, manifest.skills);
        const mcpServersPath = resolvePluginPath(pluginRoot, manifest.mcpServers);
        const dashboardPath = resolvePluginPath(pluginRoot, manifest.dashboard);
        let dashboard: DashboardContribution | undefined;
        if (dashboardPath) {
          const dashboardMetadata = statSync(dashboardPath);
          if (!dashboardMetadata.isFile() || dashboardMetadata.size > 65_536)
            throw new Error(
              "Plugin dashboard contribution must be a regular JSON file no larger than 64 KB.",
            );
          dashboard = DashboardContributionSchema.parse(
            JSON.parse(readFileSync(dashboardPath, "utf8")),
          );
        }
        const descriptor: PluginDescriptor = {
          name,
          version,
          description,
          root: pluginRoot,
          manifestPath,
          ...(author && typeof author.name === "string" ? { author: { name: author.name, ...(typeof author.url === "string" ? { url: author.url } : {}) } } : {}),
          ...(typeof manifest.license === "string" ? { license: manifest.license } : {}),
          ...(typeof manifest.homepage === "string" ? { homepage: manifest.homepage } : {}),
          ...(typeof manifest.repository === "string" ? { repository: manifest.repository } : {}),
          ...(dependencies && Object.keys(dependencies).length ? { dependencies } : {}),
          ...(skillsRoot ? { skillsRoot } : {}),
          ...(mcpServersPath ? { mcpServersPath } : {}),
          ...(dashboardPath && dashboard
            ? { dashboardPath, dashboard }
            : {}),
          ...(ui ? {
            interface: {
              ...(typeof ui.displayName === "string" ? { displayName: ui.displayName } : {}),
              ...(typeof ui.shortDescription === "string" ? { shortDescription: ui.shortDescription } : {}),
              ...(typeof ui.category === "string" ? { category: ui.category } : {}),
              capabilities: Array.isArray(ui.capabilities) ? ui.capabilities.filter((value): value is string => typeof value === "string") : [],
              defaultPrompt: Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt.filter((value): value is string => typeof value === "string") : []
            }
          } : {}),
          enabled: this.database?.getState<unknown>(`plugin.enabled.${name}`) === true,
          managed: this.managedRoots.some((managedRoot) => within(managedRoot, pluginRoot))
        };
        this.plugins.set(name, descriptor);
      }
    }
    return this.list();
  }

  list(): PluginDescriptor[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): PluginDescriptor {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin ${name} was not discovered.`);
    return plugin;
  }

  setEnabled(name: string, enabled: boolean): PluginDescriptor {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin ${name} was not discovered.`);
    if (enabled) {
      for (const [dependencyName, requiredVersion] of Object.entries(plugin.dependencies ?? {})) {
        const dependency = this.plugins.get(dependencyName);
        if (!dependency) throw new Error(`Plugin ${name} requires missing dependency ${dependencyName}.`);
        if (requiredVersion !== "*" && dependency.version !== requiredVersion) throw new Error(`Plugin ${name} requires ${dependencyName} ${requiredVersion}, but ${dependency.version} is installed.`);
        if (!dependency.enabled) throw new Error(`Enable dependency ${dependencyName} before ${name}.`);
      }
    } else {
      const dependent = [...this.plugins.values()].find((candidate) => candidate.enabled && candidate.name !== name && candidate.dependencies?.[name]);
      if (dependent) throw new Error(`Disable dependent plugin ${dependent.name} before ${name}.`);
    }
    const updated = { ...plugin, enabled };
    this.plugins.set(name, updated);
    this.database?.setState(`plugin.enabled.${name}`, enabled);
    return updated;
  }

  skillRoots(): string[] {
    return this.list().filter((plugin) => plugin.enabled && plugin.skillsRoot).map((plugin) => plugin.skillsRoot!);
  }

  summary(): Array<Omit<PluginDescriptor, "root" | "manifestPath" | "skillsRoot" | "mcpServersPath" | "dashboardPath"> & { hasSkills: boolean; hasMcpServers: boolean; hasDashboard: boolean }> {
    return this.list().map(({ root: _root, manifestPath: _manifest, skillsRoot, mcpServersPath, dashboardPath: _dashboardPath, ...plugin }) => ({
      ...plugin,
      hasSkills: Boolean(skillsRoot),
      hasMcpServers: Boolean(mcpServersPath),
      hasDashboard: Boolean(plugin.dashboard)
    }));
  }
}
