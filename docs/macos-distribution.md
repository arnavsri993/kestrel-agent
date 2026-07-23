# macOS runtime and distribution

The initial target is macOS 13+ through a direct, signed, notarized DMG. Development packages are intentionally labeled unsigned and are not release artifacts.

Identity values live in `packages/shared-types/src/identity.ts`. Development, beta, and stable channels use separate bundle IDs, storage directories, secrets, update feeds, pairing credentials, and IPC names.

Closing the main window hides it while the opted-in background agent continues. The menu bar exposes exact states, pending approvals, pause/resume, open, and quit. Quit checkpoints work and terminates the utility process.

Electron Builder produces DMG and ZIP artifacts with ASAR enabled. Native modules and approved sidecars are unpacked, resolved from `process.resourcesPath`, architecture-audited, signed, and verified before notarization. Production release requires Developer ID, App Store Connect notarization credentials, a signed update host, Apple Silicon and Intel packaged smoke tests, Gatekeeper validation, and checksums.
