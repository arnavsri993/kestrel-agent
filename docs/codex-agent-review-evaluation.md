# Codex agent review evaluation

Evaluated on September 30, 2026 using Kestrel's official Codex app-server
route and the exact source of PR #802 at
`424a6b5a98542f5c22e25f9c22621891f8fe79d3`.

## Task and result

The agent reviewed the diff and all four changed files, checking Tab tools
disclosure defaults, search behavior, every close/reopen path, and test coverage.
The finding was not supplied in its prompt. An independent review established
the comparison finding separately.

| Decision | Observed result | Assessment |
| --- | --- | --- |
| Model | Auto selected `gpt-6-astra` from the live Codex catalog. | A capable choice for a review spanning state, event ordering, search, and tests; this single run does not establish the cheapest or fastest adequate model. |
| Reasoning | `high`, advertised by the selected model. | Appropriate for tracing close paths and distinguishing a proven defect from a possible event-ordering concern. |
| Execution | Read-only workspace tools; four model turns; no escalation. | Finished the requested review without edits or memory consultation. |
| Understanding | Traced initialization, dismissal, trigger, outside pointer/focus, menu actions, search, and restore indexes. | Covered the requested behavior and stated callback-boundary limits. The routing trace's `design` label is less precise than the actual code-review task. |
| Quality | Found the independently confirmed P2 at `TabStrip.tsx:995–1000`. | Exact lines, source-derived reproduction, a focused fix, and missing regression coverage. |
| Evidence discipline | Explicitly reported no tests, live UI exercise, CI check, or independently recomputed hashes by the model. | Correctly separated source evidence from runtime proof. The evaluation harness independently verified all four source hashes. |

The review's **FAIL** verdict concerns the reviewed PR's code. The review task
itself completed successfully.

## Confirmed finding

The Tab tools trigger at `TabStrip.tsx:995–1000` toggles the menu and clears the
search but bypasses `dismissTabTools()` at lines 304–309, which also resets the
disclosure states. Outside pointer/focus handlers at lines 327–343 exempt the
trigger.

Open the menu, expand Recently Closed or collapse Open Tabs, close through the
trigger, and reopen. The changed disclosures survive instead of restoring Open
Tabs expanded and Recently Closed collapsed. The new smoke assertions cover
initial defaults and search expansion, but do not assert reset after reopening.

The agent also identified `openMenu()` as a reset bypass, while correctly noting
that outside dismissal can mask it. It did not promote that event-ordering
concern into an independently proven second defect.

## Routing defect found during evaluation

The initial source-review prompt mentioned `manifest.json`. The requirement
analyzer treated any JSON, CSV, or schema mention as a request for structured
model output. Live Codex models advertised tools but not native structured
output, so the task was rejected before execution.

The analyzer now distinguishes input formats from explicit output-format
requests. Regression coverage checks source filenames, JSON/CSV inputs, schema
inspection, explicit structured-output requirements, and actual route selection
for a tool-capable endpoint without structured output.

## Browser-review limit

The installed app's browser-only review at source `e51a7a7f` verified the pinned
revision and read source/diff evidence, but exhausted its evidence coverage and
returned an incomplete-review verdict without establishing the defect. This
path did not meet the task's acceptance criteria. The successful workspace
review above is separate evidence and does not establish browser-review
reliability.

Earlier fixes published with this evaluation address catalog refresh, approved
Codex tool execution, compact browser receipts, viewport text capture, and
durable final outcomes. Passing unit, package, and CI checks does not erase the
browser workflow's remaining coverage limit.

## Reproduction boundaries

The source evaluation used an isolated Kestrel data directory and a bounded
workspace containing the manifest, diff, and exact-head copies. The real desktop
profile, credentials, and unrelated working-tree changes were preserved. No PR
comments were posted and neither the evaluated PR nor the delivery PR was merged.
