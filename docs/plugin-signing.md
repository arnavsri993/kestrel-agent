# Plugin signing

Kestrel-managed plugins must be signed by an explicitly trusted Ed25519 publisher. External development bundles may be discovered, but they are labeled external and cannot use the managed install/update/remove lifecycle.

## Publisher document

Import a JSON file from Settings:

```json
{
  "keyId": "publisher.example",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

Kestrel canonicalizes the SPKI public key, displays its SHA-256 fingerprint, rejects non-Ed25519 keys, and refuses silent replacement of an existing key ID.

## Bundle signature

The bundle contains `.codex-plugin/plugin.json` and `.codex-plugin/signature.json`:

```json
{
  "algorithm": "ed25519",
  "keyId": "publisher.example",
  "digest": "64 lowercase hexadecimal characters",
  "signature": "base64 Ed25519 signature over the 32 digest bytes"
}
```

The version-1 digest is SHA-256 over `kestrel-plugin-bundle-v1\0`, followed by every regular file except the signature file in byte-sorted normalized relative-path order. Each path and file body is preceded by its unsigned 64-bit big-endian byte length. `PluginInstaller.digestForSigning()` exposes the exact digest implementation for publisher tooling.

Before activation, Kestrel rejects symbolic links, special files, path collisions after Unicode NFC normalization, oversized files/bundles, untrusted keys, digest/signature mismatches, invalid root manifests, escaping manifest paths, and invalid Agent Skills metadata. It re-verifies the staged copy immediately before the atomic rename.
