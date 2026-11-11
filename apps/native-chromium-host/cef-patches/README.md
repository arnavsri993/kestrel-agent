# Pinned Kestrel local-vault CEF source extension

This is a concrete, **uncompiled** source patch set, not a usable CEF binary or a
verified replacement for the installed app. `manifest.json` pins CEF
`cf671c072925b27823a61181152f4f288e8e4306` and Chromium
`fb096c0011f9d50f0a264a9376420cdea9c421e3` (tag `156.0.8078.80`), records patch
SHA256 digests, and records the exact original-file SHA256 values used to check
application. Only five small original files are needed for the apply fixture.

## API and startup boundary

The custom macOS framework exports a hand-written C ABI in
`include/cef_kestrel_vault.h`, included in the CEF distribution through
`cef_paths2.gypi`:

```c
unsigned int cef_kestrel_vault_api_version(void);  /* must return 1 */
int cef_kestrel_vault_configure(uint8_t* browser_key, size_t browser_key_size);
```

The host must find both exported symbols in its loaded, trusted framework and
require API version 1 before opening the browser profile or calling
`CefInitialize`. Stock CEF has no such API and is unsupported. No fallback to
Keychain, a mock Keychain, a basic password store, or a static key is authorized.
These are direct C exports, not generated `cef_app_capi.h` methods: there are no
changes to generated CEF structures, the stock API hash, or C++ wrapper layout.
Compilation, exported-symbol inspection and an actual C/C++ consumer link remain
required before this extension's ABI can be called build-supported.

On the browser main thread, unlock the host vault and derive a distinct 32-byte
browser key using the host's versioned HKDF context. Copy it into a separate,
writable 32-byte buffer and call configure once before `CefInitialize`. The
function copies the accepted key and securely zeros that caller buffer on
success or rejection (for a non-null exactly-32-byte input). Clear the host
buffer as well. Never pass the master secret, send the key through argv/env,
write it to a sidecar, or provide it to helpers or renderer/JavaScript code.

A main executable using `CefExecuteProcess` must wait for its `-1` browser return
before deriving a key; a normal macOS separate-helper executable layout need
not call it in the main host. Configure rejects a known subprocess commandline;
`CefInitialize` independently rejects `--type` arguments and an absent/late key
before constructing `CefContext` or normalizing/accessing cache/profile paths.

The Chromium patch registers `KestrelVaultKeyProvider` as the **sole** provider
in Kestrel mode, replacing `KeychainKeyProvider` rather than appending a fallback.
The provider uses the distinct `v99` prefix and Chromium's AES-256-GCM Encryptor;
it securely erases its configuration staging copy after constructing the
Encryptor key. Only the derived key enters Chromium's normal private Encryptor
Mojo distribution to its network service. If the provider cannot supply a key,
it reports `kTemporarilyUnavailable`, never `kPermanentlyUnavailable` (which
Chromium consumers may interpret as permission to discard ciphertext).

This is a fresh, vault-bound browser-profile format. It does not decrypt or
migrate legacy `v10`/system-Keychain profiles. The host must enforce its fresh
profile/format/key-binding guard and preserve existing user profiles. No import,
master-key rotation, crash-memory erasure guarantee, or legacy conversion is
implemented by these patches.

## Bounded verification and source preparation

```bash
# At most 300 KB of pinned primary-source files; disposable .tmp fixture only.
node scripts/prepare-native-vault-cef.mjs --verify-upstream-patches
KESTREL_VERIFY_UPSTREAM_PATCHES=1 corepack pnpm exec vitest run scripts/prepare-native-vault-cef.test.mjs

# A separately provisioned full Chromium src checkout with CEF at src/cef.
# Default is read-only preflight. No checkout/download/build is performed.
node scripts/prepare-native-vault-cef.mjs --chromium-source /absolute/path/to/src
# Apply only after that preflight passes:
node scripts/prepare-native-vault-cef.mjs --chromium-source /absolute/path/to/src --apply
```

Source preflight requires exact Git HEAD pins, distinct Git roots, unchanged
upstream patch targets, no pre-existing new target files, `git apply --check`,
**at least 150 GiB free**, macOS arm64, full Xcode with a macOS SDK, and
`git`, `python3`, `gclient`, `gn`, `autoninja`, and `clang`. It refuses mismatched
or already CEF-modified target files; it does not reset/overwrite them. If normal
CEF patching changes these same targets, preparation must stop for an explicit
source integration review. Successful apply writes a source-only receipt with
pins and digests, and rolls back its own patches if applying fails. The script
never builds, signs, installs, launches, prompts for Keychain access, or changes
the user's installed app/profile. A machine with about 55 GB free cannot pass
this build preflight and must not attempt a full source checkout/build.

Remaining evidence requires a sufficiently provisioned build machine: compile
the trusted pinned engine through CEF's normal build/distribution process,
verify both actual framework exports, test the startup guard and key lifecycle,
then test restart/cookies/credentials/GCM tamper behavior on a generated fresh
profile. No such compile, runtime, codesign, Keychain, or real-profile test is
claimed here.
