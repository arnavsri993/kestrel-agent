# Secure storage

**Audience:** Engineers and diligence reviewers  
**Related code:** `apps/desktop/src/main/secure-storage-policy.ts`, `apps/desktop/src/main/credential-broker.ts`  
**Related audit IDs:** AR-P0-SECURE-STORAGE-PROMPTS  
**Related PR:** [#782](https://github.com/arnavsri993/kestrel-agent/pull/782) — **REJECT as production default**

---

## Threat model

### Assets

| Asset | Why it matters |
| --- | --- |
| Database root key | Unlocks the encrypted local database (history, agent state, private state). |
| Provider credentials | API keys and OAuth material stored via credential broker / account stores — never paste into chat. |
| Browser / autofill secrets | Passwords and payment vault material when those features are enabled. |
| Keychain / safeStorage envelopes | OS-backed wrapping that binds ciphertext to machine + app signing identity. |
| Migration leftovers | Legacy sealed blobs that still need decrypt-once migration. |

### Adversaries

| Adversary | Capability | Mitigations in scope |
| --- | --- | --- |
| Malware with user-file read | Reads Application Support files | OS Keychain / `safeStorage` so root key is not plaintext on disk in **stable** |
| Casual disk inspection | Same | Same; development plaintext is isolated to non-stable channels |
| Process compromise as Kestrel | Can use unlocked keys in-process | Outside envelope encryption; rely on OS sandbox, approvals, Seatbelt for tools |
| Supply-chain / swapped binary | Different code signature | Keychain ACL prompts; stable Developer ID consistency |
| Confused operator | Turns off protection to silence prompts | Policy docs + reject plaintext-as-production-default |

Out of scope for this document: remote server breach (Kestrel is local-first), physical attacker with unlocked session and screen, or user voluntary export.

---

## Stable vs development policy

From `shouldUseRealKeychain` / `shouldUseSafeStorage`:

| Channel / context | Keychain | Database root key protection |
| --- | --- | --- |
| **stable** | Real macOS Keychain | Electron `safeStorage` (unless explicit allow-plaintext override) |
| **development** | Mock Keychain by default | Plaintext envelopes allowed for isolation |
| `KESTREL_TEST_USER_DATA` | Mock / non-real | Non-safeStorage |
| Explicit overrides | See recovery env vars below | See below |

**Intent:** Distributable builds protect secrets with the OS. Ad-hoc development rebuilds must not thrash the Keychain ACL every time the code signature changes.

Production **never** silently falls back from safeStorage to plaintext without an explicit override. That is the opposite of #782’s “Keychain off / plaintext by default” proposal.

---

## Why Keychain prompts happen

Common causes observed in this codebase and packaging flow:

1. **Signing churn** — Ad-hoc or changing Developer identities change the ACL client. macOS asks the user to allow “Kestrel Safe Storage” (or similar) again.
2. **Eager prepare / probe** — Calling Electron `safeStorage.isEncryptionAvailable()` (or otherwise touching safeStorage) during startup **prepare** can contact the Keychain even when the selected policy is plaintext/mock. That is the wrong place to discover encryption availability if plaintext mode was chosen.
3. **Legacy sealed keys** — Profiles that already contain safeStorage-wrapped root keys legitimately need Keychain access on first decrypt after a policy or binary change.

Prompts are annoying; they are not a license to store production secrets in plaintext.

---

## Correct fix (lazy migration)

1. **Keep stable → Keychain / safeStorage.**
2. **Do not touch `safeStorage` in prepare** when plaintext/mock policy is active.
3. **Resolve safeStorage lazily** only when decrypting a blob that still has a legacy sealed prefix / format.
4. After successful migration to the active policy’s envelope, avoid re-probing on every launch.
5. Keep development on mock Keychain so ad-hoc rebuilds stay quiet **without** changing stable defaults.

`PlaintextSecretProtection.prepare()` should remain a no-op regarding Electron safeStorage; migration storage is contacted on decrypt of legacy material only.

---

## REJECT: plaintext as production default (#782)

PR #782 proposes:

- Default Chromium/macOS Keychain to mock mode to avoid password dialogs on normal launches.
- Keep database root keys in local plaintext envelopes by default.
- Opt-in back via `KESTREL_USE_SAFESTORAGE=1` / `KESTREL_USE_REAL_KEYCHAIN=1`.

**Disposition for acquisition / shipping:** **REJECT.**

Silencing prompts by disabling protection inverts the threat model. Diligence readers should treat merge of #782 as a security regression unless it is rewritten to:

- preserve stable→Keychain, and
- only apply mock/plaintext to development/test channels, and
- implement lazy migration rather than “never Keychain.”

Stopping prompts in **development** is already the job of `shouldUseRealKeychain` / mock policy — not of making plaintext the product default.

---

## Migration from legacy sealed keys

Expected behavior:

1. Detect legacy safeStorage-sealed database key (or per-file sealed credentials from older builds).
2. On **first read**, with user-context that can unlock Keychain if needed, decrypt via safeStorage.
3. Re-encrypt / rewrite under the **active** policy (safeStorage on stable; plaintext envelope only when policy explicitly allows).
4. Fail closed if decrypt fails — do not invent a new root key and silently orphan the database.
5. Never log key material, tokens, or envelope plaintext.

Tests already describe migrating safeStorage-wrapped database keys to plaintext **when plaintext protection is the selected implementation** (development/recovery), and sealing when explicitly opted into safeStorage. Do not generalize those tests into “production is plaintext.”

---

## Recovery environment variables

Use only for recovery, CI isolation, or explicit operator debugging. Do not publish as “recommended for everyone.”

| Variable | Effect (summary) |
| --- | --- |
| `KESTREL_USE_MOCK_KEYCHAIN=1` | Force mock Keychain (no real Keychain). |
| `KESTREL_USE_REAL_KEYCHAIN=1` | Force real Keychain even outside stable. |
| `KESTREL_USE_SAFESTORAGE=1` | Force safeStorage for DB root key path. |
| `KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE=1` | Allow plaintext envelopes (disables safeStorage path). |
| `KESTREL_TEST_USER_DATA` | Test profile isolation; non-real Keychain / non-safeStorage defaults. |

Exact precedence is defined in `secure-storage-policy.ts` and credential broker construction — read the code before inventing new flags.

---

## Operator checklist

- [ ] Stable builds: confirm channel is `stable` and Keychain/safeStorage are active.
- [ ] Development: confirm mock Keychain; no expectation of production-grade envelopes.
- [ ] After signing identity changes: expect a **one-time** ACL prompt on stable, not a policy flip.
- [ ] Never merge plaintext-default for production to “fix” prompts.
- [ ] Never ask users to paste Keychain passwords, API keys, or OAuth tokens into chat.
