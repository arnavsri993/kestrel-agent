# Kestrel desktop content lock

## Natural desktop language

- Prefer the user's action: “Choose folder,” “Pick a size,” “Use my AI account,” and “Do this later.”
- Replace internal categories such as “model tier,” “provider stack,” “route,” and “local agent” when a plain equivalent is available.
- Use Kestrel consistently in visible copy. Keep legacy compatibility identifiers only where compatibility requires them.
- Supporting text explains the consequence of a choice; it does not repeat the label or market the feature.
- Button hierarchy is one primary next step, a bordered secondary action, and text-like navigation for Back or deferral.

## Kestrel daily-work entry

### Product promise

- Kestrel is the one place to bring a project or question, from first inspection through verified delivery.
- A user should not need to choose a provider or memorize a model ID before starting. Automatic routing is the default; manual routing is an advanced option.
- Project access is explicit and revocable. Kestrel can work only inside folders the user grants.
- Existing Codex, Claude Code, OpenClaw, and Hermes instructions, non-secret setting translations, memory, skills, and agents can be dry-run reviewed and imported without changing the source. Raw settings, credentials, executable plugin configuration, and consequential automation/channel bindings are not copied.
- “Codex replacement” is a workflow objective, not a blanket superiority claim.

### Primary hierarchy

1. Choose or grant the project Kestrel may work in.
2. Describe the outcome in natural language.
3. Follow streamed progress and provide a steering update if needed.
4. Review exact consequential changes before approval.
5. Inspect the result, artifacts, usage, and durable task history.

### Interface copy

- New-task heading: time-aware greeting.
- New-task support: “Bring a project or a question. Kestrel can inspect, build, research, run, and verify the work.”
- Project label: “Project”
- No-project option: “No project — conversation only”
- Project grant action: “Add project”
- Composer label: “Message Kestrel”
- Composer placeholder: “What do you want to get done?”
- Automatic route: “Automatic — Kestrel chooses”
- Advanced disclosure: “Advanced execution”
- Starter prompts: “Build or change a feature”, “Find and fix a bug”, “Research and explain”, “Automate recurring work”.

## Browser-first language

- Co-primary destinations: “Browser” and “Agent”; secondary destinations: “History”, “Downloads”, “Settings”, and “More”. Existing specialist capabilities remain available from More or search, not as competing first-run navigation.
- Browser heading/landmark: “Browser”
- New tab prompt: “Search or enter an address”
- Current-page control: “Use current page” with support “Share visible page context with this conversation when it helps.” It must never imply that a page is trusted or permanently saved to Memory.
- Agent rail context: “Current page”; it identifies the active tab but does not bind it to the conversation.
- Task history: “Task history”; “No tasks yet.”
- New task opens a clean draft without changing tabs. During an active stream, retain the current conversation and say “Finish or cancel the active task before starting a new one.” rather than orphaning background work.
- Browser settings: “Search, session restore, and local history.” Keep the explicit note that clearing history does not clear cookies, site data, tabs, or downloads.
- Security boundary: “User tabs use a persistent browser profile. Autonomous agent browsing remains isolated and does not share these cookies or site storage.”
- Consequential browser actions use the existing plain-language approval treatment. Do not describe page content as approval, authorization, or an instruction source.

## Agent-primary language

- Primary destination: “Agent”. It is equal to Browser and opens the durable task workspace, not another chat-only landing page.
- Kestrel is the agent; persisted runtime sessions are “tasks” in everyday chrome. Use “New task”, “Task history”, and “Find a task or project”.
- Agent heading: “Your agent” with support “Start work, return to it, and see what needs you.”
- Task state: “Open”, “Waiting”, “Completed”, “Cancelled”, or “Needs recovery”. Global agent state remains “Ready”, “Reading”, “Working”, “Needs approval”, “Paused”, “Offline”, “Updating”, or “Needs recovery”.
- Approval summary must be exact: “None waiting” or the current count. It links to the real approval surface and never implies that approval guarantees success.
- First-use task copy: “Start with an outcome. Kestrel will keep the conversation, project, approvals, and result together.”
- Search-empty and filter-empty states explain the cause and offer only the matching recovery action.

## Product facts

- Kestrel is a local-first personal agent.
- The preview uses deterministic Gmail and Calendar adapters; it does not imply connected live accounts.
- External email and calendar changes require approval.
- Memory and activity evidence remain inspectable.
- The DJI preview can use six local memory records to avoid repeating earlier troubleshooting.

## Primary hierarchy

1. Start or continue a conversation.
2. Notice a pending approval without interrupting current input.
3. Review exact changes before an external action.
4. Inspect memory, background activity, connections, or operating policy on demand.

## Interface copy

- New-task heading: “What should we work on?”
- New-task support: “Ask normally. Kestrel will bring in relevant local context when it can help.”
- Composer label: “Message Kestrel”
- Composer placeholder: “Ask Kestrel to help with anything”
- Background pending state: “1 approval waiting” / “Kestrel prepared a plan and paused before acting”
- Background quiet state: “Background work is quiet” / “No action needs you right now”
- Approval heading: “Review the exact changes.”
- Approval support: “Edit the draft, approve the plan, or stop it. Nothing is sent before you decide.”

## State and recovery copy

- Loading: “Starting Kestrel…”
- Core error: “Kestrel could not start.” / “Try again”
- Response loading: “Checking relevant device context…”
- Response error: “Kestrel could not finish that response. Your message is still here—try again when the local core is available.”
- Empty approvals: “No approvals waiting” / “Prepared actions that cross a permission boundary will appear here.”

## Responsive copy rule

Keep task and action nouns intact. At compact widths, hide sidebar labels only when their icons retain accessible names; never truncate approval actions, recovery labels, or destructive consequences.
