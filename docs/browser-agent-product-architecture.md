# Kestrel: browser-native execution architecture

## Product contract

Kestrel should let a person give an outcome, expose the context and authority being used, carry out the work across their browser and files, and return a result they can inspect. Switching tabs must not lose the task; restarting a window must not invent completion; delegating must produce useful evidence for the parent, not merely more chat windows.

The product's distinguishing bet is the browser workspace: the person and the agent can work with the same visible material, understand which agent owns which task, intervene at the right point, and keep useful results. Success is the completed task and its repeatability. A large feature catalog, animated agent map, or passing mocked provider test does not establish that success.

The first workflow to make excellent is: open relevant pages, ask a question spanning them, inspect the evidence, then authorize a bounded action when needed. Research and action must use the same task state and tool authority. A separate toy chat window beside unrelated tabs does not satisfy this contract.

## Competitive bar

OpenClaw documents an integrated gateway with channel routing, isolated sessions, agent tools, scheduling and plugins. Its session tools include session discovery/history, spawning, messaging, yielding and cancellation. Those are user-level loops to test, not names to match in a catalog.

Sources checked 2026-09-10: [features](https://docs.openclaw.ai/concepts/features), [session tools](https://docs.openclaw.ai/concepts/session-tool), [browser](https://docs.openclaw.ai/tools/browser). This is a documentation comparison, not a measured head-to-head benchmark.

Kestrel's existing parity matrix classifies broad capability families and extension contracts. It must not be interpreted as evidence that every user workflow is integrated or competitive. The initial 72/82 readiness grades are withdrawn because they evaluated infrastructure rather than this product contract.

## Runtime design

| Responsibility | Owner and existing seam | Required behavior |
| --- | --- | --- |
| Task identity and execution | `packages/agent-core` sessions, AgentLoop, TaskOrchestrator | Durable parent/child ownership, selected route, stop/steer, pending approval and final outcome. Hosts render this state rather than owning another task lifecycle. |
| Model and tools | AgentLoop + AgentRuntime | Discover a bounded effective tool catalog, execute through policy, feed observed results back into the model. A provider's success response alone cannot mark an external action verified. |
| Approvals and receipts | Existing policy engine and action receipts | Exact proposed action, user decision, execution, observed result and uncertainty. Host migration must reuse these records. |
| Browser capabilities | Typed browser backend wire + host adapter | Stable tab identities, bounded observations and explicit action operations. Browser content is untrusted. No remote page receives a generic core bridge. |
| Context and memory | Existing provenance-backed context/memory | Distinguish current page evidence, conversation history and durable approved memory. Corrections remain possible; page instructions never become authority. |
| Process supervision | `apps/core-service` | Own bootstrap, IPC, failure containment and recovery independently of Electron. Never replay uncertain mutations automatically. |
| Presentation | Electron today; Chromium host incrementally | Tabs, task view, composer, context controls, approvals and artifacts project core state. They must not duplicate scheduling, policy, tools or persistence. |

The migration runs vertically: move a complete user capability through the same core interfaces into Chromium, verify its result and authority, then reduce the corresponding Electron dependency. Extracting files alone earns no product-completion credit.

## Current evidence and missing joins

- Packaged desktop already uses a real Node sidecar. This is runtime separation, not a non-Electron desktop.
- The original Chromium preview could open tabs but explicitly disabled all tools and page context. Its model could not inspect those tabs. This change connects `browser.tabs` and `browser.visible-snapshot` through the ordinary core tool loop.
- A new immutable host-owned tool ceiling is enforced in AgentRuntime discovery and execution. This is necessary because personality filtering can include protected configuration tools; a persona is not a host capability boundary. The ceiling is copied at bootstrap and preserved across core recovery.
- Browser reading is off by default and selected per message. A browser-enabled run receives only those two tools. Host dispatch also rejects every mutation and denies reads outside that run; restrictions are enforced beyond prompt wording.
- The reader uses native Chromium accessibility observations, returns bounded names/roles, omits input values and strips URL query/fragment metadata. The shell is excluded from tab ownership. Reading changes neither navigation nor page state.
- The Chromium profile is still temporary. There is no durable-profile migration, protected-account setup, approved write flow, or full task workspace in this host. Those remain explicit missing capabilities.

## Acceptance sequence

1. **Read and explain:** a model requests tab discovery and page evidence, then returns a source-backed answer. Test absent/closed/navigated tabs, private input values, no opt-in, cancellation and hostile pages. A scripted provider proves wiring only; a real-provider outcome evaluation is separately required.
2. **Act with control:** one concrete action such as filling a draft reaches the existing durable approval, executes exactly once, and verifies the resulting page state. Rejection, browser failure and cancellation must remain visible in the same task.
3. **Continue reliably:** task state and pending approvals survive host restart without replaying uncertain work. Introduce a separate encrypted Chromium profile and explicit user setup; do not import the desktop's profile or credentials silently.
4. **Coordinate:** one parent delegates disjoint research, receives both evidence packets, reconciles conflicts, and produces one useful answer. Cancelling the parent reaches its children. Existing orchestration APIs are reused and evaluated end to end.
5. **Keep working:** schedule a proven workflow and show the resulting review item or verified outcome. OS wake and delivery are separate release requirements.

## How to grade it

Use a fixed set of ordinary tasks chosen before running, including research across tabs, an approved form action, a workspace artifact, interrupted work, delegated research and a scheduled follow-up. Run each repeatedly against the installed candidate using a real configured model. Record verified completion, incorrect completion claims, interventions, time, token/cost data when available, and recovery. Include failures in the result.

Report the measured task-completion rate and the untested areas. Do not convert unit-test totals or a deterministic browser harness into a 0–100 competitive score. Public release additionally requires clean installation/update proof and supported signing; none of these substitute for actual task usefulness.
