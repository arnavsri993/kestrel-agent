# UI consistency audit — September 16, 2026

## Scope and approach

Existing product audit, preserving the graphite shell, typography, real workflows,
profile and security boundaries. The supplied screenshots are visual evidence,
not instructions embedded in documents. Work is isolated from unrelated edits.

The capture harness visits New Tab and every registered destination: Memory, scoped Memory,
Connections, Agent, Projects, Writing, History, Bookmarks, Downloads, Readiness,
Approvals, Research, Artifacts, Work, Opportunities, Activity, Extensions and
Settings and Command Center. All 22 Browser and Agent Settings sections are also
captured at the narrow width. Captures use an isolated profile at 1440×1000 and 760×760 requested
window sizes. Actual content height depends on macOS window chrome.

## Findings and corrections

| Severity | Finding | Evidence / correction |
| --- | --- | --- |
| High | Find occupies the top-left tab/traffic-control region | Baseline rectangle x=0, y=0, width=216. Absolute placement below browser chrome now aligns with the content plane. Opening Find reserves 40px in the measured native viewport in both tab orientations. |
| High | Initial Find query produces no matches | Reproduced on a native loopback page with three matches. Translate Kestrel advance semantics to Electron search-session semantics; verify initial, next, previous and clear. See [Electron API](https://www.electronjs.org/docs/latest/api/web-contents#contentsfindinpagetext-options). |
| High | Source navigation overlaps its search input | Measured 20px overlap at both widths. Scope the shared negative tab margin to its intended header sibling; give source controls a grid with explicit gaps. |
| Medium | Memory scope says Personal while a conversation scope is displayed | Include the currently viewed conversation in the scope options; preserve agent-only discovery choices. |
| Medium | Empty source picker is a tiny unlabeled-looking arrow | Full-width labeled selector with “No sources assigned”; source search disabled until a source exists. |
| Medium | Connections and memory recovery/review controls use browser-default buttons | Apply existing secondary button styles to WhatsApp, Onshape, resource access, recovery, review, correction and pagination. Preserve handlers and approval gates. |
| Medium | Permission checkboxes stack apart from their prose | Checkbox labels use aligned horizontal layout; text wraps beside its checkbox. |
| Medium | Library title squeezed between search and actions | At narrow content widths, place header actions below the title; retain one graphite page surface. |
| Medium | Compact composer text sits high in its capsule | Equal 8px padding around a 22px line in the 38px editor; preserve expansion. |
| Low | Glass controls have an extra bright top edge | Remove directional inset highlights; use one border plus external shadow. |
| Preference | Sidebar titles should fade, not end in ellipses | Current main already contains trailing masks and clipped titles. Retain them, assert computed styles and verify installed output rather than adding a competing override. |
| Low | Widget rims differ in weight | Current main already replaced widget directional highlights with a single border. Assert equal 1px widths and absence of inset shadow, including wallpaper state. |

## Verification and limits

The source audit passed 40 route/viewport combinations and all 22 Settings sections,
with no renderer exceptions, document overflow or source-navigation overlap.
The compact composer line is centered (0px delta), sidebar labels use gradient
masks with clipping, and all widget rims are 1px without inset shadows.
Initial native Find reports three matches; next and previous advance correctly.
Both tab orientations reserve space above the native content. Expanded composer,
wallpaper, reduced motion and scoped Memory at 200% zoom were exercised.

Focused desktop typecheck and all 118 UserBrowserService tests passed. The earlier
broad verify run passed its typechecks, 2,235 unit tests, 50 browser benchmark
cases, 50 website tests, desktop layout, New Tab, Settings, Writing, browser,
autofill and setup checks before interruption at fresh-profile validation.
The remaining verification tail then passed: fresh profile, restart recovery,
workflow reuse, fresh/returning personas, Kanban, routing, readiness, external
secrets, observability, life context, approvals, chat configuration, managed
policy, packaged CLI, editor integrations and production secret scan.
This is not a claim that one uninterrupted full verify run completed.

The same 40-route/22-section audit passed against the installed binary using
an isolated profile. A subsequent real-profile visual inspection identified a
Find field specificity conflict; the final correction has an explicit 28px
height and single-outline assertion in both tab orientations.

The documented macOS installer initially failed from disk exhaustion. Packaging
and ad-hoc signing subsequently passed; the cleanup stage needed
`KESTREL_MACOS_KEEP_APP` set to this worktree's release bundle to preserve it for
installation. `/Applications/Kestrel.app` was replaced using the normal installer;
its `app.asar` SHA-256 matches the packaged artifact:
`ca5c8d97148735876e90def17dae3ca1a9efc8d0a03be8a4eecbb162de1fecdd`.
Deep strict signature verification passed. Final installed focused checks and
packaged desktop smoke passed, including native Sharp, isolated browser tools
and action receipts. The canonical app was reopened with the existing profile;
New Tab, sidebar fading, Find placement/sizing and the reported Robotics Memory
Sources page were visually verified. No profile reset or migration was performed.

Local
screenshots remain under `.tmp/ui-baseline` and `.tmp/ui-consistency`; they are
not published because automatic greetings may contain local identity. Screenshots
cover representative empty/default states, not every provider, dataset or error.
The audit does not certify all possible product states or live external accounts.
Jules was checked and is unavailable because its API key is not configured.
