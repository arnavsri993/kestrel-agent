# Kestrel Production Release Risk Map

**Baseline:** `origin/main` @ `4b492f5c` (`docs: refresh Stanford demo gate evidence at e20d539b (#664)`)  
**Audit date:** 2026-08-29  
**Sprint closeout:** 2026-08-29 — see [Engineering ship verdict](#engineering-ship-verdict-sprint-closeout) below.
**Scope:** Consolidated findings from five read-only production-readiness audits (persistence, lifecycle/packaging, browser, security/IPC, agent runtime).  
**Status legend:** `fixed` = merged on `main`; `open` = code fix still needed; `operator` = requires operator/infrastructure action, not a code PR alone.

---

## Executive summary

Five parallel audits at baseline `59cf7830` identified **14 release blockers** across data integrity, secret storage, agent safety, browser automation, and distribution infrastructure. A hardening sprint opened **ten PRs (#644–#651, #653, #656, #657)** that address the highest-severity code gaps. **All code blockers are now merged on `main`.**

| Theme | Blockers found | PR coverage |
| --- | --- | --- |
| **Persistence** (audit `9aa4313c`) | R1, R2 | #645 (R1/R3/R5), #648 (R2) |
| **Lifecycle/packaging** (audit `370c4840`) | RB-01–03 (operator), P1-01 | #644 (P1-01/P1-02) |
| **Browser** (audit `f5c504b4`) | Tab lifecycle races | #649 (pin guard), #651 (mutation mutex) |
| **Security/IPC** (audit `cd7f30f9`) | RB-1, RB-2 | #657 (supersedes closed #646) |
| **Agent runtime** (audit `2314bc32`) | L1, T2, N1 | #647 (L1), #653 (T2), #656 (N1) |

**Code blockers merged on `main`:** R1, R2, R3, R5, L1, P1-01, browser tab pin (BR-1), browser mutation mutex (BR-2), SIGKILL escalation (T2), provider connect timeout (N1).  
**Regressed (Keychain revert):** RB-1, RB-2 — #657 Keychain/safeStorage path disabled; plaintext + mock Keychain restored.  
**Operator blockers (no code PR):** RB-01 (production signing/notarization), RB-02 (update feed hosting), RB-03 (Widget App Group registration) — **still open**.  
**Deferred P1 items:** R4 (legacy idempotency), security P1-1–P1-4 (CSP, step-up auth, DevTools, extension sideload), lifecycle P1-03/P1-04.

**Release recommendation:** Do not ship public macOS builds until operator blockers **RB-01–03** are proven and deferred P1 security items are either fixed or explicitly accepted in the threat model. All hardening PRs are merged; remaining gaps are operator infrastructure and the next code sprint. For Stanford vs public release decisions, use the [Engineering ship verdict](#engineering-ship-verdict-sprint-closeout).

---

## Engineering ship verdict (sprint closeout)

**Verdict date:** 2026-08-29  
**Evidence baseline:** `verify:meetup` **PASS** at `e20d539b`; docs/B1 handoff at `8ba24d72`; sprint closeout docs at `4b492f5c` (#664).

| Target | Verdict | Rationale |
| --- | --- | --- |
| **Stanford demo (offline primary path)** | **SHIP WITH KNOWN RISKS** | `verify:meetup` **PASS** at `e20d539b` (~198s; 1033 unit tests, 50/50 e2e, 50/50 browser benchmark packaged). Hero pillars **B1–B3 COMPLETE** in repo (#663 Activity handoff, #624/#625 New Tab + memory surfacing). Repository gates A1–A7 and A9 **COMPLETE** on engineering Mac. **Operator rehearsal required:** presentation Mac must re-run `verify:meetup` at `8ba24d72` or later, canonical install, Readiness warm-up, disposable project, memory beat, venue timing — see [stanford-demo-checklist.md](./stanford-demo-checklist.md). |
| **Public macOS release** | **DO NOT SHIP** | Operator blockers **RB-01–03** unproven (production signing/notarization, update feed hosting, Widget App Group). Security **P1-2** (step-up auth for privileged IPC) and **P1-4** (extension sideload restriction) **deferred**. Run [public-release-operator-checklist.md](./public-release-operator-checklist.md) before any stable tag. |

**Engineering sprint status:** Closed. No P0 code blockers remain for the offline demo path. Next work: operator RB-01–03, security P1-2/P1-4, and presentation Mac rehearsal.

---

## Release blockers

| ID | Audit | Finding | Status | PR / action |
| --- | --- | --- | --- | --- |
| **R1** | Persistence | No SQLite corruption detection on startup; corrupt DB undetected until hard failure | **fixed** | [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) — `PRAGMA integrity_check` + `DatabaseIntegrityError` |
| **R2** | Persistence | Schema migration has no backup gate; inline SQL drift from canonical migration files (v009 inline-only) | **fixed** | [#648](https://github.com/arnavsri993/kestrel-agent/pull/648) — pre-migrate backup + load `migrations/*.sql` |
| **RB-1** | Security | Database root key stored without OS protection (`PlaintextSecretProtection`) | **regressed** | [#657](https://github.com/arnavsri993/kestrel-agent/pull/657) merged Keychain/safeStorage; reverted — Keychain unreliable on user machines |
| **RB-2** | Security | Chromium cookie encryption disabled via `use-mock-keychain` in all builds | **regressed** | [#657](https://github.com/arnavsri993/kestrel-agent/pull/657) enabled real Keychain in packaged builds; reverted — mock Keychain default restored |
| **L1** | Agent runtime | Stale `waiting_approval` runs remain resumable after user sends new message in same session | **fixed** | [#647](https://github.com/arnavsri993/kestrel-agent/pull/647) — supersede on new `run()` |
| **BR-1** | Browser | Agent browser tools vs tab discard/sleep/close races — WebContents destroyed mid-CDP | **fixed** | [#649](https://github.com/arnavsri993/kestrel-agent/pull/649) — ref-counted tab pins |
| **BR-2** | Browser | No serialization between tab mutations (`closeTab`, organize, detach) and agent backend | **fixed** | [#651](https://github.com/arnavsri993/kestrel-agent/pull/651) — per-service tab mutation mutex |
| **RB-01** | Lifecycle | No verified production-signed/notarized artifact end-to-end | **operator** | Configure `macos-release` secrets; run tagged `v*` workflow per [public-release-operator-checklist.md](./public-release-operator-checklist.md) |
| **RB-02** | Lifecycle | Update feed not live — stable builds call `autoUpdater` against unprovisioned URL | **operator** | Set repo var `KESTREL_UPDATE_URL`; host `latest-mac.yml` + signed ZIP/blockmaps |
| **RB-03** | Lifecycle | Widget App Group (`group.com.kestrel.desktop`) signing dependency unproven | **operator** | Register App Group for host + extension; verify on signed build |

---

## P1 — High priority (ship soon)

| ID | Audit | Finding | Status | PR / notes |
| --- | --- | --- | --- | --- |
| **P1-01** | Lifecycle | Graceful shutdown race — `will-quit` does not await `supervisor.stop()` / Ollama stop | **fixed** | [#644](https://github.com/arnavsri993/kestrel-agent/pull/644) |
| **P1-02** | Lifecycle | OAuth/Codex child may outlive quit during sign-in | **fixed** | [#644](https://github.com/arnavsri993/kestrel-agent/pull/644) (same PR) |
| **R3** | Persistence | `upsertMemory()` writes memories + metadata outside transaction | **fixed** | [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) |
| **R5** | Persistence | Receipt/activity cap deletes not transactional with insert | **fixed** | [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) |
| **R4** | Persistence | Legacy `idempotent()` non-atomic read-check-write (TOCTOU) | **open** | Route callers to claim-based API; not in current PRs |
| **P1-03** | Lifecycle | Production release channel not embedded in prod plist | **open** | Add `KESTREL_RELEASE_CHANNEL=stable` to prod electron-builder config |
| **P1-04** | Lifecycle | Updater failures silently ignored (`checkForUpdates().catch(() => undefined)`) | **open** | Surface errors to renderer/tray + diagnostic export |
| **P1-1** | Security | Trusted renderer CSP allows `unsafe-inline` — XSS → full IPC bridge | **open** | Nonce/hash CSP in Vite build pipeline |
| **P1-2** | Security | Privileged IPC lacks step-up auth (credentials, vault, reset-local-data) | **open** | Touch ID / admin password gate for destructive ops |
| **P1-3** | Security | DevTools openable in packaged builds via IPC | **open** | Reject `browser-open-devtools` when packaged |
| **P1-4** | Security | Extension sideloading from renderer IPC | **open** | Restrict to Web Store IDs or block in production |
| **BR-3** | Browser | Detach destroys live WebContents; detached window reloads URL (session loss) | **open** | Transfer WebContents on detach instead of destroy + reload |
| **BR-4** | Browser | Duplicate `tabId` during detach — ambiguous `browserServiceForTab()` routing | **open** | Atomic detach handoff or new tab id in detached window |
| **BR-5** | Browser | Sleeping-tabs monitor evicts agent targets (no agent-awareness beyond pin) | **open** | Covered by #649 pins; verify with sleeping-tab tests |
| **BR-6** | Browser | Close during in-flight CDP — no `isDestroyed` guard in backend | **open** | Harden `browser-backend-node-target.ts` |
| **T1** | Agent runtime | Quit cleanup race (same as P1-01) | **fixed** | [#644](https://github.com/arnavsri993/kestrel-agent/pull/644) |
| **T2** | Agent runtime | `command-runner` / `subscription-cli` only SIGTERM on cancel — no SIGKILL escalation | **fixed** | [#653](https://github.com/arnavsri993/kestrel-agent/pull/653) |
| **N1** | Agent runtime | No default connect/read timeout on `providerFetch` — hung TCP blocks until 10 min task timeout | **fixed** | [#656](https://github.com/arnavsri993/kestrel-agent/pull/656) — 20s connect timeout + offline fast-fail |

---

## P2 — Medium priority

| ID | Audit | Finding | Status |
| --- | --- | --- | --- |
| **R6** | Persistence | Reference migration `apply()` uses direct `writeFileSync` (non-atomic) | open |
| **R7** | Persistence | Browser state load silently discards corrupt tabs | open |
| **R8** | Persistence | CLI vs desktop key store paths divergent | open |
| **P2-01** | Lifecycle | `install:mac:dev` installs ad-hoc dev bundle to `/Applications/Kestrel.app` | open |
| **P2-02** | Lifecycle | Dev + stable share `userDataDirectoryName: "Kestrel"` | accepted / document |
| **P2-03** | Lifecycle | `autoInstallOnAppQuit` races graceful shutdown | open |
| **P2-04** | Lifecycle | Packaging requires macOS toolchain at pack time (`after-pack.cjs`) | open |
| **P2-05** | Lifecycle | Main app retains `disable-library-validation` entitlement | accepted tradeoff |
| **P2-1** | Security | Log redaction agent-tool scoped only; main/console unredacted | open |
| **P2-2** | Security | `encryptionKeyBase64` retained in utility bootstrap config | open |
| **P2-3** | Security | Workspace snapshot exposes full memory content to renderer | open |
| **P2-4** | Security | Sandbox disabled in dev builds | dev-only |
| **P2-5** | Security | Browser extension CRX install lacks signature verification | open |
| **L2** | Agent runtime | Failed/cancelled runs leave partial transcript unless user retries | open |
| **N2** | Agent runtime | Supervisor IPC timeout (30 min) > agent execution timeout (10 min) | open |
| **N4** | Agent runtime | 401/403 trigger health backoff delaying recovery after auth fix | open |
| **N5** | Agent runtime | Offline = sequential provider exhaustion, no fast short-circuit | open |
| **T3** | Agent runtime | Background processes stopped with SIGTERM only on `runtime.close()` | open |
| **A1** | Agent runtime | `ProviderAuthMonitor` polls every 6h; no tie-in to in-flight errors | open |
| **A3** | Agent runtime | Auth failures surface as generic `ProviderPoolError` | open |
| **A4** | Agent runtime | Local/Ollama offline depends on pool retry behavior | open |
| **BR-7** | Browser | `render-process-gone` closes pinned views — user must reload | open (post-#649) |
| **BR-8** | Browser | CDP debugger stays attached after snapshot/act on user-browser views | open |
| **BR-9** | Browser | `act()` ends with `syncActiveView()` — can detach tab agent just acted on | open |
| **BR-10** | Browser | Last-tab-closed → window.close can surprise agent multi-tab workflows | open |

---

## Hardening PRs (merged on `main`)

All hardening PRs merged 2026-08-29. CI was green (Core + Desktop smoke **SUCCESS**) on each before merge.

| PR | Title | Audit items | Merged |
| --- | --- | --- | --- |
| [#644](https://github.com/arnavsri993/kestrel-agent/pull/644) | Await shutdown before quit (P1-01) | P1-01, P1-02, T1 | ✅ 2026-08-29 |
| [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) | Persistence hardening (R1/R3/R5) | R1, R3, R5 | ✅ 2026-08-29 |
| [#647](https://github.com/arnavsri993/kestrel-agent/pull/647) | Fix stale waiting_approval (L1) | L1 | ✅ 2026-08-29 |
| [#648](https://github.com/arnavsri993/kestrel-agent/pull/648) | Pre-migration backup + canonical SQL (R2) | R2 | ✅ 2026-08-29 |
| [#649](https://github.com/arnavsri993/kestrel-agent/pull/649) | Agent browser tab pin guard | BR-1 | ✅ 2026-08-29 |
| [#651](https://github.com/arnavsri993/kestrel-agent/pull/651) | Serialize tab mutations vs agent backend | BR-2 | ✅ 2026-08-29 |
| [#653](https://github.com/arnavsri993/kestrel-agent/pull/653) | SIGKILL escalation for command-runner/subscription-cli | T2 | ✅ 2026-08-29 |
| [#656](https://github.com/arnavsri993/kestrel-agent/pull/656) | Bound provider connect with 20s timeout | N1 | ✅ 2026-08-29 |
| [#657](https://github.com/arnavsri993/kestrel-agent/pull/657) | Keychain safeStorage (RB-1, RB-2) | RB-1, RB-2 | ✅ 2026-08-29 — **regressed** by Keychain revert PR |

**Note:** [#646](https://github.com/arnavsri993/kestrel-agent/pull/646) was closed without merge; #657 landed RB-1/RB-2 on `main`, then Keychain/safeStorage was reverted because real Keychain is unreliable on user machines.

**Open PRs:** None from the hardening sprint. Next work is operator RB-01–03 and deferred P1 items below.

---

## Remaining work (post-merge)

### Code (next sprint)

1. **Legacy idempotency retirement (R4)** — audit `idempotent()` callers; migrate to claim-based API.
2. **Security P1 hardening** — CSP nonce/hash (P1-1), step-up auth (P1-2), block DevTools in prod (P1-3), restrict extension sideload (P1-4).
3. **Lifecycle P1-03/P1-04** — embed stable channel in prod plist; surface updater errors.
4. **Browser follow-ups (BR-3–BR-8)** — WebContents transfer on detach, CDP lifecycle hardening, render-process-gone while pinned.

### Operator (blocks public distribution)

1. **RB-01** — Populate `macos-release` GitHub environment secrets; run tagged release workflow; archive codesign/stapler/spctl evidence.
2. **RB-02** — Provision HTTPS update host; set `KESTREL_UPDATE_URL`; run `pnpm audit:market -- --distribution`.
3. **RB-03** — Register `group.com.kestrel.desktop` App Group; verify widget extension on signed build.

### Validation checklist (before release tag)

- [x] All hardening PRs #644–#651, #653, #656, #657 merged on `main`.
- [ ] Full `pnpm verify` green on `main`.
- [ ] Tagged `v*` workflow produces signed, notarized, stapled artifact.
- [ ] Clean-machine install from DMG/PKG passes Gatekeeper.
- [ ] Update check succeeds against live feed.
- [ ] Agent approval supersede: new message invalidates stale approval (L1 regression).
- [ ] Browser agent act on background tab while user opens tab 9+ — no mid-run discard (#649).
- [ ] Tab close/organize/detach during agent snapshot — serialized, no mid-CDP destroy (#651).
- [ ] Quit during active agent run — no orphaned core/Ollama processes (#644).
- [ ] DB corruption path surfaces recovery guidance (#645).
- [ ] Pre-migration backup created before schema upgrade (#648).
- [ ] Packaged build uses mock Keychain and plaintext database root key by default (Keychain revert).
- [ ] Cancelled command-runner/subscription-cli children receive SIGKILL after grace period (#653).
- [ ] Provider connect timeout fires within 20s on unreachable host (#656).

---

## Merge order (completed)

All items merged in dependency order on 2026-08-29:

```
✅ #644  shutdown hardening     (P1-01/P1-02)
✅ #645  persistence R1/R3/R5
✅ #648  migration backup R2    (stacked on #645)
✅ #647  approval supersede L1
✅ #653  SIGKILL escalation T2
✅ #649  browser tab pin
✅ #651  browser mutation mutex (stacked on #649)
✅ #656  provider connect timeout (N1)
✅ #657  secret storage RB-1/2  (supersedes closed #646)
```

Next step: run operator checklist for **RB-01–03** before tagging a public release.

---

## Audit source references

| Audit ID | Workstream | Agent transcript |
| --- | --- | --- |
| `9aa4313c` | Persistence, data integrity, migrations | Persistence audit — R1–R11 |
| `370c4840` | Startup/shutdown, packaging, signing, update | Lifecycle audit — RB-01–03, P1-01–04, P2-01–05 |
| `f5c504b4` | Browser/tab/window lifecycle, WebContentsView | Browser audit — tab races, discard/sleep/close |
| `cd7f30f9` | Security, IPC, preload, secrets | Security audit — RB-1/RB-2, P1-1–P1-4 |
| `2314bc32` | Agent runtime, network, cancellation | Agent runtime audit — L1, T2, N1 |

Related docs: [public-release-operator-checklist.md](./public-release-operator-checklist.md), [threat-model.md](./threat-model.md), [macos-distribution.md](./macos-distribution.md).
