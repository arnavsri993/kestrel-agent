#!/bin/bash
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/kestrel-vault-test.XXXXXXXX")"
trap 'rm -rf "$tmp"' EXIT
xcrun clang -c "$root/apps/native-chromium-host/tests/kestrel_local_vault_crypto_test.c" -o "$tmp/test.o"
xcrun swiftc -parse-as-library -emit-object "$root/apps/native-chromium-host/src/kestrel_local_vault_crypto.swift" -o "$tmp/vault.o"
xcrun swiftc "$tmp/vault.o" "$tmp/test.o" -framework Security -framework LocalAuthentication -o "$tmp/test"
"$tmp/test" seal "$tmp/fixture"
"$tmp/test" open "$tmp/fixture"
xcrun clang++ -std=c++17 -c "$root/apps/native-chromium-host/src/kestrel_local_vault_crypto_helper.cc" -o "$tmp/helper.o"
xcrun swiftc "$tmp/vault.o" "$tmp/helper.o" -framework Security -framework LocalAuthentication -Xlinker -lc++ -o "$tmp/Kestrel Vault"
xcrun clang++ -std=c++17 -fobjc-arc "$root/apps/native-chromium-host/src/kestrel_local_vault_crypto_process.mm" "$root/apps/native-chromium-host/tests/kestrel_local_vault_crypto_process_test.mm" -framework Foundation -framework Security -o "$tmp/process-test"
"$tmp/process-test" "$tmp/Kestrel Vault"
printf 'Secure Enclave local vault crypto and isolation tests passed (cross-process).\n'
