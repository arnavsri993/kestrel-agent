# Kestrel Production Release Risk Map

**Baseline:** `origin/main` @ `59cf7830` (`docs: clarify section G checkout to latest main post-#642 (#643)`)  
**Audit date:** 2026-08-29  
**Scope:** Consolidated findings from five read-only production-readiness audits (persistence, lifecycle/packaging, browser, security/IPC, agent runtime).  
**Status legend:** `fixed` = addressed in an open or merged PR; `open` = code fix still needed; `operator` = requires operator/infrastructure action, not a code PR alone.

---

## Executive summary

Five parallel audits at baseline `59cf7830` identified **14 release blockers** across data integrity, secret storage, agent safety, browser automation, and distribution infrastructure. A hardening sprint opened **seven PRs (#644–#651)** that address the highest-severity code gaps:

| Theme | Blockers found | PR coverage |
| --- | --- | --- |
| **Persistence** (audit `9aa4313c`) | R1, R2 | #645 (R1/R3/R5), #648 (R2) |
| **Lifecycle/packaging** (audit `370c4840`) | RB-01–03 (operator), P1-01 | #644 (P1-01/P1-02) |
| **Browser** (audit `f5c504b4`) | Tab lifecycle races | #649 (pin guard), #651 (mutation mutex) |
| **Security/IPC** (audit `cd7f30f9`) | RB-1, RB-2 | #646 |
| **Agent runtime** (audit `2314bc32`) | L1 | #647 |

**Code blockers with PRs in flight:** R1, R2, R3, R5, RB-1, RB-2, L1, P1-01, browser tab pin (BR-1), browser mutation mutex (BR-2).  
**Operator blockers (no code PR):** RB-01 (production signing/notarization), RB-02 (update feed hosting), RB-03 (Widget App Group registration).  
**Deferred P1 items:** R4 (legacy idempotency), security P1-1–P1-4 (CSP, step-up auth, DevTools, extension sideload), agent T2/N1 (SIGKILL escalation, provider connect timeout), lifecycle P1-03/P1-04.

**Release recommendation:** Do not ship public macOS builds until operator blockers RB-01–03 are proven, PRs #644–#651 are green and merged, and deferred P1 security items are either fixed or explicitly accepted in the threat model.

---

## Release blockers

| ID | Audit | Finding | Status | PR / action |
| --- | --- | --- | --- | --- |
| **R1** | Persistence | No SQLite corruption detection on startup; corrupt DB undetected until hard failure | **fixed** (PR open) | [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) — `PRAGMA integrity_check` + `DatabaseIntegrityError` |
| **R2** | Persistence | Schema migration has no backup gate; inline SQL drift from canonical migration files (v009 inline-only) | **fixed** (PR open) | [#648](https://github.com/arnavsri993/kestrel-agent/pull/648) — pre-migrate backup + load `migrations/*.sql` |
| **RB-1** | Security | Database root key stored without OS protection (`PlaintextSecretProtection`) | **fixed** (PR open) | [#646](https://github.com/arnavsri993/kestrel-agent/pull/646) — `safeStorage` / Keychain in packaged builds |
| **RB-2** | Security | Chromium cookie encryption disabled via `use-mock-keychain` in all builds | **fixed** (PR open) | [#646](https://github.com/arnavsri993/kestrel-agent/pull/646) — real Keychain in packaged builds |
| **L1** | Agent runtime | Stale `waiting_approval` runs remain resumable after user sends new message in same session | **fixed** (PR open, CI red) | [#647](https://github.com/arnavsri993/kestrel-agent/pull/647) — supersede on new `run()` |
| **BR-1** | Browser | Agent browser tools vs tab discard/sleep/close races — WebContents destroyed mid-CDP | **fixed** (PR open) | [#649](https://github.com/arnavsri993/kestrel-agent/pull/649) — ref-counted tab pins |
| **BR-2** | Browser | No serialization between tab mutations (`closeTab`, organize, detach) and agent backend | **fixed** (PR open) | [#651](https://github.com/arnavsri993/kestrel-agent/pull/651) — per-service tab mutation mutex (stacks on #649) |
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
| **T2** | Agent runtime | `command-runner` / `subscription-cli` only SIGTERM on cancel — no SIGKILL escalation | **open** | Mirror MCP/Codex pattern |
| **N1** | Agent runtime | No default connect/read timeout on `providerFetch` — hung TCP blocks until 10 min task timeout | **open** | `AbortSignal.timeout(connectMs)` + offline fast-fail |

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

## Open PRs (#644–#651)

CI snapshot: 2026-08-29 ~16:15 UTC.

| PR | Branch | Title | Audit items | CI state |
| --- | --- | --- | --- | --- |
| [#644](https://github.com/arnavsri993/kestrel-agent/pull/644) | `codex/production-shutdown-hardening` | Await shutdown before quit (P1-01) | P1-01, P1-02, T1 | ✅ Core **SUCCESS** · ✅ Desktop smoke **SUCCESS** |
| [#645](https://github.com/arnavsri993/kestrel-agent/pull/645) | `codex/production-persistence-hardening` | Persistence hardening (R1/R3/R5) | R1, R3, R5 | ✅ Core **SUCCESS** · ⏳ Desktop smoke **IN_PROGRESS** |
| [#646](https://github.com/arnavsri993/kestrel-agent/pull/646) | `codex/production-secret-storage` | Keychain safeStorage (RB-1, RB-2) | RB-1, RB-2 | ✅ Core **SUCCESS** · ⏳ Desktop smoke **IN_PROGRESS** |
| [#647](https://github.com/arnavsri993/kestrel-agent/pull/647) | `codex/production-approval-supersede` | Fix stale waiting_approval (L1) | L1 | ❌ Core **FAILURE** · ⏳ Desktop smoke **IN_PROGRESS** |
| [#648](https://github.com/arnavsri993/kestrel-agent/pull/648) | `codex/production-migration-backup` | Pre-migration backup + canonical SQL (R2) | R2 | ⏳ Core **QUEUED** · ⏳ Desktop smoke **QUEUED** |
| [#649](https://github.com/arnavsri993/kestrel-agent/pull/649) | `codex/production-browser-tab-pin` | Agent browser tab pin guard | BR-1 | ⏳ Core **IN_PROGRESS** · ⏳ Desktop smoke **IN_PROGRESS** |
| [#651](https://github.com/arnavsri993/kestrel-agent/pull/651) | `codex/production-browser-mutex` | Serialize tab mutations vs agent backend | BR-2 | ⏳ Core **QUEUED** · ⏳ Desktop smoke **QUEUED** (44/44 local tests) |

All seven PRs: mergeable, review required. #651 stacks on #649.

---

## Remaining work (post-merge)

### Code (next sprint)

1. **Legacy idempotency retirement (R4)** — audit `idempotent()` callers; migrate to claim-based API.
2. **Security P1 hardening** — CSP nonce/hash (P1-1), step-up auth (P1-2), block DevTools in prod (P1-3), restrict extension sideload (P1-4).
3. **Agent resilience (T2, N1)** — SIGKILL escalation for command-runner/subscription-cli; bounded connect timeout + offline fast-fail on `providerFetch`.
4. **Lifecycle P1-03/P1-04** — embed stable channel in prod plist; surface updater errors.
5. **Browser follow-ups (BR-3–BR-8)** — WebContents transfer on detach, CDP lifecycle hardening, render-process-gone while pinned.

### Operator (blocks public distribution)

1. **RB-01** — Populate `macos-release` GitHub environment secrets; run tagged release workflow; archive codesign/stapler/spctl evidence.
2. **RB-02** — Provision HTTPS update host; set `KESTREL_UPDATE_URL`; run `pnpm audit:market -- --distribution`.
3. **RB-03** — Register `group.com.kestrel.desktop` App Group; verify widget extension on signed build.

### Validation checklist (before release tag)

- [ ] All PRs #644–#651 merged; full `pnpm verify` green on `main`.
- [ ] Tagged `v*` workflow produces signed, notarized, stapled artifact.
- [ ] Clean-machine install from DMG/PKG passes Gatekeeper.
- [ ] Update check succeeds against live feed.
- [ ] Agent approval supersede: new message invalidates stale approval (L1 regression).
- [ ] Browser agent act on background tab while user opens tab 9+ — no mid-run discard (#649).
- [ ] Tab close/organize/detach during agent snapshot — serialized, no mid-CDP destroy (#651).
- [ ] Quit during active agent run — no orphaned core/Ollama processes (#644).
- [ ] DB corruption path surfaces recovery guidance (#645).
- [ ] Pre-migration backup created before schema upgrade (#648).
- [ ] Packaged build uses Keychain for DB key and cookies (#646).

---

## Suggested merge order

Merge in dependency order to minimize conflicts and validate incrementally:

```
1. #644  shutdown hardening     (P1-01/P1-02 — independent, green CI)
2. #645  persistence R1/R3/R5   (database layer — no migration file changes)
3. #646  secret storage RB-1/2  (Keychain — touches index.ts startup switches)
4. #648  migration backup R2    (canonical SQL — depends on stable DB layer from #645)
5. #647  approval supersede L1  (fix CI failure before merge)
6. #649  browser tab pin        (browser service — independent but last to reduce index.ts churn)
7. #651  browser mutation mutex (stacks on #649 — serialize tab ops vs agent backend)
```

**Rationale:**

- **#644 first** — lowest conflict surface; fixes quit race that affects all subsequent testing.
- **#645 before #648** — #645 adds integrity checks and transactions without changing migration loading; #648 restructures migration source of truth.
- **#646 before #648** — both touch startup/keychain paths; secret storage should land before migration backup adds more startup gates.
- **#647** — agent-loop change is isolated but currently CI-red; fix before merge.
- **#649 then #651** — tab pin is prerequisite for mutation mutex; #651 stacks on #649 and completes BR-1/BR-2 browser hardening.

After all seven merge, run operator checklist for RB-01–03 before tagging a public release.

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
