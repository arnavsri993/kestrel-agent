#pragma once

#include <optional>
#include <string>
#include <vector>

// Website password vault for the native Chromium host.
//
// Sealed under the isolated native profile (never the Electron Application
// Support path). Used by visible-autofill after the page login-form probe.

struct NativePasswordEntry {
  std::string id;
  std::string origin;
  std::string username;
  std::string password;
};

class NativePasswordVault {
 public:
  bool Open(const std::string& isolated_profile_root, std::string* error);

  std::vector<NativePasswordEntry> ListForOrigin(const std::string& origin) const;
  bool Save(const std::string& origin,
            const std::string& username,
            const std::string& password,
            std::string* error);

 private:
  bool EnsureReady(std::string* error) const;
  bool EnsureMasterKey(std::string* error);
  bool LoadEntries(std::vector<NativePasswordEntry>* entries,
                   std::string* error) const;
  bool WriteEntries(const std::vector<NativePasswordEntry>& entries,
                    std::string* error) const;

  std::string root_;
  std::string vault_path_;
  std::string master_key_;
  bool ready_ = false;
};

std::optional<std::string> OriginFromUrl(const std::string& url);
