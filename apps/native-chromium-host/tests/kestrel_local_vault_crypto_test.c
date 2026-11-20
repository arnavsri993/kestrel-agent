#include "../src/kestrel_local_vault_crypto.h"
#include <Security/SecRandom.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static const uint8_t context[] = "test-profile-context";
static const uint8_t other[] = "other-profile-context";
static const uint8_t db[] = "native-core-database/v1";
static const uint8_t browser[] = "chromium-oscrypt/v1";
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "vault test failed at line %d\n", __LINE__); return 1; } } while (0)
static int zeros(const uint8_t *p, size_t n) { for (size_t i = 0; i < n; i++) if (p[i]) return 0; return 1; }
int main(int argc, char **argv) {
  CHECK(argc == 3);
  uint8_t master[32], result[32], a[32], b[32], envelope[KESTREL_VAULT_MAX_ENVELOPE];
  size_t n = 0, len = 0;
  FILE *f;
  if (!strcmp(argv[1], "seal")) {
    CHECK(SecRandomCopyBytes(kSecRandomDefault, sizeof(master), master) == 0);
    CHECK(kestrel_vault_seal(context, sizeof(context)-1, master, 32, envelope, sizeof(envelope), &len) == 0);
    CHECK(len > 0 && len <= sizeof(envelope));
    f = fopen(argv[2], "wb"); CHECK(f); CHECK(fwrite(master, 1, 32, f) == 32); CHECK(fwrite(envelope, 1, len, f) == len); CHECK(fclose(f) == 0);
  } else {
    CHECK(!strcmp(argv[1], "open"));
    f = fopen(argv[2], "rb"); CHECK(f); CHECK(fread(master, 1, 32, f) == 32);
    len = fread(envelope, 1, sizeof(envelope), f); CHECK(feof(f)); CHECK(fclose(f) == 0);
    CHECK(kestrel_vault_open(context, sizeof(context)-1, envelope, len, result, 32, &n) == 0 && n == 32 && memcmp(master, result, 32) == 0);
    memset(result, 0xaa, 32); n = 99;
    CHECK(kestrel_vault_open(other, sizeof(other)-1, envelope, len, result, 32, &n) != 0 && n == 0 && zeros(result, 32));
    for (size_t i = 0; i < len; i++) {
      envelope[i] ^= 1; memset(result, 0xaa, 32); n = 99;
      CHECK(kestrel_vault_open(context, sizeof(context)-1, envelope, len, result, 32, &n) != 0 && n == 0 && zeros(result, 32));
      envelope[i] ^= 1;
    }
    CHECK(kestrel_vault_derive(context, sizeof(context)-1, master, 32, db, sizeof(db)-1, a, 32, &n) == 0 && n == 32);
    CHECK(kestrel_vault_derive(context, sizeof(context)-1, master, 32, browser, sizeof(browser)-1, b, 32, &n) == 0 && memcmp(a,b,32));
    CHECK(kestrel_vault_derive(other, sizeof(other)-1, master, 32, db, sizeof(db)-1, b, 32, &n) == 0 && memcmp(a,b,32));
    memset(result, 0xaa, 32); n = 99;
    CHECK(kestrel_vault_derive(context, sizeof(context)-1, master, 32, other, sizeof(other)-1, result, 32, &n) == KESTREL_VAULT_INVALID && n == 0 && zeros(result,32));
    memset(result, 0xaa, 32); n = 99;
    CHECK(kestrel_vault_open(context, sizeof(context)-1, envelope, len, result, 31, &n) == KESTREL_VAULT_BUFFER_TOO_SMALL && n == 0 && zeros(result,31));
  }
  memset(master, 0, 32); memset(result, 0, 32); memset(a, 0, 32); memset(b, 0, 32);
  return 0;
}
