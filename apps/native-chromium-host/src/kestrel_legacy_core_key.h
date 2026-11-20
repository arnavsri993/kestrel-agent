#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

enum class NativeLegacyCoreKeyFormat {
  Unsupported,
  MacSafeStorageV10,
  DevelopmentPlaintext,
};

// A narrow decoder for Kestrel's 32-byte database key only. It does not access
// Keychain, files, browser passwords or provider-owned login state. A protected
// host must supply the already-authorized legacy Keychain password in memory.
// Legacy CBC is not authenticated: validate the resulting key against the
// source database's authenticated records before accepting any migration.
// Callers own and must clear the input/password/output buffers after use.
NativeLegacyCoreKeyFormat InspectLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope);

// Development plaintext is rejected unless explicitly selected by a reviewed
// development-profile transfer. No fallback, key creation or source rewrite.
// Every failure clears the output; error text never includes supplied data.
bool UnwrapLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope,
    std::span<const uint8_t> authorized_keychain_password,
    bool allow_development_plaintext,
    std::array<uint8_t, 32>* database_key,
    std::string* error);

enum class NativeLegacyKeychainReadResult {
  Found,
  NotFound,
  UserInteractionRequired,
  Failure,
};
enum class NativeLegacyKeychainPromptPolicy {
  DoNotPrompt,
  AllowUserPrompt,
};

// Read-only, fixed-purpose seam. There is deliberately no account/service
// argument and no create/update/remove operation. The production reader only
// addresses Kestrel's historical Safe Storage item, never another product's.
// Keychain IO must run on the host's worker queue, away from the browser UI.
class NativeLegacyKestrelKeychainReader {
 public:
  virtual ~NativeLegacyKestrelKeychainReader() = default;
  virtual NativeLegacyKeychainReadResult ReadKestrelSafeStoragePassword(
      NativeLegacyKeychainPromptPolicy policy,
      std::vector<uint8_t>* password) = 0;
};

std::unique_ptr<NativeLegacyKestrelKeychainReader>
CreateNativeLegacyKestrelKeychainReader();

// Protected-host entry point for an explicitly authorized transfer. Unknown
// formats and development plaintext never cause a Keychain lookup. A caller
// must obtain a user-owned migration consent before choosing AllowUserPrompt;
// this function is not a renderer/agent RPC or a migration authorization.
bool UnlockLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope,
    NativeLegacyKestrelKeychainReader& reader,
    NativeLegacyKeychainPromptPolicy policy,
    bool allow_development_plaintext,
    std::array<uint8_t, 32>* database_key,
    std::string* error);
