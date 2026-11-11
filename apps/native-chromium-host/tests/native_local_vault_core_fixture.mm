#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <iostream>
#include <cstring>
#include <string>
#include "../src/kestrel_native_core_keychain.h"

int main(int argc, const char** argv) {
  @autoreleasepool {
    if (argc != 3) return 2;
    std::string mode(argv[1]), profile(argv[2]), value, error;
    NativeCoreProfileKeyStore store;
    const bool ok = mode == "create" ? store.GetOrCreate(profile, &value, &error)
                    : mode == "existing" ? store.GetExisting(profile, &value, &error)
                    : mode == "refuse" ? store.GetOrCreate(profile, &value, &error) : false;
    if (mode == "refuse") return !ok && value.empty() ? 0 : 1;
    if (!ok) return 1;
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
