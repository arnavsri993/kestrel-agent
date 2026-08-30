# Kestrel Desktop — Surface Matrix

**Audit date:** 2026-08-30  
**Branch:** `codex/ui-audit-reconnaissance` (based on `main` @ 2a100086 after PR #673 merge)  
**Screenshots:** `artifacts/ui-audit/baseline/{wide,normal,compact}/` (94 captures; manifest at `capture-manifest.json`)

Routing model: **browser-tab URLs** (`kestrel://{id}`) inside `BrowserWorkspace`, with a **persistent agent sidebar** (`AgentSidebar` → `RuntimeConversation`) mounted across all routes. Setup/onboarding is a separate shell state before `kestrel:onboarded=yes`.

---

## Shell states (pre-workspace)

| Surface ID | Route / invocation | Source files | Purpose | Primary actions | Secondary actions | Key states | Compact | Reachable | Screenshot |
|---|---|---|---|---|---|---|---|---|---|
| `shell-loading` | App launch, snapshot pending | `App.tsx` (Loading) | Startup wait | — | — | spinner | n/a | yes | no |
| `shell-error` | Startup failure | `App.tsx` (error-screen) | Recovery | Try again (reload) | — | error message | n/a | yes | no |
| `setup-welcome` | First launch | `App.tsx` Onboarding step 0 | Introduce product | Get started | — | first visit | reflows | yes | yes (`normal/setup-01-welcome`) |
| `setup-boundaries` | Step 1 | `App.tsx` setup-warning | Safety acknowledgment | Continue (checkbox) | Back, expand details | unchecked/checked, detail open | reflows | yes | yes |
| `setup-choose-model` | Step 2 | `App.tsx` model-source-picker | Route selection | Account / Local / Free | Back | three routes | reflows | yes | yes |
| `setup-model-accounts` | Step 3 | `App.tsx` setup-models | Paid provider setup | Continue, Back | Do this later | catalog, OAuth, API keys | reflows | yes | yes |
| `setup-model-local` | Step 3 | `App.tsx` setup-models | Ollama/local bootstrap | Continue, Back | Do this later | detecting/downloading/ready/failed | reflows | yes | yes |
| `setup-model-open` | Step 3 | `App.tsx` setup-models | Free providers | Continue, Back | Do this later | provider list | reflows | yes | yes |
| `setup-ready` | Step 4 | `App.tsx` setup-finish | Completion | Open Kestrel / Try first task | Finish with setup help | verified/unverified/preview | reflows | yes | yes |

---

## Primary navigation & shell chrome

| Surface ID | Route / invocation | Source files | Purpose | Primary actions | Secondary actions | Key states | Compact | Reachable | Screenshot |
|---|---|---|---|---|---|---|---|---|---|
| `kestrel-sidebar` | Always in workspace | `KestrelSidebar.tsx`, `kestrel-sidebar.css` | Primary nav rail | New task, Agent, Writing, Approvals, Capabilities | Projects, Recent tasks, Settings | collapsed/expanded, approval badge | hides labels | yes | partial (in workspace shots) |
| `agent-sidebar` | Always mounted | `AgentSidebar.tsx`, `agent-panel-layout.css`, `App.tsx` RuntimeConversation | Persistent agent chat | Compose, send, model select | New task, expand/collapse, task settings | empty/streaming/approval/waiting | collapses | yes | partial |
| `browser-chrome` | Active web/new-tab tab | `BrowserToolbar.tsx`, `TabStrip.tsx`, `browser.css` | Browser controls | Navigate, tabs, address bar | Bookmarks bar, find, menus | sleeping tab, vertical tabs | reflows | yes | partial |
| `window-controls` | macOS titlebar | `WindowControls.tsx`, `window-controls-motion.ts` | Close/minimize/zoom | Traffic lights | — | hover proximity tilt | same | yes | partial |
| `command-center` | ⌘K, sidebar search, Capabilities | `CommandCenter.tsx` | Launcher / search | Navigate to destination | Pin shortcuts | query filter, grouped list | scroll-bounded | yes | yes (all viewports) |

---

## Browser & new tab

| Surface ID | Route / invocation | Source files | Purpose | Primary actions | Secondary actions | Key states | Compact | Reachable | Screenshot |
|---|---|---|---|---|---|---|---|---|---|
| `new-tab-home` | Brand click / Browser tab | `NewTabPage.tsx`, `NewTabWidgets.tsx`, `new-tab.css` | Start surface | Composer prompt, suggestions | Widget shelf customize | empty history, widgets on/off | stacked layout | yes | yes |
| `new-tab-model-selector` | Click model on home | `ModelSelector.tsx` | Model/route pick | Select model | — | popover open | same | yes | yes (`normal`) |
| `browser-web` | External URL tab | `BrowserWorkspace.tsx`, `useUserBrowser.ts` | Web browsing | Navigate, reload | Find, bookmark | loading/error/ssl | reflows | yes | no (privacy) |
| `browser-file` | `kestrel://file/{tabId}` | `BrowserWorkspace.tsx` | Local file view | Open externally | — | preview types | reflows | yes | no |
| `find-in-page` | ⌘F | `BrowserWorkspace.tsx` | In-page search | Find next/prev | Close | open/empty/results | overlay | yes | no |
| `bookmarks-bar` | New tab only | `BookmarksBar.tsx` | Quick bookmarks | Open bookmark | — | visible/hidden | wraps | yes | no |
| `history-popover` | Toolbar back history | `BrowserHistoryPopover.tsx` | Recent history menu | Pick entry | — | open | compact | yes | no |
| `organize-tabs-dialog` | Capabilities → Organize tabs | `OrganizeTabsDialog.tsx` | Tab folder preview | Apply / Cancel | — | preview folders | modal | yes | no |
| `default-browser-prompt` | First launch | `DefaultBrowserPrompt.tsx` | OS default browser | Set default / Not now | — | suppressed via localStorage | modal | yes | no |

---

## App pages (`kestrel://`)

| Surface ID | URL | Source files | Purpose | Primary actions | Secondary actions | Key states | Compact | Reachable | Screenshot |
|---|---|---|---|---|---|---|---|---|---|
| `page-agent` | `kestrel://agent` | `AgentWorkspace.tsx` | Full-page agent hub | New task, session list | Open work history | empty/populated | reflows | yes | yes (3 vp) |
| `page-projects` | `kestrel://projects` | `ProjectsWorkspace.tsx` | Project-scoped chats | Select project/chat | New chat in project | no projects | reflows | yes | yes |
| `page-writing` | `kestrel://writing` | `WritingStudio.tsx` | Writing drafts | Edit, voice signals | Route to agent | draft modes | reflows | yes | yes |
| `page-history` | `kestrel://history` | `BrowserLibrary.tsx` | Browsing history | Search, open | Clear (if present) | empty/populated | reflows | yes | yes |
| `page-bookmarks` | `kestrel://bookmarks` | `BrowserLibrary.tsx` | Bookmark manager | Open, organize | — | empty/tree | reflows | yes | yes |
| `page-downloads` | `kestrel://downloads` | `BrowserLibrary.tsx` | Download ledger | Open file, reveal | — | empty/list | reflows | yes | yes |
| `page-readiness` | `kestrel://readiness` | `App.tsx` Readiness | System health | Refresh checks | Backup, diagnostics | ready/needs attention/busy | reflows | yes | yes |
| `page-approvals` | `kestrel://approvals` | `RuntimeApprovalQueue.tsx`, `ApprovalCard.tsx` | Approval queue | Approve/reject/edit | — | empty/pending | reflows | yes | yes (empty; pending needs fixture) |
| `page-life` | `kestrel://memory` | `LifeContext.tsx`, `life-context.css` | Unified life context | Calendar/People/Memory switch | Event detail, sync | loading/empty/populated/disconnected | agenda reflow | yes | yes (calendar/people/memory) |
| `page-research` | `kestrel://research` | `App.tsx` Research | Web search workspace | Search, fetch | Save sources | empty/results | reflows | yes | yes |
| `page-artifacts` | `kestrel://artifacts` | `App.tsx` Artifacts | Verified outputs | Preview, open | — | empty/media | reflows | yes | yes |
| `page-work` | `kestrel://work` | `App.tsx` Work, `GoalKanban.tsx` | Goals & kanban | Move cards, create goal | Delegates, schedules | empty/board | reflows | yes | yes |
| `page-opportunities` | `kestrel://events` | `EventApplications.tsx` | Event applications | Review prep | — | empty/list | reflows | yes | yes |
| `page-activity` | `kestrel://activity` | `RuntimeActivityTrail.tsx` | Audit trail | Filter/highlight | — | empty/events | reflows | yes | yes |
| `page-extensions` | `kestrel://extensions` | `DashboardExtensions.tsx` | Plugin dashboard | Install/configure | — | empty/enabled | reflows | yes | yes |
| `page-settings` | `kestrel://settings` | `App.tsx` Settings + section panels | Preferences | Section nav, save | Scope switch Browser/Agent | 8 agent + 1 browser sections | nav scroll | yes | yes (all sections, 3 vp) |

---

## Settings sections (detail)

| Section ID | Nav label | Panel source | Purpose | Screenshot |
|---|---|---|---|---|
| `settings-browser` | Browser Preferences | `BrowserSettings.tsx`, `PasswordSettings.tsx`, `PaymentSettings.tsx` | Browser prefs, passwords, payments, widgets | yes |
| `settings-general` | General & Autonomy | `App.tsx` | Pause, run at login, communication style | yes |
| `settings-connections` | Connections | `App.tsx`, `ExternalSecretSettings.tsx` | Providers, credentials, CLIs, BWS | yes |
| `settings-models` | Models & Routing | `App.tsx`, `UsagePolicySettings.tsx` | Routing policy, verification | yes |
| `settings-intelligence` | Intelligence & Memory | `HonchoMemorySettings.tsx`, `PresenceSettings.tsx`, `MemoryRecallStatus.tsx` | Memory layers, presence | yes |
| `settings-extensions` | Agent Plugins | `App.tsx` | Plugin supply chain | yes |
| `settings-privacy` | Privacy & Safety | `App.tsx` | Approval rules, migration, reset | yes |
| `settings-advanced` | Advanced System | `ObservabilitySettings.tsx`, `App.tsx` | Observability, enterprise, custom agents | yes |

---

## Overlays & auxiliary windows

| Surface ID | Invocation | Source files | Purpose | Screenshot |
|---|---|---|---|---|
| `overlay-calculator` | Toolbar / `?calculatorOverlay=1` | `CalculatorOverlay.tsx` | Basic/scientific/graphing calc | no |
| `overlay-password` | Autofill IPC | `PasswordOverlay.tsx` | Save/fill passwords | no |
| `overlay-payment` | Autofill IPC | `PaymentOverlay.tsx` | Save/fill cards | no |
| `modal-keyboard-shortcuts` | ⌘/ / F1 / Capabilities | `KeyboardShortcutsModal.tsx` | Shortcut reference | yes (`normal`) |
| `inline-approval` | Thread pending tool | `ApprovalCard.tsx` | In-conversation approval | no (needs live run) |
| `composer-mentions` | `@` in composer | `ComposerMentionPicker.tsx` | Context attachment | no |
| `communication-assistant` | Non-app pages in rail | `CommunicationCodeAssistant.tsx` | Comms code helper | no |
| `configuration-message` | Chat config flow | `ConfigurationMessage.tsx` | Agent configuration UI | no |
| `dreaming-panel` | Life memory view | `DreamingPanel.tsx` | Memory dreaming UI | no |

---

## Conversation & runtime states (agent sidebar)

| State | Visible signals | Components | Screenshot |
|---|---|---|---|
| New task empty | Welcome + composer | `AgentSidebar`, `#runtime-prompt` | yes |
| Session empty | Placeholder copy | `RuntimeConversation` | partial |
| Streaming | Loader, partial tokens | `RuntimeConversation` | no |
| Tool progress | Activity trail inline | `RuntimeActivityTrail` | no |
| Approval pending | Inline `ApprovalCard` | `ApprovalCard.tsx` | no (fixture in tests only) |
| Waiting approval gate | Status chip | `MemoryRecallStatus`, receipts | no |
| Error / retry | Error copy | `error-copy.ts` patterns | no |
| Task settings open | Disclosure | `.task-settings` | yes (`normal`) |
| Guided first task | Coach copy | `first-task.ts` | no |

---

## Cross-cutting dependencies

| System | Files | Surfaces affected |
|---|---|---|
| Design tokens | `styles.css` `:root` | All renderer |
| UI primitives | `components/ui/index.tsx`, `ui.css` | Buttons, rows, cards, empty states |
| Motion | `motion.css`, `motion/react` in `App.tsx` | Shell, tabs, setup, dialogs |
| Responsive | `surface-responsive.css` | Settings, Life, compact shell |
| Icons | `Icon.tsx` | Everywhere |
| Brand | `BrandMark.tsx` | Setup, empty states, sidebar |
| Browser IPC | `preload/user-browser.ts`, `useUserBrowser.ts` | Browser, tabs, overlays |

---

## Known capture gaps (deterministic capture not yet produced)

- Loading/error shell states
- Web page content tabs (privacy)
- File preview tabs
- Calculator/password/payment overlay windows (separate Electron windows)
- Organize tabs dialog, history popover, find-in-page
- Default browser prompt (suppressed in capture env)
- Agent sidebar collapsed-only layout
- Kestrel sidebar collapsed-only layout
- Streaming/tool-running conversation states
- Approvals with pending items (test fixture exists; not wired to audit capture)
- Readiness failure/diagnostic/busy variants
- Life disconnected/syncing/error states
- Work kanban with populated goals (see `artifacts/screenshots/desktop/setup-revised/work-kanban.png` from separate test)
- New tab widget customize mode
- Browser toolbar menus (context menus)
- Windows-specific chrome (audit captured on macOS Electron dev build)

---

## Obvious inconsistencies (implementation vs DESIGN.md vs capture script)

1. **DESIGN.md monochrome tokens** (`#0a0a0a` canvas) differ from **live `styles.css`** (`#0d0e11` canvas, vibrancy tokens present) — visual lock is partially historical.
2. **`capture-desktop.ts`** still clicks sidebar button `"Browser"` which no longer exists; brand button opens browser (`aria-label="Open {agent} browser"`).
3. **Life Context** uses class `legacy-product-surface` while DESIGN.md describes current Life system — naming drift.
4. **Settings nav labels** in capture script use shortened names vs full nav labels in UI.
5. **Primary nav**: DESIGN.md lists four destinations (Browser, Agent, Approvals, Settings); live sidebar uses Agent, Writing Studio, Approvals, Capabilities + brand for browser.

---

## Accessibility notes (from implementation review)

- Focus rings defined (`--focus-ring`); keyboard focus verified in `capture-desktop.ts` for New task.
- Reduced motion: CSS animations gated; audit captures `compact-reduced-motion` and `compact-reduced-transparency`.
- Status uses icon + label pairs in `ui/Status` (shape not hue-only in monochrome mode).
- Some disclosures (`task-settings`, setup details) need focus restoration verification after close.
- Compact mode hides `#runtime-prompt` visually while attached — composer accessibility in narrow layout needs review.
- Life calendar compact reflow to agenda — semantic reading order should be verified with screen reader pass.

---

## Cross-platform assumptions

- SF Pro stack in CSS (`-apple-system`, `SF Pro Display/Text`, `SF Mono`) — Windows will fall back to Segoe/Consolas; no platform-specific font tokens yet.
- `WindowControls.tsx` implements custom traffic lights (macOS-style); Windows needs native or alternate chrome strategy.
- Keyboard shortcuts use `Meta` (⌘) in docs and tests — Windows should map to `Ctrl` where appropriate.
- Vibrancy/backdrop-filter on sidebar/chrome — may need opaque fallback on Windows (partially handled via `prefers-reduced-transparency`).
- Electron single codebase; no separate Windows renderer fork detected.
