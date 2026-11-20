#include "../src/kestrel_local_vault_crypto_process.h"
#include <CommonCrypto/CommonDigest.h>
#include <Security/SecRandom.h>
#include <cstring>
#include <cstdio>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "isolated vault test failed at line %d\n", __LINE__); return 1; } } while (0)
int main(int argc, char** argv) {
  CHECK(argc == 2);
  std::vector<uint8_t> context({'p','r','o','f','i','l','e'}), master(32), envelope, result;
  CHECK(SecRandomCopyBytes(kSecRandomDefault, master.size(), master.data()) == 0);
  CHECK(NativeVaultSealIsolated(context, master, &envelope, argv[1]));
  CHECK(NativeVaultOpenIsolated(context, envelope, &result, argv[1]) && result == master);
  auto broken = envelope;
  size_t repr_len = (size_t(broken[8]) << 24) | (size_t(broken[9]) << 16) | (size_t(broken[10]) << 8) | broken[11];
  CHECK(repr_len > 3 && 44 + repr_len < broken.size());
  broken[46] ^= 1;
  CC_SHA256(broken.data() + 44, static_cast<CC_LONG>(repr_len), broken.data() + 12);
  CHECK(!NativeVaultOpenIsolated(context, broken, &result, argv[1]) && result.empty());
  CHECK(NativeVaultOpenIsolated(context, envelope, &result, argv[1]) && result == master);
  return 0;
}
