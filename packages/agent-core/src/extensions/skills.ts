import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { AgentRuntime } from "../runtime";

export interface SkillDescriptor {
  name: string;
  description: string;
  root: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata: Record<string, string>;
}

export interface ActivatedSkill extends SkillDescriptor {
  instructions: string;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseSkill(path: string): ActivatedSkill {
  if (statSync(path).size > 512_000) throw new Error("SKILL.md exceeds the 512 KB safety limit.");
  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content) > 512_000) throw new Error("SKILL.md exceeds the 512 KB safety limit.");
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) throw new Error("SKILL.md must begin with YAML frontmatter.");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md frontmatter is not terminated.");
  const frontmatter = match[1] ?? "";
  const instructions = match[2] ?? "";
  const values: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let section = "";
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const nested = line.match(/^\s{2,}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (nested && section === "metadata") {
      metadata[nested[1]!] = unquote(nested[2] ?? "");
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!field) throw new Error(`Unsupported SKILL.md frontmatter line: ${line}`);
    section = field[1]!;
    if (section !== "metadata") values[section] = unquote(field[2] ?? "");
  }
  const name = values.name ?? "";
  const description = values.description ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("Skill name does not satisfy the Agent Skills naming rules.");
  const root = realpathSync(resolve(path, ".."));
  if (basename(root) !== name) throw new Error("Skill name must match its parent directory.");
  if (!description || description.length > 1_024) throw new Error("Skill description must be 1-1024 characters.");
  if (values.compatibility && values.compatibility.length > 500) throw new Error("Skill compatibility exceeds 500 characters.");
  return {
    name,
    description,
    root,
    ...(values.license ? { license: values.license } : {}),
    ...(values.compatibility ? { compatibility: values.compatibility } : {}),
    ...(values["allowed-tools"] ? { allowedTools: values["allowed-tools"].split(/\s+/).filter(Boolean) } : {}),
    metadata,
    instructions
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();

  constructor(private roots: string[]) {}

  setRoots(roots: string[]): void {
    this.roots = [...new Set(roots)];
    this.discover();
  }

  discover(): SkillDescriptor[] {
    this.skills.clear();
    for (const configuredRoot of this.roots) {
      if (!existsSync(configuredRoot)) continue;
      const root = realpathSync(configuredRoot);
      const candidates = existsSync(resolve(root, "SKILL.md"))
        ? [root]
        : readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => resolve(root, entry.name));
      for (const candidate of candidates) {
        const skillFile = resolve(candidate, "SKILL.md");
        if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
        const { instructions: _instructions, ...descriptor } = parseSkill(skillFile);
        if (this.skills.has(descriptor.name)) throw new Error(`Duplicate skill ${descriptor.name}.`);
        this.skills.set(descriptor.name, descriptor);
      }
    }
    return this.list();
  }

  list(): SkillDescriptor[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  rank(query: string): Array<SkillDescriptor & { relevance: number }> {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
    return this.list().map((skill) => {
      const name = skill.name.toLowerCase();
      const haystack = `${name} ${skill.description} ${Object.entries(skill.metadata).flat().join(" ")}`.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (name === term ? 5 : name.includes(term) ? 3 : haystack.includes(term) ? 1 : 0), 0);
      return { ...skill, relevance };
    }).filter((skill) => terms.length === 0 || skill.relevance > 0).sort((left, right) => right.relevance - left.relevance || left.name.localeCompare(right.name));
  }

  activate(name: string): ActivatedSkill {
    const descriptor = this.skills.get(name);
    if (!descriptor) throw new Error(`Skill ${name} was not discovered.`);
    return parseSkill(resolve(descriptor.root, "SKILL.md"));
  }

  readResource(name: string, relativePath: string): { path: string; content: string } {
    const descriptor = this.skills.get(name);
    if (!descriptor) throw new Error(`Skill ${name} was not discovered.`);
    const candidate = realpathSync(resolve(descriptor.root, relativePath));
    if (!within(descriptor.root, candidate)) throw new Error("Skill resource escapes its skill root.");
    if (!statSync(candidate).isFile()) throw new Error("Skill resource must be a file.");
    const buffer = readFileSync(candidate);
    if (buffer.byteLength > 1_000_000) throw new Error("Skill resources are limited to 1 MB.");
    if (buffer.includes(0)) throw new Error("Binary skill resources are not exposed as model context.");
    return { path: relativePath, content: buffer.toString("utf8") };
  }
}

export function installSkillTools(runtime: AgentRuntime, registry: SkillRegistry, sessionId: string): void {
  registry.discover();
  runtime.registerExternalTool({
    descriptor: {
      name: "skills.list", title: "List Agent Skills", description: "List installed Agent Skills metadata without loading their full instructions.",
      category: "extension", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "skill", tags: ["skills", "discovery", "progressive-disclosure"]
    },
    inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    execute: (_context, input) => ({ skills: registry.rank(String(input.query ?? "")).map(({ root: _root, ...skill }) => skill) })
  });
  runtime.registerExternalTool({
    descriptor: {
      name: "skills.activate", title: "Activate Agent Skill", description: "Load one discovered SKILL.md fully after its metadata matches the task.",
      category: "extension", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "skill", tags: ["skills", "instructions", "activate"]
    },
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    execute: (_context, input) => {
      const skill = registry.activate(String(input.name ?? ""));
      const { root: _root, ...safe } = skill;
      return safe;
    }
  });
  runtime.registerExternalTool({
    descriptor: {
      name: "skills.read-resource", title: "Read Agent Skill resource", description: "Read a bounded text resource inside an activated skill root.",
      category: "extension", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "skill", tags: ["skills", "references", "assets", "scripts"]
    },
    inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["name", "path"], additionalProperties: false },
    execute: (_context, input) => registry.readResource(String(input.name ?? ""), String(input.path ?? ""))
  });
  for (const name of ["skills.list", "skills.activate", "skills.read-resource"]) runtime.allowTool(sessionId, name);
}
