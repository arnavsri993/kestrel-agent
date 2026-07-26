# macOS runtime and distribution

The initial target is macOS 13+ through a direct, signed, notarized DMG. Development packages are intentionally labeled unsigned and are not release artifacts.

Identity values live in `packages/shared-types/src/identity.ts`. Development, beta, and stable channels use separate bundle IDs, storage directories, secrets, update feeds, pairing credentials, and IPC names.

Closing the main window hides it while the opted-in background agent continues. The menu bar exposes exact states, pending approvals, pause/resume, open, and quit. Quit checkpoints work and terminates the utility process.

Electron Builder produces Apple Silicon DMG and ZIP artifacts for direct distribution and an Apple Silicon PKG for managed deployment. Native modules and approved sidecars are unpacked, resolved from `process.resourcesPath`, architecture-audited, signed, and verified before notarization. Production internet release requires Developer ID Application signing, Developer ID Installer signing for the PKG, Apple notarization-service credentials, a signed update host, an arm64 packaged smoke test, Gatekeeper validation, and checksums. Kestrel does not produce an Intel, universal, or Mac App Store build.

The PKG is the MDM-oriented installer for company-wide rollout. It is published alongside the DMG and ZIP but is not used by the electron-updater feed. An organization still needs its own MDM enrollment, device scope, privacy/managed-policy values, and a clean enrolled-device install test; this repository does not pretend to configure a company's MDM for it.
