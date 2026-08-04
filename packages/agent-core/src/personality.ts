export interface AgentPersonality {
  id: string;
  name: string;
  description: string;
  instructions: string;
  preferredModel?: string;
  providerIds?: string[];
  toolNames?: string[];
  memoryScope: "shared" | "isolated";
  builtin: boolean;
}

const builtins: AgentPersonality[] = [
  { id: "pragmatic", name: "Pragmatic", description: "Direct, evidence-led, and implementation focused.", instructions: "Communicate pragmatically. Lead with outcomes, distinguish evidence from inference, and keep implementation details proportional to the task.", memoryScope: "shared", builtin: true },
  { id: "friendly", name: "Friendly", description: "Warm, collaborative, and explanatory.", instructions: "Communicate warmly and collaboratively. Explain unfamiliar steps clearly without being patronizing or verbose.", memoryScope: "shared", builtin: true },
  { id: "concise", name: "Concise", description: "Minimal wording with the same rigor.", instructions: "Be concise. Preserve essential evidence, risks, and next actions while avoiding unnecessary framing.", memoryScope: "shared", builtin: true }
];

const MAX_CUSTOM_PERSONALITIES = 100;

function clonePersonality(personality: AgentPersonality): AgentPersonality {
  return {
    ...personality,
    ...(personality.providerIds ? { providerIds: [...personality.providerIds] } : {}),
    ...(personality.toolNames ? { toolNames: [...personality.toolNames] } : {}),
  };
}

export class PersonalityRegistry {
  private readonly personalities = new Map<string, AgentPersonality>();

  constructor(custom: Array<Omit<AgentPersonality, "builtin">> = []) {
    for (const personality of builtins) this.personalities.set(personality.id, personality);
    for (const personality of custom.slice(0, MAX_CUSTOM_PERSONALITIES)) this.register(personality);
  }

  register(personality: Omit<AgentPersonality, "builtin">): AgentPersonality {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(personality.id)) throw new Error("Personality ID is invalid.");
    if (!personality.name.trim() || personality.name.length > 100) throw new Error("Personality name is invalid.");
    if (!personality.description.trim() || personality.description.length > 500) throw new Error("Personality description is invalid.");
    if (!personality.instructions.trim() || personality.instructions.length > 20_000) throw new Error("Personality instructions are invalid.");
    if (personality.preferredModel && personality.preferredModel.length > 200) throw new Error("Preferred model is invalid.");
    if (personality.providerIds && (personality.providerIds.length > 8 || personality.providerIds.some((id) => !id || id.length > 100))) throw new Error("Personality provider scope is invalid.");
    if (personality.toolNames && (personality.toolNames.length > 200 || personality.toolNames.some((name) => !/^[a-z][a-z0-9_.-]+$/.test(name)))) throw new Error("Personality tool scope is invalid.");
    if (this.personalities.has(personality.id)) throw new Error(`Personality ${personality.id} already exists.`);
    if ([...this.personalities.values()].filter((candidate) => !candidate.builtin).length >= MAX_CUSTOM_PERSONALITIES) throw new Error("At most 100 custom personalities can be registered.");
    const value = clonePersonality({ ...personality, builtin: false });
    this.personalities.set(value.id, value);
    return clonePersonality(value);
  }

  list(): AgentPersonality[] {
    return [...this.personalities.values()].map(clonePersonality);
  }

  get(id: string): AgentPersonality {
    const personality = this.personalities.get(id);
    if (!personality) throw new Error(`Personality ${id} is unavailable.`);
    return clonePersonality(personality);
  }

  remove(id: string): AgentPersonality {
    const personality = this.get(id);
    if (personality.builtin) throw new Error("Built-in personalities cannot be removed.");
    this.personalities.delete(id);
    return personality;
  }
}
