# Platform portability

**Current product scope:** Apple Silicon macOS (see `docs/macos-distribution.md`).  
**Do not claim:** Windows or Linux support, universal/Intel macOS builds, or Mac App Store distribution.

This document separates **macOS-specific adapters** from **portable Core** so future ports can be estimated honestly. It does **not** schedule a port and does **not** assert that interfaces below are already fully extracted in code.

---

## Portable Core (intended)

Logic that should remain OS-agnostic and reusable:

| Area | Examples in-repo | Portability note |
| --- | --- | --- |
| Agent loop & approvals | `packages/agent-core` AgentLoop, grants, receipts | Portable if filesystem/DB adapters are injected |
| Model orchestration / routing | `model-orchestration.ts`, provider pool | Portable; provider CLIs may be OS-specific |
| Memory substrate | `memory-substrate.ts`, embeddings interface | Portable; embedding native deps must be gated |
| Tool schemas & policy | shared-types, approval vocabulary | Portable |
| Browser automation semantics | accessibility snapshot types, workflow corpus | Semantics portable; backend is not |
| Content-free observability | metrics without prompts/secrets | Portable exporters |
| Migration planners (bounded file import) | CLI migration plan/apply | Portable with path sandboxing |

Unsupported platforms must **deny closed** for privileged execution rather than run unsandboxed.

---

## macOS-specific interfaces (today)

These capabilities are bound to Apple platforms. Treat each as an adapter boundary for any future port.

### 1. Keychain / safeStorage

- **Role:** Protect database root keys and secret envelopes on **stable**.
- **macOS API:** Keychain Access control lists; Electron `safeStorage` backed by Keychain.
- **Future interface (sketch):** `SecretProtection { prepare?, encryptString, decryptString, isEncryptionAvailable }` — already approximated in credential broker. Windows DPAPI / Linux libsecret would be alternate implementations. **Not implemented.**

### 2. Accessibility

- **Role:** Trust checks for computer-use / UI automation; AX tree for browser tools.
- **macOS API:** Accessibility TCC (`systemPreferences.isTrustedAccessibilityClient`), system Settings deep links.
- **Future interface (sketch):** `AccessibilityTrust { status(), requestGuidance() }` plus browser-backend `getAccessibilityTree()`. Non-macOS would map to UI Automation / AT-SPI or remain unsupported (deny).

### 3. ScreenCaptureKit / Screen Recording

- **Role:** Whole-desktop computer-use screenshots and recording-gated tools (opt-in, approval-gated).
- **macOS API:** Screen Recording TCC; ScreenCaptureKit on modern macOS.
- **Future interface (sketch):** `DisplayCapture { permissionStatus(), captureFrame(bounds) }`. Without a backend, tools stay disabled.

### 4. Seatbelt

- **Role:** Sandboxed argv-only shell/process tools with workspace/network profiles.
- **macOS API:** `sandbox-exec` / Seatbelt profiles in the local execution backend.
- **Future interface (sketch):** `ProcessSandbox { run(argv, profile) }` with profiles `read-only` / `workspace-write` / `network`. Linux might use seccomp/landlock/containers; Windows Job Objects + AppContainer — **none claimed**.

### 5. CEF / native Chromium host

- **Role:** Progressive Electron→Chromium migration (`apps/native-chromium-host`).
- **macOS API:** Cocoa/CEF views, code signing, notarization for distribution.
- **Future interface (sketch):** `BrowserHostBackend` matching Electron browser service capabilities (see `docs/chromium-parity.json`). Other OSes would need their own CEF/Chromium packaging — **not started**.

### 6. Apple Events

- **Role:** Driving or cooperating with other macOS apps when explicitly permitted; automation boundaries.
- **macOS API:** Apple Events / Automation TCC.
- **Future interface (sketch):** `ExternalAppAutomation { isAuthorized(bundleId), send(event) }` with deny-default. Non-macOS equivalent is undefined; do not imply COM/D-Bus parity.

---

## Adapter checklist for a hypothetical port

Before anyone claims Windows/Linux:

1. Implement `SecretProtection` with OS backing or refuse stable channel.
2. Deny computer-use and screen capture until capture + trust adapters exist.
3. Provide a real `ProcessSandbox` or keep shell tools disabled.
4. Ship a browser backend that meets parity gates — or keep browser tools Electron-only on macOS.
5. Revisit packaging, update feed, and notarization/Authenticode/code-signing stories separately.
6. Re-run acquisition audit IDs that encode macOS assumptions (Keychain prompts, CEF cutover, Seatbelt).

---

## Explicit non-claims

- No Windows build, installer, or CI target is promised here.
- No Linux desktop package is promised here.
- Presence of TypeScript “core” packages is not evidence of cross-platform product readiness.
- Native CEF on macOS is not cutover (see `docs/chromium-cutover.md`).
