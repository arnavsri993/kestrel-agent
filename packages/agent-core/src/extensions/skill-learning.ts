import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import type { SkillLearningFeedback, SkillLearningProposal } from "@kestrel/shared-types";
import type { AgentRuntime } from "../runtime";
import { SkillRegistry } from "./skills";

const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b/i;

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export class SkillLearningManager {
  private readonly proposalKey = "skills.learning.proposals";
  private readonly feedbackKey = "skills.learning.feedback";
  private readonly root: string;

  constructor(
    private readonly database: KestrelDatabase,
    learnedRoot: string,
    private readonly registry: SkillRegistry,
    private readonly now: () => Date = () => new Date()
  ) {
    mkdirSync(learnedRoot, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(learnedRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Learned skill root must be a regular directory.");
    chmodSync(learnedRoot, 0o700);
    this.root = resolve(learnedRoot);
  }

  list(): SkillLearningProposal[] { return this.database.getPrivateState<SkillLearningProposal[]>(this.proposalKey) ?? []; }
  listFeedback(skillName?: string): SkillLearningFeedback[] {
    const records = this.database.getPrivateState<SkillLearningFeedback[]>(this.feedbackKey) ?? [];
    return skillName ? records.filter((record) => record.skillName === skillName) : records;
  }

  propose(input: Pick<SkillLearningProposal, "name" | "description" | "instructions" | "sourceSessionId" | "sourceMessageIds">): SkillLearningProposal {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 64) throw new Error("Learned skill name is invalid.");
    if (!input.description.trim() || input.description.length > 1_024 || /[\r\n]/.test(input.description)) throw new Error("Learned skill description must be a single line of 1-1024 characters.");
    if (!input.instructions.trim() || input.instructions.length > 200_000) throw new Error("Learned skill instructions must be 1-200000 characters.");
    if (input.sourceMessageIds.length === 0) throw new Error("Learned skill proposals require message provenance.");
    if (!this.database.getRuntimeSession(input.sourceSessionId)) throw new Error("Learned skill source session was not found.");
    const sourceMessages = new Set(this.database.listRuntimeMessages(input.sourceSessionId).map((message) => message.id));
    if (input.sourceMessageIds.some((id) => !sourceMessages.has(id))) throw new Error("Learned skill message provenance does not belong to its source session.");
    if (secretPattern.test(`${input.description}\n${input.instructions}`)) throw new Error("Learned skill proposal appears to contain a credential or private key.");
    const checks = this.validatePackage(input.name, input.description.trim(), input.instructions.trim());
    const timestamp = this.now().toISOString();
    const proposal: SkillLearningProposal = {
      ...input,
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      id: `skill-proposal-${randomUUID()}`,
      status: "proposed",
      evaluation: { valid: true, checks: [...checks, `${this.listFeedback(input.name).length} prior feedback records available`] },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.saveProposals([...this.list(), proposal]);
    return proposal;
  }

  review(id: string, decision: "install" | "reject"): SkillLearningProposal {
    const proposals = this.list();
    const index = proposals.findIndex((proposal) => proposal.id === id);
    const current = proposals[index];
    if (!current) throw new Error("Learned skill proposal not found.");
    if (current.status !== "proposed") throw new Error("Only proposed learned skills can be reviewed.");
    if (decision === "reject") {
      const rejected = { ...current, status: "rejected" as const, updatedAt: this.now().toISOString() };
      proposals[index] = rejected;
      this.saveProposals(proposals);
      return rejected;
    }
    try {
      this.install(current);
      const installed = { ...current, status: "installed" as const, updatedAt: this.now().toISOString() };
      proposals[index] = installed;
      this.saveProposals(proposals);
      this.registry.discover();
      return installed;
    } catch (error) {
      const failed = { ...current, status: "failed" as const, evaluation: { ...current.evaluation, valid: false, error: error instanceof Error ? error.message : "Skill installation failed." }, updatedAt: this.now().toISOString() };
      proposals[index] = failed;
      this.saveProposals(proposals);
      throw error;
    }
  }

  feedback(input: Omit<SkillLearningFeedback, "id" | "createdAt">): SkillLearningFeedback {
    if (!input.feedback.trim() || input.sourceIds.length === 0) throw new Error("Skill feedback and provenance are required.");
    const record: SkillLearningFeedback = { ...input, feedback: input.feedback.trim(), id: `skill-feedback-${randomUUID()}`, createdAt: this.now().toISOString() };
    this.database.setPrivateState(this.feedbackKey, [...this.listFeedback(), record]);
    return record;
  }

  private skillDocument(name: string, description: string, instructions: string): string {
    return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  learned-by: kestrel\n---\n\n${instructions}\n`;
  }

  private validatePackage(name: string, description: string, instructions: string): string[] {
    const container = resolve(this.root, `.validate-${randomUUID()}`);
    const skillRoot = resolve(container, name);
    if (!within(this.root, container)) throw new Error("Learned skill validation path escaped its root.");
    mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(resolve(skillRoot, "SKILL.md"), this.skillDocument(name, description, instructions), { mode: 0o600, flag: "wx" });
      new SkillRegistry([container]).discover();
      return ["name and description valid", "credential scan passed", "isolated Agent Skills parse passed"];
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  }

  private install(proposal: SkillLearningProposal): void {
    this.validatePackage(proposal.name, proposal.description, proposal.instructions);
    const container = resolve(this.root, `.install-${randomUUID()}`);
    const staged = resolve(container, proposal.name);
    const target = resolve(this.root, proposal.name);
    const backup = resolve(this.root, `.backup-${proposal.name}-${randomUUID()}`);
    if (!within(this.root, target) || !within(this.root, staged) || !within(this.root, backup)) throw new Error("Learned skill installation path escaped its root.");
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(staged, "SKILL.md"), this.skillDocument(proposal.name, proposal.description, proposal.instructions), { mode: 0o600, flag: "wx" });
    let backedUp = false;
    try {
      if (existsSync(target)) {
        const metadata = lstatSync(target);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Existing learned skill target is unsafe.");
        renameSync(target, backup);
        backedUp = true;
      }
      renameSync(staged, target);
      if (backedUp) rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (backedUp && existsSync(backup)) renameSync(backup, target);
      throw error;
    } finally {
      if (existsSync(container)) rmSync(container, { recursive: true, force: true });
    }
  }

  private saveProposals(proposals: SkillLearningProposal[]): void { this.database.setPrivateState(this.proposalKey, proposals); }
}

export function installSkillLearningTools(runtime: AgentRuntime, manager: SkillLearningManager, sessionId: string): void {
  const register = (name: string, readOnly: boolean, inputSchema: Record<string, unknown>, execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"]) => {
    runtime.registerExternalTool({ descriptor: { name, title: name, description: name, category: "extension", riskLevel: readOnly ? "read_only" : "sensitive", readOnly, requiresWorkspace: false, source: "skill", tags: ["skills", "learning", "review"] }, inputSchema, execute });
    runtime.allowTool(sessionId, name);
  };
  register("skills.learning-list", true, { type: "object", additionalProperties: false }, async () => ({ proposals: manager.list(), feedback: manager.listFeedback() }));
  register("skills.propose", false, { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" }, sourceSessionId: { type: "string" }, sourceMessageIds: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["name", "description", "instructions", "sourceSessionId", "sourceMessageIds"], additionalProperties: false }, async (_context, input) => ({ proposal: manager.propose({ name: String(input.name), description: String(input.description), instructions: String(input.instructions), sourceSessionId: String(input.sourceSessionId), sourceMessageIds: (input.sourceMessageIds as unknown[]).map(String) }) }));
  register("skills.feedback", false, { type: "object", properties: { skillName: { type: "string" }, succeeded: { type: "boolean" }, feedback: { type: "string" }, sourceIds: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["skillName", "succeeded", "feedback", "sourceIds"], additionalProperties: false }, async (_context, input) => ({ feedback: manager.feedback({ skillName: String(input.skillName), succeeded: Boolean(input.succeeded), feedback: String(input.feedback), sourceIds: (input.sourceIds as unknown[]).map(String) }) }));
}
