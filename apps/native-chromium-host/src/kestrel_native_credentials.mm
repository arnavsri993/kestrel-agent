#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include "kestrel_native_credentials.h"

#include <CommonCrypto/CommonCryptor.h>
#include <CommonCrypto/CommonRandom.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstring>
#include <fstream>
#include <sstream>

namespace {

constexpr char kSealedPrefix[] = "kestrel-native-cred-v1\n";
constexpr char kKeychainService[] = "Kestrel Native Safe Storage";
constexpr size_t kMasterKeyBytes = 32;
constexpr size_t kIvBytes = kCCBlockSizeAES128;

const char* const kBrokeredIds[] = {
    "openai",
    "openai-secondary",
    "anthropic",
    "anthropic-secondary",
    "gemini",
    "nous",
    "groq",
    "mistral",
    "openrouter",
    "cloudflare",
    "xai",
    "deepseek",
    "together",
    "fireworks",
    "nvidia",
    "huggingface",
    "perplexity",
    "github-models",
    "cohere",
    "tokenrouter",
    "bai",
    "inferx",
    "zenmux",
    "opencode-zen",
    "sensenova",
    "gmicloud",
    "tokenharbor",
    "cline",
    "command-code",
    "kilo",
    "orcarouter",
    "aihubmix",
    "brave-search",
    "github",
    "honcho",
    "fal",
    "onshape-access",
    "onshape-secret",
};

bool ensure_directory(const std::string& path) {
  NSString* ns_path = [NSString stringWithUTF8String:path.c_str()];
  NSError* error = nil;
  const BOOL ok = [[NSFileManager defaultManager]
      createDirectoryAtPath:ns_path
withIntermediateDirectories:YES
                 attributes:@{NSFilePosixPermissions : @0700}
                      error:&error];
  return ok == YES;
}

bool write_bytes_0600(const std::string& path, const std::string& bytes) {
  const std::string temporary = path + ".tmp";
  const int fd =
      open(temporary.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  size_t remaining = bytes.size();
  const char* cursor = bytes.data();
  while (remaining > 0) {
    const ssize_t written = write(fd, cursor, remaining);
    if (written <= 0) {
      close(fd);
      unlink(temporary.c_str());
      return false;
    }
    cursor += written;
    remaining -= static_cast<size_t>(written);
  }
  if (fsync(fd) != 0) {
    close(fd);
    unlink(temporary.c_str());
    return false;
  }
  close(fd);
  if (chmod(temporary.c_str(), 0600) != 0) {
    unlink(temporary.c_str());
    return false;
  }
  if (rename(temporary.c_str(), path.c_str()) != 0) {
    unlink(temporary.c_str());
    return false;
  }
  return true;
}

std::optional<std::string> read_bytes(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return std::nullopt;
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

std::string random_bytes(size_t count) {
  std::string bytes(count, '\0');
  if (CCRandomGenerateBytes(bytes.data(), count) != kCCSuccess) {
    return {};
  }
  return bytes;
}

std::optional<std::string> aes_encrypt(const std::string& key,
                                       const std::string& plaintext) {
  if (key.size() < kMasterKeyBytes) return std::nullopt;
  const std::string iv = random_bytes(kIvBytes);
  if (iv.size() != kIvBytes) return std::nullopt;
  std::string ciphertext(plaintext.size() + kCCBlockSizeAES128, '\0');
  size_t moved = 0;
  const CCCryptorStatus status = CCCrypt(
      kCCEncrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key.data(),
      kMasterKeyBytes, iv.data(), plaintext.data(), plaintext.size(),
      ciphertext.data(), ciphertext.size(), &moved);
  if (status != kCCSuccess) return std::nullopt;
  ciphertext.resize(moved);
  return iv + ciphertext;
}

std::optional<std::string> aes_decrypt(const std::string& key,
                                       const std::string& payload) {
  if (key.size() < kMasterKeyBytes || payload.size() <= kIvBytes) {
    return std::nullopt;
  }
  const std::string iv = payload.substr(0, kIvBytes);
  const std::string ciphertext = payload.substr(kIvBytes);
  std::string plaintext(ciphertext.size() + kCCBlockSizeAES128, '\0');
  size_t moved = 0;
  const CCCryptorStatus status = CCCrypt(
      kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key.data(),
      kMasterKeyBytes, iv.data(), ciphertext.data(), ciphertext.size(),
      plaintext.data(), plaintext.size(), &moved);
  if (status != kCCSuccess) return std::nullopt;
  plaintext.resize(moved);
  return plaintext;
}

bool valid_credential_value(const std::string& value) {
  if (value.size() < 8 || value.size() > 20'000) return false;
  if (value.find('\0') != std::string::npos) return false;
  return true;
}

}  // namespace

bool IsBrokeredCredentialId(const std::string& credential_id) {
  for (const char* id : kBrokeredIds) {
    if (credential_id == id) return true;
  }
  return false;
}

std::string BrokeredCredentialLabel(const std::string& credential_id) {
  if (credential_id == "openai") return "OpenAI";
  if (credential_id == "openai-secondary") return "OpenAI (secondary)";
  if (credential_id == "anthropic") return "Anthropic";
  if (credential_id == "anthropic-secondary") return "Anthropic (secondary)";
  if (credential_id == "gemini") return "Gemini";
  if (credential_id == "nous") return "Nous";
  if (credential_id == "groq") return "Groq";
  if (credential_id == "mistral") return "Mistral";
  if (credential_id == "openrouter") return "OpenRouter";
  if (credential_id == "cloudflare") return "Cloudflare";
  if (credential_id == "xai") return "xAI";
  if (credential_id == "deepseek") return "DeepSeek";
  if (credential_id == "together") return "Together";
  if (credential_id == "fireworks") return "Fireworks";
  if (credential_id == "nvidia") return "NVIDIA";
  if (credential_id == "huggingface") return "Hugging Face";
  if (credential_id == "perplexity") return "Perplexity";
  if (credential_id == "github-models") return "GitHub Models";
  if (credential_id == "cohere") return "Cohere";
  if (credential_id == "brave-search") return "Brave Search";
  if (credential_id == "github") return "GitHub";
  return credential_id;
}

bool NativeCredentialStore::Open(const std::string& isolated_profile_root,
                                 NativeCredentialStorageMode mode,
                                 std::string* error) {
  ready_ = false;
  master_key_.clear();
  mode_ = mode;
  if (isolated_profile_root.empty() || isolated_profile_root.front() != '/') {
    if (error) *error = "Credential storage requires an absolute isolated profile.";
    return false;
  }
  root_ = isolated_profile_root + "/secure/credentials";
  if (!ensure_directory(root_)) {
    if (error) *error = "Kestrel could not create its credential directory.";
    return false;
  }
  if (mode_ == NativeCredentialStorageMode::ProfileSealed) {
    if (!EnsureMasterKey(error)) return false;
  }
  ready_ = true;
  return true;
}

const char* NativeCredentialStore::mode_name() const {
  return mode_ == NativeCredentialStorageMode::Keychain ? "keychain"
                                                        : "profile-sealed";
}

bool NativeCredentialStore::EnsureReady(std::string* error) const {
  if (ready_) return true;
  if (error) *error = "Native credential storage is unavailable.";
  return false;
}

bool NativeCredentialStore::EnsureMasterKey(std::string* error) {
  // root_ is ".../secure/credentials"; keep the master key beside that tree.
  const std::string key_path = root_ + ".master";
  if (const auto existing = read_bytes(key_path)) {
    if (existing->size() == kMasterKeyBytes) {
      master_key_ = *existing;
      return true;
    }
    if (error) *error = "Native credential master key is corrupt.";
    return false;
  }
  master_key_ = random_bytes(kMasterKeyBytes);
  if (master_key_.size() != kMasterKeyBytes) {
    if (error) *error = "Kestrel could not create a credential master key.";
    return false;
  }
  if (!write_bytes_0600(key_path, master_key_)) {
    if (error) *error = "Kestrel could not persist its credential master key.";
    return false;
  }
  return true;
}

std::string NativeCredentialStore::PathFor(
    const std::string& credential_id) const {
  return root_ + "/" + credential_id + ".bin";
}

std::vector<NativeCredentialSummary> NativeCredentialStore::List() const {
  std::vector<NativeCredentialSummary> summaries;
  for (const char* id : kBrokeredIds) {
    NativeCredentialSummary summary;
    summary.id = id;
    summary.label = BrokeredCredentialLabel(id);
    summary.configured = Has(id);
    summaries.push_back(std::move(summary));
  }
  return summaries;
}

bool NativeCredentialStore::Has(const std::string& credential_id) const {
  if (!IsBrokeredCredentialId(credential_id) || !ready_) return false;
  if (mode_ == NativeCredentialStorageMode::Keychain) {
    return HasKeychain(credential_id);
  }
  return HasSealed(credential_id);
}

bool NativeCredentialStore::HasSealed(const std::string& credential_id) const {
  struct stat info {};
  return stat(PathFor(credential_id).c_str(), &info) == 0 && S_ISREG(info.st_mode);
}

bool NativeCredentialStore::Set(const std::string& credential_id,
                                const std::string& value,
                                std::string* error) {
  if (!EnsureReady(error)) return false;
  if (!IsBrokeredCredentialId(credential_id)) {
    if (error) *error = "Credential identifier is invalid.";
    return false;
  }
  if (!valid_credential_value(value)) {
    if (error) *error = "Credential value is invalid or too large.";
    return false;
  }
  if (mode_ == NativeCredentialStorageMode::Keychain) {
    return WriteKeychain(credential_id, value, error);
  }
  return WriteSealed(credential_id, value, error);
}

bool NativeCredentialStore::Remove(const std::string& credential_id,
                                   std::string* error) {
  if (!EnsureReady(error)) return false;
  if (!IsBrokeredCredentialId(credential_id)) {
    if (error) *error = "Credential identifier is invalid.";
    return false;
  }
  if (mode_ == NativeCredentialStorageMode::Keychain) {
    return RemoveKeychain(credential_id, error);
  }
  return RemoveSealed(credential_id, error);
}

bool NativeCredentialStore::WriteSealed(const std::string& credential_id,
                                        const std::string& value,
                                        std::string* error) {
  const auto encrypted = aes_encrypt(master_key_, value);
  if (!encrypted) {
    if (error) *error = "Kestrel could not seal the credential.";
    return false;
  }
  const std::string payload = std::string(kSealedPrefix) + *encrypted;
  if (!write_bytes_0600(PathFor(credential_id), payload)) {
    if (error) *error = "Kestrel could not persist the sealed credential.";
    return false;
  }
  return true;
}

bool NativeCredentialStore::RemoveSealed(const std::string& credential_id,
                                         std::string* error) {
  const std::string path = PathFor(credential_id);
  if (unlink(path.c_str()) == 0 || errno == ENOENT) return true;
  if (error) *error = "Kestrel could not remove the sealed credential.";
  return false;
}

bool NativeCredentialStore::WriteKeychain(const std::string& credential_id,
                                          const std::string& value,
                                          std::string* error) {
  NSData* data = [NSData dataWithBytes:value.data() length:value.size()];
  NSDictionary* query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @(kKeychainService),
    (__bridge id)kSecAttrAccount : @(credential_id.c_str()),
  };
  SecItemDelete((__bridge CFDictionaryRef)query);
  NSMutableDictionary* add = [query mutableCopy];
  add[(__bridge id)kSecValueData] = data;
  add[(__bridge id)kSecAttrAccessible] =
      (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  const OSStatus status = SecItemAdd((__bridge CFDictionaryRef)add, nullptr);
  if (status != errSecSuccess) {
    if (error)
      *error = "Kestrel could not save the credential in macOS Keychain.";
    return false;
  }
  return true;
}

bool NativeCredentialStore::RemoveKeychain(const std::string& credential_id,
                                           std::string* error) {
  NSDictionary* query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @(kKeychainService),
    (__bridge id)kSecAttrAccount : @(credential_id.c_str()),
  };
  const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
  if (status == errSecSuccess || status == errSecItemNotFound) return true;
  if (error)
    *error = "Kestrel could not remove the credential from macOS Keychain.";
  return false;
}

bool NativeCredentialStore::HasKeychain(const std::string& credential_id) const {
  NSDictionary* query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @(kKeychainService),
    (__bridge id)kSecAttrAccount : @(credential_id.c_str()),
    (__bridge id)kSecReturnData : @NO,
  };
  const OSStatus status =
      SecItemCopyMatching((__bridge CFDictionaryRef)query, nullptr);
  return status == errSecSuccess;
}
