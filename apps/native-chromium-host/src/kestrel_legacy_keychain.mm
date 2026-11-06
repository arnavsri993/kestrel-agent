#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>

#include "kestrel_legacy_core_key.h"

namespace {

class ReadOnlyKestrelKeychain final : public NativeLegacyKestrelKeychainReader {
 public:
  NativeLegacyKeychainReadResult ReadKestrelSafeStoragePassword(
      NativeLegacyKeychainPromptPolicy policy,
      std::vector<uint8_t>* password) override {
    if (!password) return NativeLegacyKeychainReadResult::Failure;
    volatile uint8_t* previous = password->data();
    for (size_t i = 0; i < password->size(); ++i) previous[i] = 0;
    password->clear();
    LAContext* context = [[LAContext alloc] init];
    context.interactionNotAllowed = policy != NativeLegacyKeychainPromptPolicy::AllowUserPrompt;
    // Electron's app-name-derived legacy names are verified against the pinned
    // source. No search across browser/vendor keychains and no missing-item
    // creation fallback. macOS owns any explicitly allowed security prompt.
    NSDictionary* query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : @"Kestrel Safe Storage",
      (__bridge id)kSecAttrAccount : @"Kestrel",
      (__bridge id)kSecReturnData : @YES,
      (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
      (__bridge id)kSecUseAuthenticationContext : context,
    };
    CFTypeRef raw = nullptr;
    const OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
    if (status != errSecSuccess) {
      if (raw) CFRelease(raw);
      if (status == errSecItemNotFound) return NativeLegacyKeychainReadResult::NotFound;
      if (status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled)
        return NativeLegacyKeychainReadResult::UserInteractionRequired;
      return NativeLegacyKeychainReadResult::Failure;
    }
    if (!raw) return NativeLegacyKeychainReadResult::Failure;
    const bool is_data = CFGetTypeID(raw) == CFDataGetTypeID();
    if (is_data) {
      const auto data = static_cast<CFDataRef>(raw);
      const CFIndex size = CFDataGetLength(data);
      if (size > 0 && size <= 4096) {
        const auto* bytes = CFDataGetBytePtr(data);
        password->assign(bytes, bytes + size);
      }
    }
    CFRelease(raw);
    return password->empty() ? NativeLegacyKeychainReadResult::Failure
                             : NativeLegacyKeychainReadResult::Found;
  }
};

}  // namespace

std::unique_ptr<NativeLegacyKestrelKeychainReader>
CreateNativeLegacyKestrelKeychainReader() {
  return std::make_unique<ReadOnlyKestrelKeychain>();
}
