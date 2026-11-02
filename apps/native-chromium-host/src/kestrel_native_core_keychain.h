#pragma once

#include <memory>
#include <string>
#include <vector>

enum class NativeCoreKeychainResult {
  Success,
  NotFound,
  Duplicate,
  Failure,
};

// Narrow injectable seam for the macOS Keychain. Tests can provide an
// in-memory implementation without calling Security.framework.
class NativeCoreKeychainBackend {
 public:
  virtual ~NativeCoreKeychainBackend() = default;
  virtual NativeCoreKeychainResult Read(const std::string& account,
                                       std::vector<unsigned char>* value) = 0;
  virtual NativeCoreKeychainResult Add(
      const std::string& account,
      const std::vector<unsigned char>& value) = 0;
};

class NativeCoreProfileKeyStore {
 public:
  explicit NativeCoreProfileKeyStore(
      std::shared_ptr<NativeCoreKeychainBackend> backend = nullptr);

  // Returns the existing profile key or creates one for a genuinely fresh
  // native profile. Legacy file-key profiles require an explicit migration;
  // this service deliberately does not import, rotate, or delete those keys.
  bool GetOrCreate(const std::string& canonical_profile_root,
                   std::string* key_base64,
                   std::string* error);

  // Explicit test-only durable key lane. It is restricted to owned private
  // temporary profiles and development bundle identities, and stores a
  // separate mode-0600 test key. Production callers must use GetOrCreate.
  bool GetOrCreateDisposableTestKey(
      const std::string& canonical_profile_root,
      const std::string& bundle_identifier,
      const std::string& bundle_path,
      std::string* key_base64,
      std::string* error);

 private:
  std::shared_ptr<NativeCoreKeychainBackend> backend_;
};
