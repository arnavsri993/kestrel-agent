# AI assistant landscape and Kestrel direction

Research snapshot: 2026-07-25/26. Activity and popularity signals are a point-in-time read of public repositories; they are not a promise that a project will remain active.

## The short version

The assistants attracting sustained attention are outcome-oriented. They help a user finish a task through a familiar surface, keep enough context to repeat useful work, expose progress, and stop for approval before consequential actions. Their strongest features are loops, not feature-count checklists:

`desired outcome → bounded work → visible evidence → approval when needed → reusable context`

Kestrel already has most of the safety and runtime pieces for that loop: local-first setup, provider-neutral routing, per-task workspaces, approvals, encrypted memory, artifacts, orchestration, channels, and review-gated learned skills. The product gap was discoverability: a user could review a learned-skill proposal, but had no direct way to say “keep this successful workflow.”

This pass adds that missing action. After a completed run, the desktop conversation can create a local, credential-scanned skill proposal. It records message provenance, copies only the user request and tool names, excludes tool output, and still requires explicit review before installation.

## What the projects actually offer

| Project | Durable feature pattern | Why it became popular | Current status / caution |
| --- | --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | Always-on Gateway, many messaging channels, multi-agent routing, voice, Canvas, workspace skills, pairing and allowlists | It meets users where they already communicate and makes an assistant feel present across devices | Active, not dead. The same breadth creates a large security, channel-compatibility, and maintenance surface. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Self-improving skills, searchable sessions, user modeling, memory nudges, cron, subagents, multiple terminal backends, Telegram/Discord/Slack/WhatsApp/Signal | It closes the learning loop: the assistant can remember, reuse, and improve work instead of starting from chat every time | Active, not dead. A very broad surface and large public issue volume are maintenance signals, not proof of failure. |
| [OpenWorker](https://github.com/andrewyng/openworker) | Desktop coworker, 25+ connectors, terminal/files, MCP, scheduled automations, BYOM, approval gates, unattended-run inbox | “Delivers finished work” is a clear promise, while local-first and BYOM reduce lock-in | Public beta and too young to call dead. Its durable test is whether connector breadth becomes reliable outcomes rather than setup work. |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Coding agents, automations, Agent Canvas, local/remote/cloud backends, SDK and multi-agent task APIs | Strong developer identity, visible agent work, and a path from local experiments to hosted/enterprise execution | Active, but the repository explicitly points users toward the newer [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) and [Agent Canvas](https://github.com/OpenHands/agent-canvas). This is a replatforming example, not a death. |
| [Aider](https://github.com/Aider-AI/aider) | Terminal pair programming, codebase map, broad model support, automatic Git commits, lint/test loop, images and voice | It is narrow, fast, and useful to developers who already live in a terminal and Git | Active but with a slower recent release/commit rhythm than the faster-moving assistant projects; plateau risk is different from being archived. |
| [Goose](https://github.com/aaif-goose/goose) | Native desktop app, CLI/API, many providers, MCP extensions, existing subscription/ACP paths, custom distributions | Cross-platform access plus standards and provider choice make it easy to adopt without choosing one model vendor | Active and moving quickly under the Linux Foundation/AAIF umbrella. Standards help adoption, but extension quality remains a trust boundary. |
| [gpt-engineer](https://github.com/AntonOsika/gpt-engineer) | Early “describe software, watch it write and run code, then ask for changes” loop | It made code generation legible and demoable before the category was crowded | Archived by its owner in April 2026. The repository describes itself as the precursor to the managed [gptengineer.app](https://gptengineer.app/), so the evidence supports product evolution/absorption rather than a verified single-cause postmortem. |

OpenClaw, Hermes, OpenWorker, OpenHands, Aider, and Goose should not be described as dead based on this snapshot. The useful comparison is between active products, a beta, a replatformed project, and one genuinely archived precursor.

## What made them popular

1. **A concrete promise.** “Finish work,” “pair in the terminal,” “live on your devices,” and “learn from experience” are easier to understand than “general-purpose agent.”
2. **A familiar front door.** Desktop, terminal, and existing chat channels remove the need to learn a new operating model.
3. **Low model lock-in.** BYOM, local models, provider routing, ACP, and MCP let users keep existing subscriptions and credentials.
4. **Continuity.** Skills, memory, searchable history, user models, schedules, and workspaces make the second task better than the first.
5. **Visible agency.** Progress, tool traces, Git commits, artifacts, and approval gates turn autonomy into something users can inspect.
6. **A community wedge.** A crisp developer workflow, a viral channel experience, a benchmark, or an open extension standard gives people a reason to share the product.

## Why assistants decline, disappear, or feel abandoned

There is no reliable public postmortem for every stalled project, so these are evidence-backed failure modes rather than claims about private team decisions:

- **The product moves elsewhere.** gpt-engineer was archived after its README had already positioned the repository as a precursor to a managed product. OpenHands is a live example of a repository home changing as the SDK and Canvas become first-class projects.
- **Surface area outruns reliability.** Every channel, connector, plugin, model adapter, and background daemon adds support, security, migration, and regression obligations. Large issue queues are a warning to preserve a narrow core, not a popularity metric by themselves.
- **The demo does not become a repeatable loop.** Connector catalogs and agent theatrics attract attention, but users stay when a task ends in a verifiable artifact or a repeatable workflow.
- **Trust breaks before capability does.** Unbounded autonomy, secret leakage, prompt-injected tools, unclear provenance, or surprising background activity can erase the value of a feature-rich assistant.
- **The escape hatch is missing.** If users cannot export memories, skills, settings, and work, a product transition becomes a forced migration and community confidence drops.

## Kestrel decisions

### Keep

- local-first routing with explicit opt-in for hosted search/transcription;
- provider-owned sign-in and user-owned credentials;
- per-task workspace boundaries and conservative approvals;
- encrypted local memory, provenance, artifacts, and operational receipts;
- provider-neutral runtime contracts, MCP/Agent Skills compatibility, and bounded extensions;
- a small number of dependable channels and a real desktop/CLI path.

### Add now

The new **Save as skill** action makes the learning loop visible at the moment it has evidence: after a completed run. It creates a proposal, not an auto-installed behavior. The proposal is named from the user’s request, carries source message IDs, includes tool names rather than raw outputs, runs the existing credential and Agent Skills validation, and lands in the existing review screen.

### Do not copy blindly

- dozens of channels before one inbound/outbound channel is excellent;
- a public Gateway or broad remote control plane before its threat model is complete;
- automatic skill installation or “self-improvement” that silently changes behavior;
- claims of always-on automation when the packaged desktop process is not OS-woken;
- feature-count parity as a substitute for verified delivery.

### Next high-leverage backlog

1. Unify artifacts, checks, approvals, and final messages into one verified outcome receipt.
2. Ship an explicit launchd/OS-woken automation path with the same local encryption and approval boundary.
3. Add one carefully tested high-demand channel only after inbound authentication, pairing, replay protection, and migration behavior are covered.
4. Provide export/import for memories, learned skills, schedules, and channel settings so Kestrel remains portable if its architecture changes.

The intended product shape is therefore not “the assistant with every feature.” It is a calm local system that turns successful work into trustworthy, reusable capability.
