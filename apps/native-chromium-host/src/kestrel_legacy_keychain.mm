#include "kestrel_legacy_core_key.h"

namespace {
class DisabledLegacyKeychain final : public NativeLegacyKestrelKeychainReader {
 public:
  NativeLegacyKeychainReadResult ReadKestrelSafeStoragePassword(
      NativeLegacyKeychainPromptPolicy, std::vector<uint8_t>* password) override {
    if (password) {
      volatile uint8_t* bytes = password->data();
      for (size_t n = password->size(); n; --n) *bytes++ = 0;
      password->clear();
    }
    // Protected legacy profiles are preserved for an explicit supported
    // migration. This path never opens a password item or prompts macOS.
    return NativeLegacyKeychainReadResult::Failure;
  }
};
}
std::unique_ptr<NativeLegacyKestrelKeychainReader>
CreateNativeLegacyKestrelKeychainReader() {
  return std::make_unique<DisabledLegacyKeychain>();
}
