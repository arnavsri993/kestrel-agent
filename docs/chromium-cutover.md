# Chromium cutover (controlled migration)

**Status:** Migration plan — **not cutover.**  
**Shipping runtime today:** Electron desktop app at `/Applications/Kestrel.app`  
**Native track:** CEF-based host under `apps/native-chromium-host` (progressive ownership)  
**Parity table:** [`docs/chromium-parity.json`](./chromium-parity.json)  
**Related:** [`docs/browseros-kestrel-browser-plan.md`](./browseros-kestrel-browser-plan.md), acquisition audit AR-P0-CHROMIUM-CUTOVER / AR-P0-EXTENSION-NATIVE

---

## Hard rule

Do **not** claim Chromium cutover, “Electron-free Kestrel,” or replacement of the canonical app until **every cutover gate below passes** and an explicit operator decision replaces `/Applications/Kestrel.app` through the documented install path. Source existence, a green native smoke, or PR #791 workbench evidence is **insufficient**.

Electron remains the only user-facing shipping browser+agent shell. Native builds must not silently migrate, merge, or delete the existing Kestrel profile, encrypted database, Keychain items, or Application Support data.

---

## Goals

1. Grow native CEF ownership surface-by-surface without lying about parity.
2. Keep one canonical macOS app identity for users (no parallel `Kestrel-*.app` installs left behind).
3. Preserve credentials and profiles across any future cutover with dry-run + checksum gates.
4. Make fail-closed the default when a surface is `missing` or `partial` on native.

---

## Progressive ownership (native CEF today)

| Surface | Native ownership today | Notes |
| --- | --- | --- |
| Process / CEF bootstrap | **Partial** | Alloy / content-runtime style; multi-view constraints documented in host sources. |
| Shell chrome | **Partial** | Native shell exists; not feature-complete vs Electron desktop chrome. |
| Tabs | **Partial** | Bridge-created tabs and repeated tab exercises in native smoke; not full Electron tab product. |
| Navigation | **Partial** | Core navigation paths exercised; external-protocol and auth handoffs still Electron-canonical. |
| Core relay | **Partial** | Ephemeral/unavailable Core reported in native status JSON; not full durable agent Core. |
| Profiles / sessions | **Missing → Partial** | Isolated / in-memory behaviors; no production profile migration. |
| Downloads | **Missing** | Unmigrated vs Electron app-contained downloads. |
| Site permissions | **Missing** | Unmigrated; Electron persists camera/mic + generic; USB/HID/serial denied. |
| Credentials / autofill | **Missing / disabled** | Native status reports credential storage disabled. |
| Extensions | **Disabled in product shell** | #791 opt-in workbench only; disposable profile; no privileged shell. |
| Updates / signing identity | **Electron** | Canonical install and update story remains Electron Builder / ad-hoc or Developer ID. |
| Agent tools / approvals | **Electron** | Kestrel approval authority and tool path ship in Electron. |

Treat this table as directional. Machine-readable detail lives in `docs/chromium-parity.json`. When code and JSON disagree, **fix the JSON to the worse (more honest) status** and open a tracking issue — do not “upgrade” status from hope.

---

## Migration phases

### Phase 0 — Evidence only (current)

- Run native smokes (`test:native-chromium-host`, core relay, optional `test:native-extensions`).
- Never replace `/Applications/Kestrel.app` with a native-only bundle.
- Record parity rows as `partial` / `missing` honestly.
- #791 workbench may demonstrate MV3 fixtures under an isolated profile; it does not raise product-shell extension status.

### Phase 1 — Feature parity behind an explicit native channel

- Implement missing surfaces to `complete` or document permanent `na` with product sign-off (e.g. USB denied by policy).
- Dual-run: Electron canonical; native available only via documented opt-in commands.
- No shared writable profile with Electron until a migration tool exists.

### Phase 2 — Profile migration dry-run

- Bounded export/import plan with checksums, no-overwrite default, recoverable backup.
- Credentials: Keychain / safeStorage migration design reviewed (see `docs/secure-storage.md`).
- Operator approval required before apply. Refuse raw-copy of encrypted DB into a different identity.

### Phase 3 — Cutover decision (only after gates)

- All **cutover gates** green.
- Single canonical app path updated in place (same consolidation rules as `install:mac:dev` — no duplicate Kestrels left in Finder).
- Post-cutover verification on a real machine: launch from Dock pin, open existing profile, run agent+browser smoke, confirm Keychain identity still unlocks.

If any gate fails, **stay on Electron**.

---

## Cutover gates

A gate is **pass** only with recorded evidence (command, date, machine, artifact path). “Should work” is fail.

| Gate ID | Requirement | Evidence |
| --- | --- | --- |
| G-PARITY | Every row in `chromium-parity.json` is `complete` or explicitly `na` with signed product rationale | JSON review + linked issues |
| G-SMOKE-NATIVE | Packaged/ad-hoc native host smokes pass on Apple Silicon (host, relay, shutdown) | CI or local log paths |
| G-EXT | If extensions are claimed: product shell (not only workbench) passes MV3 fixture + persistence gates | Fixture report under agreed evidence dir |
| G-PERM | Site permission persist/revoke parity for supported APIs; denied APIs documented | Automated tests |
| G-DL | Downloads: app-contained, size-limited, hashed, cancellable — parity with Electron policy | Tests + manual sample |
| G-CRED | Credential storage enabled with Keychain policy matching stable channel — **not** plaintext-default | Policy tests; no #782-style production plaintext |
| G-MIGRATE | Profile migration dry-run + apply on disposable profile; checksum verified; backup restorable | Operator-signed dry-run report |
| G-AGENT | Agent Core durable path, approvals, and tools work against native browser backend with fail-closed routing | Routing + tool receipt tests |
| G-SIGN | Distributable build Developer ID signed + notarized if publicly shipped | `spctl` / notary staple |
| G-SINGLE-APP | Only one user-facing Kestrel; Dock opens the cutover build; profile preserved | Finder + hash verification |
| G-ROLLBACK | Documented rollback to last Electron build without data loss | Rehearsed once on spare profile |

**Do not claim cutover until all gates pass.**

---

## Explicit anti-patterns

- Opening a `release/**/Kestrel.app` or native artifact beside the canonical app and calling that “done.”
- Raising extension compatibility state from workbench screenshots alone.
- Copying Application Support between Electron and native identities without migration.
- Marketing “Chromium browser” while Electron still owns sessions, downloads, and credentials.
- Merging #782-style plaintext defaults to quiet Keychain prompts during native bring-up.

---

## Operator commands (non-exhaustive)

Prefer repo scripts as they evolve; do not invent readiness from binary presence:

```bash
# Electron remains the everyday app
corepack pnpm dev:desktop
# or refresh canonical install
corepack pnpm install:mac:dev

# Native evidence (opt-in; not cutover)
corepack pnpm test:native-chromium-host
corepack pnpm test:native-chromium-core-relay
# PR #791 track — isolated extension workbench
corepack pnpm test:native-extensions
```

Report **configured / reachable / verified** separately for each.

---

## Exit criteria (one-line)

Cutover is complete only when Electron is no longer required for any `complete` parity surface, gates G-* are green with evidence, and the Dock-pinned `/Applications/Kestrel.app` is the native-backed build serving the user’s existing migrated profile — until then, **Electron ships.**
