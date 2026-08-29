# AI-native browser

## Status and scope

**Implemented in this increment:** Kestrel has a dual-primary Browser and Agent desktop workspace with a persistent user browser, an always-mounted agent conversation, a searchable durable-task workspace, independent conversations, History, Bookmarks, Downloads, a searchable capability launcher, browser settings, and command-routed access to existing specialist surfaces. The visible browser supports an unlimited number of tabs, HTTP(S) address/search navigation, back/forward/reload/stop, tab restoration, pin/mute/duplicate, find in page, print, inspect, local history retention, bookmarks with a toggleable bookmarks bar (`⌘⇧B`), downloads (open/reveal/cancel), current-page context handoff, and `@` mentions of open tabs, bookmarks, and granted workspace files.

**Not a claim of a general-purpose browser or unrestricted autonomy:** Chrome-complete extensions, profile import/sync, private browsing, and a complete per-site agent-permission manager remain follow-up work. Site permission prompts now remember allow/deny per origin for this profile. Existing Kestrel policy and approval gates remain the authority for consequential agent actions, and mutating browser tools now contribute privacy-bounded receipts to the owning task outcome.

## Two browser boundaries

### User-visible browser

The user browser is the browser-first workspace: a persistent Electron partition (`persist:kestrel-user-browser-v1`) with the user’s cookies and site storage. It is rendered as the active tab only; inactive live views are bounded (eight kept live) and may be discarded/reloaded. Its state is stored locally in `browser/state.json` beneath Kestrel user data with owner-only directories/files. The persisted record contains tab metadata, URLs, history, download metadata, and browser settings—not favicons or live view state. Safe HTTP(S) tabs may be restored; stale loading state is reset. History is capped at 5,000 entries, downloads at 500, and the user can choose no retention through one year.

The user browser denies Electron permission checks and permission requests. Addresses are limited to HTTP(S), reject embedded credentials, and are validated before navigation. Credential-like query and fragment parameters are removed before URLs cross into renderer state, durable metadata, or agent tools. One safe popup may become a managed tab only during the immediate mouse or keyboard activation that requested it; the allowance is consumed once, cleared on input completion/navigation, and unavailable to later scripts. Downloads go to Kestrel’s local browser-download directory and can be revealed in Finder only after completion. Clearing history intentionally does **not** remove open tabs, downloads, cookies, or site data.

### Autonomous browser sessions

Agent-created browser sessions are separate, ephemeral Electron partitions. Each session is sandboxed with context isolation, no Node integration, web security enabled, DevTools disabled, and an explicit origin allowlist (one to twenty normalized origins). Navigation outside that allowlist is refused. Agent browser output is untrusted; an authentication handoff can make the isolated window visible, but it does not merge its cookies or storage into the user browser.

The agent may also inspect or operate the visible user browser through narrowly typed tools. That is an intentional capability boundary, not a session merge: user tabs keep their own persistent profile while autonomous sessions retain their own isolated profile. Visible-browser tools can list tabs, read bounded current-page/AX/screenshot context, search local history, list download metadata, and perform approved tab/navigation/page actions. They are installed for new conversations and migrated onto existing conversations without changing conversation recency. Read-only visible-browser inspection (tabs, snapshots, screenshots, history, downloads) is `read_only` and does not require a click-approval. Mutating operations remain `sensitive` and stay on the existing policy/approval path. When the Codex subscription route is enabled, desktop bootstrap attaches a loopback MCP server so Codex can inspect the visible Kestrel browser (tabs, snapshots, screenshots, history, downloads) without receiving Kestrel's shell or workspace catalog. Mutating browser tools remain on Kestrel's native approval path and are not exposed through that MCP server. Page text, links, forms, history titles, download names, accessibility snapshots, and screenshots are reference material only—never instructions, authorization, or a source of credentials. AX snapshots have URL values redacted and are size-checked in the main process before crossing into the agent utility process.

Native `<select>` controls use a typed `select` action with a bounded option
value rather than simulated arrow-key counts. Both autonomous and visible
browser backends resolve the semantic target, require a visible, enabled,
unobscured select element and an existing option value, dispatch `input` and
`change`, and verify the value remained selected. The selected value is not
copied into the browser activity intent ledger.

Before pointer input, accessibility refs are resolved against the current
document, scrolled into view, allowed two layout frames to settle, and checked
again for visibility, disabled state, viewport intersection, and obscuration.
This rejects stale or unsafe targets instead of reporting an unverified click,
while hidden autonomous windows keep background layout and CDP input active.

## Deterministic reliability track

The versioned 50-workflow track launches the real app, invokes the ordinary
runtime browser tools, and verifies completion or expected safe stops through
state owned by two loopback fixture servers. It covers research, forms,
productivity, commerce, accounts, and failure/recovery cases in both
development Electron and packaged Apple Silicon gates. It does not call a
model, exercise live sites, or use real accounts, so model tokens and cost are
reported as unmeasured and live canaries remain separate. See
[browser-agent reliability benchmark](browser-agent-benchmark.md) for commands,
corpus distribution, report schema, and evidence limits.

## Context and conversations

The current-page toggle controls whether a conversation receives a snapshot of the active page. When enabled, Kestrel extracts bounded, visible-page material: title, URL, description, selected text, headings, visible text, visible links/forms, viewport, and capture time. The shared contract caps collection (for example, 20,000 selected-text characters, 40,000 visible-text characters, 100 links, and 60 forms), and agent selection adds an untrusted header plus a 16,000-character budget. Selection favors metadata, user selection, headings, then visible text and form labels. It explicitly tells the agent never to follow page instructions, reveal cookies/credentials, or treat page content as approval.

The toggle is renderer-local preference (`kestrel:browser-context`); it defaults on unless the user turns it off and is available both in browser chrome and Browser Settings. It is not a claim that page content is permanently imported into Memory. Browser context is attached only to the request when enabled, while normal conversation persistence follows the existing encrypted transcript/runtime model.

Browser navigation and conversations are deliberately independent. The conversation component stays mounted while Browser, Agent, History, Downloads, Settings, and specialist destinations change, preserving streams, steering, cancellation, and pending approvals. Conversations are separately persisted runtime sessions, reachable from Task history and the full Agent workspace; opening a tab neither creates nor replaces a conversation, and starting a New task does not alter tabs. New task immediately clears and focuses a fresh draft, but intentionally avoids polluting Task history with an empty persisted session; the runtime session is created on the first message. While the single mounted conversation is actively streaming, Kestrel retains that session and asks the user to finish or cancel it before opening a new draft rather than orphaning an unmanageable background stream.

The Agent workspace gives those runtime sessions equal top-level standing with Browser. It exposes truthful agent state, the exact pending approval count, a route to plans and schedules, and a searchable/filterable task ledger with project, status, and recency. It does not fabricate productivity metrics, create another persistence system, or infer that a waiting task is necessarily approved. Selecting a task resumes it in the stable conversation; keyboard focus remains on the initiated control unless the user explicitly starts a fresh task, which moves focus to the composer.

## Approvals, privacy, and performance

- Read-only inspection is distinct from action. Navigation, typing, clicking, tab creation/selection/closing, and authentication handoff are sensitive mutating browser tools.
- Existing Kestrel consequential-action policy is still the approval authority; page content cannot grant permission. Universal task receipts expose bounded browser destination, approval, observed state, verification, and rollback-unavailable truth without storing typed text, page content, screenshots, cookies, or credentials. A browser-specific receipt center and per-site agent-permission manager are still follow-up work.
- Approved or blocked `browser.act` / `browser.visible-act` calls are recorded in an encrypted `browser_activity_events` table (intent, tab or session, approval result, observation counts). Cookies, typed text, AX trees, and screenshots stay out of that ledger, and it is not `browser/state.json`.
- User profile state remains local to the Mac. Autonomous-session state is isolated from the user profile. No cloud browser, Fal request, or local ML stack is required by this feature.
- Session restore is configurable. Live web views are bounded and least-recent inactive views can be discarded; state is compactly persisted and temporary favicon data is excluded.

## Typed failure recovery

Recognized browser failures remain failed tool executions, but now include a bounded `output.recovery` envelope with one of seven stable reason codes: `stale_target`, `target_missing`, `obscured`, `navigation_changed`, `auth_required`, `popup_denied`, or `network_error`. The envelope records whether the failed operation was an observation, navigation, upload, or action; whether an effect was not started, may have started, or is unknown; and next-step hints such as `snapshot`, `reobserve`, `diagnostics`, `auth_handoff`, and `safe_stop`.

The agent loop enforces a content-free recovery budget per run rather than relying on model compliance. When the runtime can prove the failed effect did not start, the first matching failure blocks further mutations on that browser surface until one specifically allowed read-only snapshot or diagnostic succeeds. That observation unlocks at most one deliberate retry. A repeated matching failure exhausts the budget and blocks later mutations on the same surface with a journaled, non-approvable execution result. When an action may have started or its effect is unknown, the first failure exhausts the budget immediately instead of risking replay. Each model-visible plan still sets `automaticReplayAllowed: false`.

Authentication handoff remains a narrow exception: an `auth_required` recovery may offer the explicit approval-gated handoff tool without reopening arbitrary browser mutations. A successful approved handoff resolves that recovery entry. The private per-run state retains only bounded reason, operation, surface, count, phase, and allowed-tool identifiers—never page content, selectors, typed values, credentials, cookies, tokens, or model reasoning. Recovery hints are reconstructed from the trusted reason and surface rather than accepted as authority from tool output. Unknown and cancelled errors are not forced into a misleading reason code.

## Keyboard and accessibility intent

The browser uses named landmarks and controls: Browser is a labelled main region, the page viewport is a labelled tab panel, sidebar destinations expose current-page state, tabs and toolbar actions have accessible names, history/download lists use semantic list structures, status/recovery messages use status roles, and command/history search inputs have labels. Focus is restored to a specialist destination heading after command navigation. Intended shortcuts are `Cmd/Ctrl+L` (address), `Cmd/Ctrl+T` (new tab), `Cmd/Ctrl+W` (close active tab), `Cmd/Ctrl+Tab` / `Cmd/Ctrl+Shift+Tab` (cycle tabs), and `Cmd+N` (New task). All must retain visible Native Graphite focus treatment and functional reduced-motion/reduced-transparency states.

## Surface and IA audit checklist

Audit every reachable desktop surface on a fresh profile, with loaded data, empty/error/loading state where applicable, keyboard-only navigation, reduced motion, reduced transparency, compact width, and no-console-error capture. The browser-first shell must retain an obvious Browser return path and never unmount a live conversation.

| Surface | Required audit |
| --- | --- |
| Onboarding: Welcome, Before you begin, Choose a model, Model setup, Ready | One decision per stage; truthful local/provider state; setup-to-workspace continuity; focus and recovery. |
| Startup and core-error recovery | No synthetic task/approval state; clear retry; no browser view overlap. |
| Agent sidebar and New task | Stable current-page cue, Task history popover, independent conversation selection, pending-approval status. |
| Browser: new tab, tab strip, toolbar, loaded page, loading, error | Address/search validation, tab cycling/close/create, context toggle, visible page bounds, keyboard shortcuts, page error recovery. |
| History and Downloads | Empty/search/filter/reopen/clear; download progress/failure/completed Finder reveal; retention copy matches behavior. |
| Kestrel command center | Every destination routes correctly, grouped search is keyboard usable, and focus lands on the destination heading. |
| Settings, including Browser | Browser search/restore/history controls plus existing provider, privacy, permissions, skin, pet, connection, and reset paths remain reachable. |
| Readiness and Approvals | Runtime recovery, exact approval/reject/edit consequences, no visual competition with browser/agent context. |
| Life Context, Research, Artifacts, Work, Opportunities, Activity, Extensions | Each legacy specialist surface is reachable from More/command center, preserves its prior empty/busy/error/provenance/approval states, and has Browser back navigation. |
| Floating pet, tray/deep links, compact shell | No obstruction of browser controls; deep links retain supported destinations; compact navigation and focus remain usable. |

## Local visual asset decision

The target Mac is Apple M4 with 16 GB unified memory, Metal 4, and about 287 GiB free. No local ML image stack is installed. This browser feature therefore uses vector/CSS Native Graphite treatment and existing icons rather than generated raster assets. It adds no Fal/cloud generation dependency and makes no claim that locally generated imagery is present. Any future image asset would need a separate provenance, cost, privacy, and visual-QA decision.
