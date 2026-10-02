# Release usability integration audit — 2026-10-02

This branch combines the frozen latest open pull-request heads on main `3e93235839b44dcc64643d37f6359a825c25be6e`. It preserves user profiles and the current Keychain/encryption defaults. GitHub pull requests are left unmerged for review.

## Source disposition

| PR | Exact head | Local disposition |
| --- | --- | --- |
| #782 | `7ff953c17385aeaf2bc68afc482568afb0a51201` | Excluded: weakens default credential storage |
| #783 | `4c9fc1b4ae3fdd4d523da2ce92ce4273806ede46` | Integrated locally |
| #785 | `b1a10d9f827392d87345f7716db484fb6785d083` | Integrated locally |
| #786 | `7b6d8a549c8c8bf9721d9a30d3e463fd2eac38bc` | Integrated locally |
| #787 | `ac094a74997c6a5b7845b49fd8d72753de5ab34d` | Integrated locally |
| #789 | `8da28a2a3e5c0e8bd2dac00199c8c841b3806814` | Integrated locally |
| #790 | `2d619d5d7b0e02e501fdcd0068c14b8fe050f916` | Integrated locally |
| #792 | `b8f1013cee68df16bc1d5541929e40e1015837ac` | Integrated locally |
| #793 | `ff6c50573707fae70245cbf3be2e3af726619383` | Integrated locally |
| #795 | `5bd91d31e192e33a286dcce2365d986782810bf3` | Integrated locally |
| #796 | `a11ff7f7b71c1d21f4c03c8e0e19cede2c3ca4c7` | Integrated locally |
| #798 | `f42200a586775aea9b0ec347baef246aacd607d4` | Integrated locally |
| #800 | `db6ec1f8b348367eb16aca8b2c8f1baac75468a7` | Integrated locally |
| #802 | `424a6b5a98542f5c22e25f9c22621891f8fe79d3` | Integrated locally |
| #804 | `e2a25df4107e030c3cf4f4ae3ef6a942c0df3c64` | Integrated locally |
| #807 | `bd02efabb029617bcbbe44f052837ef1ab01c6a4` | Integrated locally |
| #810 | `824e94a922b2ea277ea112d29c8c8cf2f9a3cdbf` | Integrated locally |
| #811 | `0199c48f935692c28c5a525b4c58ec66b4cb68a4` | Integrated locally |

## Usability changes

- Agents opens as a searchable list with names, status, settings, and delegated tasks; Map remains optional.
- Agent controls respond to the workspace's available width when navigation and Chat are open. The header and list occupy separate grid rows instead of relying on a fixed content offset.
- Work reports the runtime's task state without deriving percentage completion from a status label.
- Compact Chat uses one readable workspace with Close, Escape, focus restoration, and a protected background. Navigation reveals the destination.
- Memory follows available container width and gives viewer/domain controls stable accessible names.
- Address-bar edits survive refocusing, and Command Center only consumes Escape inside its own surface. Action menus use an opaque material so underlying page text cannot compete with their commands.
- Computer observations are available transiently to the executing model while durable history and idempotent replay use redacted projections. Screenshots are supplied as bounded image parts only when the executing route supports them.
- Text attachments are redacted as reference data before model input. Credential-like fields in a file do not allocate temporary task credentials or prevent an ordinary review task from starting; explicit message credentials still use protected task references.
- Local Ollama tool calls and missing-ID OpenAI-compatible calls receive a fresh generation namespace. Corrected observations no longer reuse the idempotency key of a prior failed read. Built-in browser arguments are checked against their declared schemas before approval; rejected arguments include safe guidance for visible tab and isolated session IDs.
- The macOS menus expose New Tab, New Task, Settings, browser history, and existing navigation commands. Packaged menus omit developer tools, and History uses Command-Y while Command-H retains the native Hide action.
- Input-dependent suffix scans use a single backward pass; budget and numbered-list matching avoid overlapping whitespace scans. Provider connection timers stop when headers arrive, while a separate response deadline and caller cancellation continue to bound generation. Ollama generation has a bounded allowance for local model loading and prefill.
- Canonical development installation supports an explicit full commit SHA with current-main ancestry, source/artifact integrity, owner, signature, channel, and downgrade checks.

## Evidence and boundaries

`pnpm audit:desktop-surfaces` writes fresh disposable-profile screenshots and a manifest to ignored `.tmp/release-surfaces/`. It covers the registered destinations, every actual Settings section, toolbar menus, and deeper stateful controls at desktop and compact widths. `pnpm verify` supplies the broader runtime, security, setup, browser, and packaged-CLI checks; a failing stage must be repaired or explicitly reported.

The integration run passed the production dependency audit, workspace type checks, 1,855 unit tests, source ingestion and browser workflow benchmarks, static settings/reference/market audits, workspace build, Node core and sidecar checks, native Chromium MV3 extension flow, website end-to-end tests, and all source desktop stages through managed-policy, packaged-CLI, editors, and the production secret scan. Desktop stages ran sequentially; stale UI selectors and compact-overlay expectations were corrected while their behavioral/security assertions remained intact. Auth handoffs passed in isolation after an interrupted combined run.

The attachment regression failed before repair; its 74-test focused suite and core type check passed afterward. Restart recovery then passed with the repaired build. The expanded surface audit passed **136/136 states with zero renderer errors**, covering registered pages, actual Settings sections, seven toolbar menus, search/list/map, compact Chat, specialist create/edit/archive/restore, Memory views/editor, Work sections, and Connections disclosure at desktop and compact widths. It also checks control containment, pairwise overlap, and list/header separation with navigation and Chat open. Follow-up unit suites passed 1,861 tests and then 1,864 tests; focused long-input, provider stream/deadline, and corrected-read tests cover the later repairs. The corrected Ollama read regression reproduced the cached failure before repair and passed afterward. A 220-test browser/runtime suite passed after the native menu changes. Source smoke verifies the actual native New Tab callback creates exactly one tab and focuses the address field, native Settings opens the expected screen, and packaged menus omit developer tools. The task-secret fixture uses an explicit desktop viewport so smaller CI displays do not hide the complete composer; its sandbox, fresh-approval, output-withholding, history and cleanup assertions remain intact. Screenshots and the manifest remain local ignored fixtures. Packaged, canonical, real-agent and remote CI evidence must be recorded separately in the pull request; this document does not certify those pending gates.

Source, disposable-profile UI, packaged signatures/hashes, canonical installation, real model runs, and remote CI are separate checks. Public distribution still requires the stable signed/notarized release workflow. A development install is not public-release certification or proof of comparative superiority over another product. Real provider login and sign-in handoffs require separate live evidence; synthetic handoff fixtures do not prove a provider will accept an embedded browser.

The missing-ID OpenAI-compatible corrected-read regression also reproduced a cached failure before repair; afterward, 91 provider, HTTP and agent-loop tests passed with core type checking, desktop build, and source smoke. The browser fixture checks closed Chat's accessibility and full-width geometry instead of treating its hidden border as a docked rail. Its compact collapse, focus exclusion, persisted collapse and reopen checks pass at 1000px. The remaining simultaneous browser/Chat journey uses an explicit desktop width. Remote core CI, CodeQL, and the full desktop browser journey passed on `d966a2bf`, including native hover/detach and Command-Y History. That desktop job then exposed an autofill fixture clicking a hidden model picker. The fixture now explicitly opens Chat, scopes the picker, and closes compact Chat before using browser forms; its preload and desktop checks pass locally with the security/layout assertions preserved.

A genuine installed-app Agent-tab task on product commit `97d1f80a` completed in a disposable profile using the existing local Ollama model and a browser-scoped personality. It opened one fresh local page with Allow once, performed a verified visible snapshot, and returned the exact heading, page-only nonce, and observed URL in three turns. Two verified receipts and zero renderer errors were recorded. A separate default-personality run with 86 tool definitions failed after 120 seconds before making a tool call; the scoped success does not certify that broader route. The real-profile canonical app still requires relaunch and a fresh task after the Mac is manually unlocked.

That completed-task screenshot exposed raw accessibility JSON filling Chat and obscuring the answer. Tool results now use compact status rows with closed, bounded Details, visible failures/withholding, and friendly browser labels. Only verified results receive a success mark, and nonzero command exits remain failures. Chat follows new answers at the bottom, preserves an older-message review position and keyboard focus, and updates messages appended outside its own active stream. Compact Close now keeps its icon and label on one contained row. The new disposable renderer fixture covers both widths, keyboard expansion, error visibility, bounded scrolling, answer follow, real wheel-based review scrolling, and focus preservation. It is also part of source verification and packaged CI; fixture messages are renderer proof, not model-completion evidence. Focused component tests, desktop type checking/build, approval-failure and task-credential checks pass with the new rendering.
