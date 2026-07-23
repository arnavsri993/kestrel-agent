import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputPath = resolve(root, "docs/reference-page-audit.json");
const catalogPath = resolve(
  root,
  "packages/agent-core/src/capability-catalog.ts",
);
const parityPath = resolve(root, "docs/parity-matrix.md");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(argument, next);
    index += 1;
  } else {
    args.set(argument, true);
  }
}

const sourceDefinitions = {
  openclaw: {
    repository: "openclaw/openclaw",
    prefix: "docs/",
    treeArgument: "--openclaw-tree",
  },
  hermes: {
    repository: "NousResearch/hermes-agent",
    prefix: "website/docs/",
    treeArgument: "--hermes-tree",
  },
};

const capabilityRules = [
  [
    /onboard|wizard|quickstart|getting-started|setup|configure/,
    ["surface.guided-onboarding"],
  ],
  [/desktop|macos|mac\/|windows|linux|platform/, ["surface.desktop"]],
  [/cli|terminal|tui|shell/, ["surface.terminal"]],
  [
    /ide|acp|editor|vscode|jetbrains/,
    ["surface.ide", "extension.protocol-server"],
  ],
  [/dashboard|web-ui|webchat|web-dashboard|control-ui/, ["surface.web-cloud"]],
  [/mobile|ios|android|remote-control/, ["surface.mobile-remote"]],
  [
    /channel|messaging|slack|discord|telegram|whatsapp|signal|teams|email|gmail|irc|matrix|imessage|line|feishu|wecom|webhook|bluebubbles|mattermost|dingtalk|sms|ntfy|chat/,
    ["surface.channels"],
  ],
  [/stream|steer|interrupt|live-output/, ["surface.streaming-steering"]],
  [
    /image|audio|video|voice|speech|tts|vision|camera|canvas|document|media|meeting/,
    ["surface.multimodal"],
  ],
  [/session|conversation|transcript|history/, ["session.persistence"]],
  [/fork|checkpoint|resume|cancel/, ["session.fork-checkpoint"]],
  [/undo|retry|rewind|rollback|restore/, ["session.undo-retry"]],
  [/compact|context-window|token/, ["session.compaction"]],
  [
    /instruction|context-file|agents-md|claude-md|hermes-md|system-prompt/,
    ["session.instructions"],
  ],
  [/memory|lancedb|wiki/, ["memory.durable"]],
  [/search-session|session-search|semantic-search/, ["memory.session-search"]],
  [/user-model|preference|relationship|profile/, ["memory.user-model"]],
  [/learning|self-improv|skill-creation|curator/, ["memory.self-learning"]],
  [/file|workspace|directory|path|attachment/, ["tool.workspace-read"]],
  [/write|edit|patch|move|delete|filesystem/, ["tool.workspace-write"]],
  [
    /exec|process|pty|bash|command|code-execution|sandbox/,
    ["tool.shell-process"],
  ],
  [
    /git|worktree|pull-request|github|code-review/,
    ["tool.git-worktree", "engineering.code-review"],
  ],
  [
    /web-search|search-provider|brave|duckduckgo|exa|firecrawl|fetch|x-search/,
    ["tool.web"],
  ],
  [/browser|computer-use|cua/, ["tool.browser-computer"]],
  [/lsp|language-server|code-intelligence/, ["tool.code-intelligence"]],
  [/artifact|image-generation|comfy|fal|deliverable/, ["tool.media-artifacts"]],
  [/tool-search|tool-discovery|catalog|tool-gateway/, ["tool.discovery"]],
  [/mcp/, ["extension.mcp-client", "extension.protocol-server"]],
  [
    /api-server|json-rpc|rpc|sdk|programmatic|protocol|acp/,
    ["extension.protocol-server"],
  ],
  [/skill/, ["extension.skills"]],
  [/plugin|extension|clawhub|bundle|marketplace/, ["extension.plugins"]],
  [/hook/, ["extension.hooks"]],
  [
    /personality|agent-profile|custom-agent|pet|skin/,
    ["extension.personality"],
  ],
  [/subagent|delegat/, ["orchestration.subagents"]],
  [/team|swarm|mixture-of-agents|peer|multi-agent/, ["orchestration.teams"]],
  [/goal|task-list|plan|kanban/, ["orchestration.tasks-goals"]],
  [
    /background|daemon|headless|cloud-task|worker|queue/,
    ["orchestration.background"],
  ],
  [/cron|schedule|automation|heartbeat|trigger/, ["orchestration.schedule"]],
  [/workflow|code-mode|batch-processing|pipeline/, ["orchestration.code-mode"]],
  [
    /provider|model|ollama|llama|anthropic|openai|gemini|bedrock|vertex|litellm|lmstudio|inference|subscription/,
    ["provider.multi-model"],
  ],
  [/routing|router|model-selection/, ["provider.routing"]],
  [/fallback|credential-pool|failover/, ["provider.failover"]],
  [
    /docker|ssh|kubernetes|cluster|serverless|remote-backend/,
    ["provider.remote-backends"],
  ],
  [
    /local-model|local-ai|ollama|llama-cpp|lmstudio/,
    ["provider.local-bootstrap"],
  ],
  [/approval|permission|pairing|allowlist/, ["safety.approvals"]],
  [/sandbox|isolation|scope|network-policy|ssrf/, ["safety.sandbox-scope"]],
  [/injection|untrusted|prompt-safety/, ["safety.injection"]],
  [/idempoten|verification|read-back/, ["safety.idempotency"]],
  [
    /credential|secret|oauth|auth|1password|onepassword|bitwarden|keychain/,
    ["safety.credentials"],
  ],
  [
    /audit|cost|usage|budget|analytics|observability|diagnostic|prometheus|otel|logbook|logging/,
    ["safety.audit-cost"],
  ],
  [/review|ci|pull-request|coding-agent/, ["engineering.code-review"]],
  [/visual|screenshot|diff|responsive/, ["engineering.visual-validation"]],
  [/migration|import|compatib/, ["engineering.migration"]],
  [/enterprise|sso|organization|admin|retention/, ["engineering.enterprise"]],
  [
    /install|uninstall|update|upgrade|release|backup|doctor|health|status|troubleshoot|debug|configuration|reference|architecture|security|deployment|distribution/,
    ["engineering.lifecycle"],
  ],
];

const sectionDefaults = {
  openclaw: {
    ".generated": ["engineering.lifecycle"],
    ".i18n": ["engineering.lifecycle"],
    _root: ["engineering.lifecycle"],
    announcements: ["engineering.lifecycle"],
    automation: ["orchestration.schedule"],
    channels: ["surface.channels"],
    clawhub: ["extension.plugins"],
    cli: ["surface.terminal", "engineering.lifecycle"],
    concepts: ["session.persistence"],
    debug: ["engineering.lifecycle"],
    diagnostics: ["safety.audit-cost"],
    gateway: ["extension.protocol-server"],
    help: ["engineering.lifecycle"],
    install: ["engineering.lifecycle"],
    maturity: ["engineering.lifecycle"],
    nodes: ["surface.mobile-remote"],
    plan: ["orchestration.tasks-goals"],
    platforms: ["surface.desktop"],
    plugins: ["extension.plugins"],
    providers: ["provider.multi-model"],
    refactor: ["engineering.lifecycle"],
    reference: ["engineering.lifecycle"],
    releases: ["engineering.lifecycle"],
    security: ["safety.sandbox-scope"],
    specs: ["engineering.lifecycle"],
    start: ["surface.guided-onboarding"],
    tools: ["tool.discovery"],
    web: ["surface.web-cloud"],
  },
  hermes: {
    _root: ["engineering.lifecycle"],
    "developer-guide": ["extension.protocol-server", "engineering.lifecycle"],
    "getting-started": ["surface.guided-onboarding"],
    guides: ["engineering.lifecycle"],
    integrations: ["extension.plugins"],
    reference: ["engineering.lifecycle"],
    "user-guide": ["session.persistence"],
  },
};

function derivedLabel(path) {
  return basename(path)
    .replace(/\.(md|mdx)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pageSection(relativePath) {
  return relativePath.includes("/") ? relativePath.split("/")[0] : "_root";
}

function integrationContract(product, relativePath) {
  if (product === "openclaw") {
    if (relativePath.startsWith("plugins/reference/")) return true;
    if (
      relativePath.startsWith("channels/") &&
      !/(^|\/)(index|README)\.(md|mdx)$/i.test(relativePath)
    )
      return true;
    if (
      relativePath.startsWith("providers/") &&
      !/(^|\/)(index|models|providers)\.(md|mdx)$/i.test(relativePath)
    )
      return true;
    if (
      /^tools\/(gemini-search|grok-search|kimi-search|minimax-search|ollama-search|parallel-search|pdf|perplexity-search|searxng-search|tavily|video-generation)\.md$/.test(
        relativePath,
      )
    )
      return true;
  }
  if (product === "hermes") {
    if (
      relativePath.startsWith("user-guide/messaging/") &&
      !relativePath.endsWith("/index.md")
    )
      return true;
    if (relativePath.startsWith("user-guide/skills/bundled/")) return true;
    if (relativePath.startsWith("integrations/")) return true;
    if (relativePath === "user-guide/features/spotify.md") return true;
  }
  return false;
}

function operationalReference(relativePath) {
  return (
    /(^|\/)(announcements|maturity|plan|refactor|releases|specs|reference|developer-guide|help|debug|install)(\/|$)/.test(
      relativePath,
    ) ||
    /(^|\/)(changelog|contributing|faq|index|overview|README)\.(md|mdx)$/i.test(
      relativePath,
    )
  );
}

function knownGap(product, relativePath) {
  const gaps = [];
  return gaps.find((gap) => gap.pattern.test(relativePath));
}

function mapPage(product, path) {
  const definition = sourceDefinitions[product];
  const relativePath = path.slice(definition.prefix.length);
  const section = pageSection(relativePath);
  const normalized = relativePath.replace(/\.(md|mdx)$/i, "").toLowerCase();
  const pathWords = normalized.replace(/[^a-z0-9]+/g, " ").trim();
  const capabilityIds = new Set(sectionDefaults[product][section] ?? []);
  for (const [pattern, ids] of capabilityRules) {
    const wordPattern = new RegExp(
      `(?:^|\\s)(?:${pattern.source.replaceAll("-", "\\s+")})`,
    );
    if (wordPattern.test(pathWords)) ids.forEach((id) => capabilityIds.add(id));
  }
  if (capabilityIds.size === 0)
    throw new Error(`No capability mapping for ${product}:${path}`);
  const gap = knownGap(product, relativePath);
  const coverage = gap
    ? "unimplemented-gap"
    : integrationContract(product, relativePath)
      ? "implemented-extension-contract"
      : operationalReference(relativePath)
        ? "operational-reference"
        : "implemented-core-family";
  const note =
    gap?.note ??
    (coverage === "implemented-extension-contract"
      ? "The signed plugin, skill, channel, or provider contract supports this integration class; this audit does not claim the named vendor adapter is bundled."
      : coverage === "operational-reference"
        ? "This page documents operation, architecture, release history, or support material rather than a distinct end-user capability."
        : "The referenced behavior maps to an implemented Kestrel capability family with repository evidence in the parity catalog.");
  return {
    relativePath,
    section,
    coverage,
    capabilityIds: [...capabilityIds].sort(),
    note,
    ...(gap ? { gapId: gap.id } : {}),
  };
}

function loadCatalogIds() {
  const source = readFileSync(catalogPath, "utf8");
  return new Set(
    [...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]),
  );
}

function declaredSnapshot() {
  const catalog = readFileSync(catalogPath, "utf8");
  const commit = (product) => {
    const match = catalog.match(
      new RegExp(`${product}Commit:\\s*"([0-9a-f]{40})"`),
    );
    if (!match) throw new Error(`Missing ${product} commit in parity catalog.`);
    return match[1];
  };
  return {
    openclaw: commit("openclaw"),
    hermes: commit("hermes"),
    parity: readFileSync(parityPath, "utf8"),
  };
}

function validate(audit) {
  if (
    audit.schemaVersion !== 1 ||
    !Array.isArray(audit.pages) ||
    audit.pages.length === 0
  )
    throw new Error("Reference audit schema is invalid.");
  const catalogIds = loadCatalogIds();
  const snapshot = declaredSnapshot();
  const keys = new Set();
  const coverageCounts = {};
  for (const page of audit.pages) {
    const key = `${page.product}:${page.path}`;
    if (keys.has(key)) throw new Error(`Duplicate reference page: ${key}`);
    keys.add(key);
    if (!/^[0-9a-f]{40}$/.test(page.sha))
      throw new Error(`Invalid Git blob SHA: ${key}`);
    if (
      ![
        "implemented-core-family",
        "implemented-extension-contract",
        "operational-reference",
        "unimplemented-gap",
      ].includes(page.coverage)
    )
      throw new Error(`Invalid coverage: ${key}`);
    if (
      page.coverage === "unimplemented-gap" &&
      (typeof page.gapId !== "string" || !page.gapId)
    )
      throw new Error(`Missing gap ID: ${key}`);
    if (!Array.isArray(page.capabilityIds) || page.capabilityIds.length === 0)
      throw new Error(`Unmapped reference page: ${key}`);
    for (const id of page.capabilityIds)
      if (!catalogIds.has(id))
        throw new Error(`Unknown capability ${id} on ${key}`);
    coverageCounts[page.coverage] = (coverageCounts[page.coverage] ?? 0) + 1;
  }
  for (const [product, source] of Object.entries(audit.sources)) {
    const pages = audit.pages.filter((page) => page.product === product);
    if (pages.length !== source.pageCount)
      throw new Error(
        `${product} page count does not match its source declaration.`,
      );
    if (!/^[0-9a-f]{40}$/.test(source.commit))
      throw new Error(`${product} commit is invalid.`);
    if (snapshot[product] !== source.commit)
      throw new Error(
        `${product} catalog commit ${snapshot[product]} does not match audit commit ${source.commit}.`,
      );
    if (!snapshot.parity.includes(`\`${source.commit}\``))
      throw new Error(
        `${product} audit commit is missing from docs/parity-matrix.md.`,
      );
    for (const page of pages)
      if (
        page.url !==
        `https://github.com/${source.repository}/blob/${source.commit}/${page.path}`
      )
        throw new Error(`Reference URL does not match pinned source: ${product}:${page.path}`);
  }
  const expectedTotal = Object.values(audit.sources).reduce(
    (total, source) => total + source.pageCount,
    0,
  );
  if (audit.pages.length !== expectedTotal)
    throw new Error(
      "Reference audit total does not match source declarations.",
    );
  return { totalPages: audit.pages.length, coverageCounts };
}

async function refresh() {
  const generatedAtArgument = args.get("--generated-at");
  const generatedAt =
    typeof generatedAtArgument === "string"
      ? generatedAtArgument
      : new Date().toISOString().slice(0, 10);
  const pages = [];
  const sources = {};
  for (const [product, definition] of Object.entries(sourceDefinitions)) {
    const suppliedTreeArgument = args.get(definition.treeArgument);
    const suppliedTree =
      typeof suppliedTreeArgument === "string"
        ? suppliedTreeArgument
        : undefined;
    const tree = suppliedTree
      ? JSON.parse(readFileSync(resolve(suppliedTree), "utf8"))
      : await fetch(
          `https://api.github.com/repos/${definition.repository}/git/trees/main?recursive=1`,
          {
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "workstrand-reference-audit",
            },
          },
        ).then(async (response) => {
          if (!response.ok)
            throw new Error(
              `GitHub tree request for ${product} failed with ${response.status}.`,
            );
          return response.json();
        });
    if (tree.truncated)
      throw new Error(`${product} GitHub tree response was truncated.`);
    const productPages = tree.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.startsWith(definition.prefix) &&
          /\.(md|mdx)$/i.test(entry.path),
      )
      .map((entry) => {
        const mapping = mapPage(product, entry.path);
        return {
          product,
          path: entry.path,
          label: derivedLabel(entry.path),
          section: mapping.section,
          sha: entry.sha,
          url: `https://github.com/${definition.repository}/blob/${tree.sha}/${entry.path}`,
          coverage: mapping.coverage,
          capabilityIds: mapping.capabilityIds,
          note: mapping.note,
          ...(mapping.gapId ? { gapId: mapping.gapId } : {}),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    sources[product] = {
      repository: definition.repository,
      commit: tree.sha,
      pageCount: productPages.length,
      treeApi: `https://api.github.com/repos/${definition.repository}/git/trees/${tree.sha}?recursive=1`,
    };
    pages.push(...productPages);
  }
  const audit = { schemaVersion: 1, generatedAt, sources, pages };
  const summary = validate(audit);
  writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${summary.totalPages} mapped reference pages to ${outputPath}.\n`,
  );
  process.stdout.write(`${JSON.stringify(summary.coverageCounts)}\n`);
}

if (
  args.has("--refresh") ||
  args.has("--openclaw-tree") ||
  args.has("--hermes-tree")
) {
  await refresh();
} else {
  const audit = JSON.parse(readFileSync(outputPath, "utf8"));
  const summary = validate(audit);
  process.stdout.write(
    `Reference page audit verified: ${summary.totalPages} pages, zero unmapped.\n`,
  );
  process.stdout.write(`${JSON.stringify(summary.coverageCounts)}\n`);
}
