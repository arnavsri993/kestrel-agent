#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <iostream>
#include <cstring>
#include <string>
#include <unistd.h>
#include "../src/kestrel_native_core_keychain.h"

int main(int argc, const char** argv) {
  @autoreleasepool {
    if (argc != 3) return 2;
    std::string mode(argv[1]), profile(argv[2]), value, error;
    NativeCoreProfileKeyStore store;
    const bool ok = mode == "create" ? store.GetOrCreate(profile, &value, &error)
                    : mode == "existing" ? store.GetExisting(profile, &value, &error)
                    : mode == "refuse" ? store.GetOrCreate(profile, &value, &error)
                    : mode == "private-core-key" ? store.GetExisting(profile, &value, &error) : false;
    if (mode == "refuse") return !ok && value.empty() ? 0 : 1;
    if (!ok) return 1;
    if (mode == "private-core-key") {
      // Fixture-only private pipe. Never emit a key to an interactive terminal
      // or accept one via arguments/environment. The harness bounds this process.
      constexpr char request[] = "kestrel-vault-core-fixture-key-v1\n";
      char input[sizeof(request)] {};
      const ssize_t count = read(STDIN_FILENO, input, sizeof(input));
      if (isatty(STDIN_FILENO) || isatty(STDOUT_FILENO) ||
          count != static_cast<ssize_t>(sizeof(request) - 1) || memcmp(input, request, sizeof(request) - 1)) return 1;
      std::cout << value << std::endl;
      volatile char* bytes = value.data();
      for (size_t n = value.size(); n; --n) *bytes++ = 0;
      return 0;
    }
    NSData* decoded = [[NSData alloc] initWithBase64EncodedString:[NSString stringWithUTF8String:value.c_str()] options:0];
    if (decoded.length != 32) return 1;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(decoded.bytes, (CC_LONG)decoded.length, digest);
    static const char hex[] = "0123456789abcdef";
    for (unsigned char byte : digest) std::cout << hex[byte >> 4] << hex[byte & 15];
    std::cout << std::endl;
    volatile char* v = value.data(); for (size_t i = 0; i < value.size(); ++i) v[i] = 0;
    volatile unsigned char* d = digest; for (size_t i = 0; i < sizeof(digest); ++i) d[i] = 0;
    return 0;
  }
}
