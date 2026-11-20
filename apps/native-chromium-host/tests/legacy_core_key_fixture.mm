#import <Foundation/Foundation.h>

#include "kestrel_legacy_core_key.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <stdexcept>
#include <unistd.h>
#include <vector>

class FixtureReader final : public NativeLegacyKestrelKeychainReader {
 public:
  std::vector<uint8_t> supplied_password;
  std::string mode;
  int calls = 0;
  bool prompt_allowed = false;
  NativeLegacyKeychainReadResult ReadKestrelSafeStoragePassword(
      NativeLegacyKeychainPromptPolicy policy, std::vector<uint8_t>* password) override {
    ++calls;
    prompt_allowed = policy == NativeLegacyKeychainPromptPolicy::AllowUserPrompt;
    *password = supplied_password;
    if (mode == "throw") throw std::runtime_error("generated-private-reader-error");
    if (mode == "missing") return NativeLegacyKeychainReadResult::NotFound;
    if (mode == "locked") return NativeLegacyKeychainReadResult::UserInteractionRequired;
    if (mode == "failed") return NativeLegacyKeychainReadResult::Failure;
    return NativeLegacyKeychainReadResult::Found;
  }
};

// Generated-test inputs only. Decoded fixture keys use a separate anonymous
// pipe (fd 3), never stdout/stderr. This executable is not shipped in the app.
int main() {
  @autoreleasepool {
    std::vector<uint8_t> input;
    uint8_t chunk[1024];
    for (;;) {
      const ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));
      if (count == 0) break;
      if (count < 0) { if (errno == EINTR) continue; return 2; }
      if (input.size() + static_cast<size_t>(count) > 16 * 1024) return 2;
      input.insert(input.end(), chunk, chunk + count);
    }
    NSDictionary* request = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithBytes:input.data() length:input.size()] options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class] ||
        ![request[@"envelope"] isKindOfClass:NSString.class] ||
        ![request[@"password"] isKindOfClass:NSString.class]) return 2;
    NSData* envelope = [[NSData alloc] initWithBase64EncodedString:request[@"envelope"] options:0];
    NSData* password = [[NSData alloc] initWithBase64EncodedString:request[@"password"] options:0];
    if (!envelope || !password) return 2;
    std::array<uint8_t, 32> key;
    key.fill(0xa5);
    std::string error;
    const std::span<const uint8_t> bytes(static_cast<const uint8_t*>(envelope.bytes), static_cast<size_t>(envelope.length));
    const std::span<const uint8_t> password_bytes(static_cast<const uint8_t*>(password.bytes), static_cast<size_t>(password.length));
    FixtureReader reader;
    reader.supplied_password.assign(password_bytes.begin(), password_bytes.end());
    if ([request[@"readerMode"] isKindOfClass:NSString.class]) reader.mode = [request[@"readerMode"] UTF8String];
    const bool ok = [request[@"useReader"] isEqual:@YES]
        ? UnlockLegacyKestrelCoreKey(bytes, reader,
            [request[@"allowPrompt"] isEqual:@YES] ? NativeLegacyKeychainPromptPolicy::AllowUserPrompt
                                                  : NativeLegacyKeychainPromptPolicy::DoNotPrompt,
            [request[@"allowDevelopmentPlaintext"] isEqual:@YES], &key, &error)
        : UnwrapLegacyKestrelCoreKey(bytes, password_bytes,
            [request[@"allowDevelopmentPlaintext"] isEqual:@YES], &key, &error);
    if (ok) {
      size_t offset = 0;
      while (offset < key.size()) {
        const ssize_t count = write(3, key.data() + offset, key.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 3;
        offset += static_cast<size_t>(count);
      }
    }
    const bool cleared = std::all_of(key.begin(), key.end(), [](uint8_t byte) { return byte == 0; });
    const auto format = InspectLegacyKestrelCoreKey(bytes);
    NSDictionary* result = @{
      @"ok": @(ok), @"failureOutputCleared": @(!ok && cleared),
      @"format": @(static_cast<int>(format)), @"error": @(error.c_str()),
      @"keychainReadCalls": @(reader.calls), @"promptAllowed": @(reader.prompt_allowed),
    };
    std::fill(key.begin(), key.end(), 0);
    NSData* output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    if (!output || fwrite(output.bytes, 1, output.length, stdout) != output.length) return 3;
    return 0;
  }
}
