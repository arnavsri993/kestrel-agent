#pragma once

#include <optional>
#include <string>
#include <vector>

// Native credential bootstrap for the Chromium host.
//
// Default mode seals provider credentials under the isolated profile with a
// profile-local key (0600). That path never calls macOS Keychain, so ad-hoc
// signed development builds cannot spam unlock prompts.
//
// Real Keychain mode is opt-in (--kestrel-real-keychain / KESTREL_USE_REAL_KEYCHAIN=1)
// and uses a native-specific Keychain service name so Electron's
// "Kestrel Safe Storage" items are never silently opened or merged.

enum class NativeCredentialStorageMode {
  ProfileSealed,
  Keychain,
};

struct NativeCredentialSummary {
  std::string id;
  std::string label;
  bool configured = false;
};

class NativeCredentialStore {
 public:
  bool Open(const std::string& isolated_profile_root,
            NativeCredentialStorageMode mode,
            std::string* error);

  NativeCredentialStorageMode mode() const { return mode_; }
  const char* mode_name() const;

  std::vector<NativeCredentialSummary> List() const;
  bool Set(const std::string& credential_id,
           const std::string& value,
           std::string* error);
  bool Remove(const std::string& credential_id, std::string* error);
  bool Has(const std::string& credential_id) const;

 private:
  bool EnsureReady(std::string* error) const;
  bool EnsureMasterKey(std::string* error);
  std::string PathFor(const std::string& credential_id) const;
  bool WriteSealed(const std::string& credential_id,
                   const std::string& value,
                   std::string* error);
  bool RemoveSealed(const std::string& credential_id, std::string* error);
  bool HasSealed(const std::string& credential_id) const;
  bool WriteKeychain(const std::string& credential_id,
                     const std::string& value,
                     std::string* error);
  bool RemoveKeychain(const std::string& credential_id, std::string* error);
  bool HasKeychain(const std::string& credential_id) const;

  NativeCredentialStorageMode mode_ = NativeCredentialStorageMode::ProfileSealed;
  std::string root_;
  std::string master_key_;
  bool ready_ = false;
};

bool IsBrokeredCredentialId(const std::string& credential_id);
std::string BrokeredCredentialLabel(const std::string& credential_id);
