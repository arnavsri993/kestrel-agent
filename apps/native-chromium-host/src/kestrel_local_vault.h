#pragma once

#include <memory>
#include <string>
#include <vector>

// Injection is for native file-safety fixtures only. Production always uses
// the Secure Enclave implementation; there is no runtime software fallback.
class NativeLocalVaultCrypto {
 public:
  virtual ~NativeLocalVaultCrypto() = default;
  virtual bool Seal(const std::string& context,
                    const std::vector<unsigned char>& master,
                    std::vector<unsigned char>* envelope) = 0;
  virtual bool Open(const std::string& context,
                    const std::vector<unsigned char>& envelope,
                    std::vector<unsigned char>* master) = 0;
  virtual bool Derive(const std::string& context,
                      const std::vector<unsigned char>& master,
                      const std::string& purpose,
                      std::vector<unsigned char>* key) = 0;
};

class NativeLocalVault {
 public:
  explicit NativeLocalVault(std::shared_ptr<NativeLocalVaultCrypto> crypto = nullptr);
  // The caller must establish that this is a genuinely fresh profile before
  // allow_create=true. Missing, damaged, inaccessible or moved vaults never
  // cause key replacement. This device-bound vault is not a portable backup.
  bool GetKey(const std::string& canonical_profile_root,
              const std::string& purpose, bool allow_create,
              std::vector<unsigned char>* key, std::string* error);

 private:
  std::shared_ptr<NativeLocalVaultCrypto> crypto_;
};
