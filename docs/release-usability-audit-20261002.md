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
- Work reports the runtime's task state without deriving percentage completion from a status label.
- Compact Chat uses one readable workspace with Close, Escape, focus restoration, and a protected background. Navigation reveals the destination.
- Memory follows available container width and gives viewer/domain controls stable accessible names.
- Address-bar edits survive refocusing, and Command Center only consumes Escape inside its own surface. Action menus use an opaque material so underlying page text cannot compete with their commands.
- Computer observations are available transiently to the executing model while durable history and idempotent replay use redacted projections. Screenshots are supplied as bounded image parts only when the executing route supports them.
- Text attachments are redacted as reference data before model input. Credential-like fields in a file do not allocate temporary task credentials or prevent an ordinary review task from starting; explicit message credentials still use protected task references.
- Canonical development installation supports an explicit full commit SHA with current-main ancestry, source/artifact integrity, owner, signature, channel, and downgrade checks.

## Evidence and boundaries

`pnpm audit:desktop-surfaces` writes fresh disposable-profile screenshots and a manifest to ignored `.tmp/release-surfaces/`. It covers the registered destinations, every actual Settings section, toolbar menus, and deeper stateful controls at desktop and compact widths. `pnpm verify` supplies the broader runtime, security, setup, browser, and packaged-CLI checks; a failing stage must be repaired or explicitly reported.

The integration run passed the production dependency audit, workspace type checks, 1,855 unit tests, source ingestion and browser workflow benchmarks, static settings/reference/market audits, workspace build, Node core and sidecar checks, native Chromium MV3 extension flow, website end-to-end tests, and all source desktop stages through managed-policy, packaged-CLI, editors, and the production secret scan. Desktop stages ran sequentially; stale UI selectors and compact-overlay expectations were corrected while their behavioral/security assertions remained intact. Auth handoffs passed in isolation after an interrupted combined run.

The attachment regression failed before repair; its 74-test focused suite and core type check passed afterward. Restart recovery then passed with the repaired build. The expanded surface audit passed **135/135 states with zero renderer errors**, covering registered pages, actual Settings sections, seven toolbar menus, search/list/map, compact Chat, specialist create/edit/archive/restore, Memory views/editor, Work sections, and Connections disclosure at desktop and compact widths. Screenshots and the manifest remain local ignored fixtures. Packaged, canonical, real-agent and remote CI evidence must be recorded separately in the pull request; this document does not certify those pending gates.

Source, disposable-profile UI, packaged signatures/hashes, canonical installation, real model runs, and remote CI are separate checks. Public distribution still requires the stable signed/notarized release workflow. A development install is not public-release certification or proof of comparative superiority over another product. Real provider login and sign-in handoffs require separate live evidence; synthetic handoff fixtures do not prove a provider will accept an embedded browser.
