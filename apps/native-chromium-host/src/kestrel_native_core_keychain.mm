#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include "kestrel_native_core_keychain.h"

#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonRandom.h>

#include <algorithm>
#include <cstdint>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>

#include <array>
#include <cerrno>
#include <cstring>

namespace {

constexpr char kCoreKeyService[] = "com.kestrel.native-core.database-key.v1";
constexpr size_t kCoreKeyBytes = 32;
constexpr char kBase64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

class SecurityFrameworkKeychain final : public NativeCoreKeychainBackend {
 public:
  NativeCoreKeychainResult Read(
      const std::string& account,
      std::vector<unsigned char>* value) override {
    if (!value) return NativeCoreKeychainResult::Failure;
    NSDictionary* query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : @(kCoreKeyService),
      (__bridge id)kSecAttrAccount : @(account.c_str()),
      (__bridge id)kSecReturnData : @YES,
      (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
    };
    CFTypeRef raw = nullptr;
    const OSStatus status =
        SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
    if (status == errSecItemNotFound) return NativeCoreKeychainResult::NotFound;
    if (status != errSecSuccess || !raw) return NativeCoreKeychainResult::Failure;
    NSData* data = (__bridge_transfer NSData*)raw;
    if (data.length > 0) {
      const auto* begin = static_cast<const unsigned char*>(data.bytes);
      value->assign(begin, begin + data.length);
    } else {
      value->clear();
    }
    return NativeCoreKeychainResult::Success;
  }

  NativeCoreKeychainResult Add(
      const std::string& account,
      const std::vector<unsigned char>& value) override {
    NSData* data = [NSData dataWithBytes:value.data() length:value.size()];
    NSDictionary* item = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : @(kCoreKeyService),
      (__bridge id)kSecAttrAccount : @(account.c_str()),
      (__bridge id)kSecValueData : data,
      (__bridge id)kSecAttrAccessible :
          (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      (__bridge id)kSecAttrSynchronizable : @NO,
    };
    const OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, nullptr);
    if (status == errSecSuccess) return NativeCoreKeychainResult::Success;
    if (status == errSecDuplicateItem) return NativeCoreKeychainResult::Duplicate;
    return NativeCoreKeychainResult::Failure;
  }
};

bool ValidPrivateDirectory(const std::string& path, bool must_exist,
                           bool* exists) {
  struct stat info {};
  if (lstat(path.c_str(), &info) != 0) {
    if (!must_exist && errno == ENOENT) {
      if (exists) *exists = false;
      return true;
    }
    return false;
  }
  if (exists) *exists = true;
  return S_ISDIR(info.st_mode) && info.st_uid == getuid() &&
         (info.st_mode & 0077) == 0;
}

bool PathExistsWithoutFollowingLinks(const std::string& path, bool* exists) {
  struct stat info {};
  if (lstat(path.c_str(), &info) == 0) {
    if (exists) *exists = true;
    return true;
  }
  if (errno == ENOENT) {
    if (exists) *exists = false;
    return true;
  }
  return false;
}

bool ValidDisposableTestIdentity(const std::string& bundle_identifier,
                                 const std::string& bundle_path) {
  if (bundle_identifier != "com.kestrel.desktop.dev" &&
      bundle_identifier != "com.kestrel.native-chromium-host.dev") {
    return false;
  }
  if (bundle_path.empty() || bundle_path == "/Applications/Kestrel.app" ||
      bundle_path.rfind("/Applications/Kestrel.app/", 0) == 0) {
    return false;
  }
  return true;
}

bool IsOwnedPrivateTemporaryProfile(const std::string& canonical_profile) {
  std::array<char, PATH_MAX> temporary{};
  std::array<char, PATH_MAX> canonical_temporary{};
  if (confstr(_CS_DARWIN_USER_TEMP_DIR, temporary.data(), temporary.size()) == 0 ||
      !realpath(temporary.data(), canonical_temporary.data())) {
    return false;
  }
  const std::string prefix = std::string(canonical_temporary.data()) + "/";
  if (canonical_profile.rfind(prefix, 0) != 0) return false;
  const std::string marker_path = canonical_profile + "/.kestrel-native-test-profile-v1";
  const int marker_fd = open(marker_path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (marker_fd < 0) return false;
  struct stat marker_info {};
  std::array<char, 32> marker{};
  const ssize_t count = read(marker_fd, marker.data(), marker.size());
  const bool stat_ok = fstat(marker_fd, &marker_info) == 0;
  close(marker_fd);
  return stat_ok &&
      S_ISREG(marker_info.st_mode) && marker_info.st_uid == getuid() &&
      marker_info.st_nlink == 1 && (marker_info.st_mode & 0777) == 0600 &&
      marker_info.st_size == 23 && count == 23 &&
      std::memcmp(marker.data(), "native-test-profile-v1\n", 23) == 0;
}

bool ReadOrCreateDisposableTestKey(const std::string& path,
                                   bool core_root_exists,
                                   std::vector<unsigned char>* key,
                                   std::string* error) {
  if (!key) return false;
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd >= 0) {
    struct stat info {};
    std::array<unsigned char, kCoreKeyBytes> bytes{};
    const ssize_t count = read(fd, bytes.data(), bytes.size());
    unsigned char extra = 0;
    const ssize_t extra_count = read(fd, &extra, 1);
    const bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_uid == getuid() && info.st_nlink == 1 &&
        (info.st_mode & 0777) == 0600 && info.st_size == kCoreKeyBytes &&
        count == static_cast<ssize_t>(bytes.size()) && extra_count == 0;
    close(fd);
    if (!valid) {
      std::fill(bytes.begin(), bytes.end(), 0);
      if (error) *error = "Disposable Native Core test key is malformed; profile data was preserved.";
      return false;
    }
    key->assign(bytes.begin(), bytes.end());
    std::fill(bytes.begin(), bytes.end(), 0);
    return true;
  }
  if (errno != ENOENT) {
    if (error) *error = "Disposable Native Core test key is unavailable.";
    return false;
  }
  if (core_root_exists) {
    if (error) *error = "Disposable Native Core data exists without its test key; profile data was preserved.";
    return false;
  }
  std::array<unsigned char, kCoreKeyBytes> generated{};
  if (CCRandomGenerateBytes(generated.data(), generated.size()) != kCCSuccess) {
    if (error) *error = "Could not create the disposable Native Core test key.";
    return false;
  }
  fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    std::fill(generated.begin(), generated.end(), 0);
    if (error) *error = "Could not safely create the disposable Native Core test key.";
    return false;
  }
  const ssize_t written = write(fd, generated.data(), generated.size());
  const bool saved = fchmod(fd, 0600) == 0 &&
      written == static_cast<ssize_t>(generated.size()) && fsync(fd) == 0;
  struct stat info {};
  const bool secure = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
      info.st_uid == getuid() && info.st_nlink == 1 &&
      (info.st_mode & 0777) == 0600 && info.st_size == kCoreKeyBytes;
  close(fd);
  const size_t parent_separator = path.rfind('/');
  const std::string parent = parent_separator == std::string::npos
      ? std::string(".") : path.substr(0, parent_separator);
  const int parent_fd = open(parent.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  const bool directory_saved = parent_fd >= 0 && fsync(parent_fd) == 0;
  if (parent_fd >= 0) close(parent_fd);
  if (!saved || !secure || !directory_saved) {
    std::fill(generated.begin(), generated.end(), 0);
    if (error) *error = "Could not safely persist the disposable Native Core test key.";
    return false;
  }
  key->assign(generated.begin(), generated.end());
  std::fill(generated.begin(), generated.end(), 0);
  return true;
}

bool ValidRegularFile(const std::string& path, bool require_private,
                      bool* exists) {
  struct stat info {};
  if (lstat(path.c_str(), &info) == 0) {
    if (exists) *exists = true;
    return S_ISREG(info.st_mode) && info.st_uid == getuid() &&
           info.st_nlink == 1 &&
           (!require_private || (info.st_mode & 0077) == 0);
  }
  if (errno == ENOENT) {
    if (exists) *exists = false;
    return true;
  }
  return false;
}

std::string Base64(const std::vector<unsigned char>& input) {
  std::string output;
  output.reserve(((input.size() + 2) / 3) * 4);
  for (size_t index = 0; index < input.size(); index += 3) {
    const uint32_t first = input[index];
    const uint32_t second = index + 1 < input.size() ? input[index + 1] : 0;
    const uint32_t third = index + 2 < input.size() ? input[index + 2] : 0;
    const uint32_t combined = (first << 16) | (second << 8) | third;
    output.push_back(kBase64Alphabet[(combined >> 18) & 0x3f]);
    output.push_back(kBase64Alphabet[(combined >> 12) & 0x3f]);
    output.push_back(index + 1 < input.size()
                         ? kBase64Alphabet[(combined >> 6) & 0x3f]
                         : '=');
    output.push_back(index + 2 < input.size()
                         ? kBase64Alphabet[combined & 0x3f]
                         : '=');
  }
  return output;
}

bool ProfileAccount(const std::string& input, std::string* canonical,
                    std::string* account, std::string* error) {
  if (input.empty() || input.front() != '/' || !canonical || !account) {
    if (error) *error = "Native Core requires an absolute private profile.";
    return false;
  }
  std::array<char, PATH_MAX> resolved{};
  if (!realpath(input.c_str(), resolved.data()) || input != resolved.data()) {
    if (error) *error = "Native Core profile path is not canonical.";
    return false;
  }
  bool profile_exists = false;
  if (!ValidPrivateDirectory(input, true, &profile_exists) || !profile_exists) {
    if (error) *error = "Native Core profile must be an owned private directory.";
    return false;
  }
  *canonical = input;
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  if (CC_SHA256(reinterpret_cast<const unsigned char*>(canonical->data()),
                static_cast<CC_LONG>(canonical->size()), digest.data()) ==
      nullptr) {
    if (error) *error = "Native Core could not identify its profile.";
    return false;
  }
  static constexpr char kHex[] = "0123456789abcdef";
  account->clear();
  account->reserve(digest.size() * 2);
  for (const unsigned char byte : digest) {
    account->push_back(kHex[byte >> 4]);
    account->push_back(kHex[byte & 0x0f]);
  }
  return true;
}

}  // namespace

NativeCoreProfileKeyStore::NativeCoreProfileKeyStore(
    std::shared_ptr<NativeCoreKeychainBackend> backend)
    : backend_(backend ? std::move(backend)
                       : std::make_shared<SecurityFrameworkKeychain>()) {}

bool NativeCoreProfileKeyStore::GetOrCreate(
    const std::string& profile_root, std::string* key_base64,
    std::string* error) {
  if (!key_base64 || !backend_) {
    if (error) *error = "Native Core Keychain is unavailable.";
    return false;
  }
  std::string canonical;
  std::string account;
  if (!ProfileAccount(profile_root, &canonical, &account, error)) return false;

  const std::string core_root = canonical + "/native-core";
  bool core_root_exists = false;
  if (!ValidPrivateDirectory(core_root, false, &core_root_exists)) {
    if (error) *error = "Native Core profile path is linked, malformed, or not private.";
    return false;
  }
  const std::string database_root = core_root + "/database";
  bool database_root_exists = false;
  if (core_root_exists &&
      !ValidPrivateDirectory(database_root, false, &database_root_exists)) {
    if (error) *error = "Native Core database directory is linked, malformed, or not private.";
    return false;
  }
  if (database_root_exists) {
    for (const std::string& suffix : {"/kestrel.sqlite", "/kestrel.sqlite-wal",
                                      "/kestrel.sqlite-shm"}) {
      bool exists = false;
      if (!ValidRegularFile(database_root + suffix, false, &exists)) {
        if (error) *error = "Native Core database path is linked, malformed, or not private.";
        return false;
      }
    }
  }
  if (core_root_exists) {
    for (const std::string& suffix : {"/secure", "/secure/credentials"}) {
      bool exists = false;
      if (!ValidPrivateDirectory(core_root + suffix, false, &exists)) {
        if (error) *error = "Native Core credential directory is linked, malformed, or not private.";
        return false;
      }
    }
    for (const std::string& suffix : {"/provider-accounts.json",
                                      "/native-runtime-preferences.json"}) {
      bool exists = false;
      if (!ValidRegularFile(core_root + suffix, true, &exists)) {
        if (error) *error = "Native Core provider data path is linked, malformed, or not private.";
        return false;
      }
    }
  }
  const std::string file_key = core_root + "/database.key";
  bool legacy_key_exists = false;
  if (!PathExistsWithoutFollowingLinks(file_key, &legacy_key_exists)) {
    if (error) *error = "Native Core legacy key path is unavailable.";
    return false;
  }
  if (legacy_key_exists) {
    if (error) *error = "Native Core profile uses a file-backed key; explicit migration is required.";
    return false;
  }
  bool test_key_exists = false;
  if (!PathExistsWithoutFollowingLinks(
          canonical + "/.kestrel-native-test-core-key-v1", &test_key_exists) ||
      test_key_exists) {
    if (error) *error = "Native Core test-key profile cannot be opened by the production Keychain path.";
    return false;
  }

  std::vector<unsigned char> key;
  NativeCoreKeychainResult result = backend_->Read(account, &key);
  if (result == NativeCoreKeychainResult::Success) {
    if (key.size() != kCoreKeyBytes) {
      std::fill(key.begin(), key.end(), 0);
      if (error) *error = "Native Core Keychain key is malformed; profile data was preserved.";
      return false;
    }
    *key_base64 = Base64(key);
    std::fill(key.begin(), key.end(), 0);
    return true;
  }
  if (result != NativeCoreKeychainResult::NotFound) {
    if (error) *error = "Native Core Keychain could not unlock the profile key.";
    return false;
  }

  if (core_root_exists) {
    if (error) *error = "Native Core data exists without its Keychain key; restore the key or explicitly migrate the profile.";
    return false;
  }

  key.resize(kCoreKeyBytes);
  if (CCRandomGenerateBytes(key.data(), key.size()) != kCCSuccess) {
    std::fill(key.begin(), key.end(), 0);
    if (error) *error = "Native Core could not create a protected profile key.";
    return false;
  }
  std::vector<unsigned char> generated_key = key;
  const NativeCoreKeychainResult add_result = backend_->Add(account, key);
  std::fill(key.begin(), key.end(), 0);
  result = add_result == NativeCoreKeychainResult::Success ||
                   add_result == NativeCoreKeychainResult::Duplicate
               ? backend_->Read(account, &key)
               : add_result;
  if (result != NativeCoreKeychainResult::Success || key.size() != kCoreKeyBytes) {
    std::fill(key.begin(), key.end(), 0);
    std::fill(generated_key.begin(), generated_key.end(), 0);
    if (error) *error = "Native Core could not save or verify its Keychain key.";
    return false;
  }
  if (add_result == NativeCoreKeychainResult::Success && key != generated_key) {
    std::fill(key.begin(), key.end(), 0);
    std::fill(generated_key.begin(), generated_key.end(), 0);
    if (error) *error = "Native Core Keychain key did not match the saved key.";
    return false;
  }
  // For a concurrent add, the Keychain item is already the stable profile key.
  // This profile is still empty, so adopting it cannot rotate existing data.
  *key_base64 = Base64(key);
  std::fill(key.begin(), key.end(), 0);
  std::fill(generated_key.begin(), generated_key.end(), 0);
  return true;
}

bool NativeCoreProfileKeyStore::GetOrCreateDisposableTestKey(
    const std::string& profile_root,
    const std::string& bundle_identifier,
    const std::string& bundle_path,
    std::string* key_base64,
    std::string* error) {
  if (!key_base64 || !ValidDisposableTestIdentity(bundle_identifier, bundle_path)) {
    if (error) *error = "Disposable Native Core test keys require a development app identity.";
    return false;
  }
  std::string canonical;
  std::string unused_account;
  if (!ProfileAccount(profile_root, &canonical, &unused_account, error) ||
      !IsOwnedPrivateTemporaryProfile(canonical)) {
    if (error) *error = "Disposable Native Core test keys require a marked private temporary profile.";
    return false;
  }
  const std::string core_root = canonical + "/native-core";
  bool core_root_exists = false;
  if (!ValidPrivateDirectory(core_root, false, &core_root_exists)) {
    if (error) *error = "Native Core test profile path is linked, malformed, or not private.";
    return false;
  }
  const std::string database_root = core_root + "/database";
  bool database_root_exists = false;
  if (core_root_exists &&
      !ValidPrivateDirectory(database_root, false, &database_root_exists)) {
    if (error) *error = "Native Core test database directory is linked, malformed, or not private.";
    return false;
  }
  if (database_root_exists) {
    for (const std::string& suffix : {"/kestrel.sqlite", "/kestrel.sqlite-wal",
                                      "/kestrel.sqlite-shm"}) {
      bool exists = false;
      if (!ValidRegularFile(database_root + suffix, false, &exists)) {
        if (error) *error = "Native Core test database path is linked or malformed.";
        return false;
      }
    }
  }
  if (core_root_exists) {
    for (const std::string& suffix : {"/secure", "/secure/credentials"}) {
      bool exists = false;
      if (!ValidPrivateDirectory(core_root + suffix, false, &exists)) {
        if (error) *error = "Native Core test credential directory is linked or malformed.";
        return false;
      }
    }
    for (const std::string& suffix : {"/provider-accounts.json",
                                      "/native-runtime-preferences.json"}) {
      bool exists = false;
      if (!ValidRegularFile(core_root + suffix, true, &exists)) {
        if (error) *error = "Native Core test provider path is linked or malformed.";
        return false;
      }
    }
  }
  bool legacy_key_exists = false;
  if (!PathExistsWithoutFollowingLinks(core_root + "/database.key", &legacy_key_exists) ||
      legacy_key_exists) {
    if (error) *error = "Legacy file-key profile requires explicit migration; test key was not used.";
    return false;
  }
  std::vector<unsigned char> key;
  if (!ReadOrCreateDisposableTestKey(
          canonical + "/.kestrel-native-test-core-key-v1", core_root_exists,
          &key, error)) {
    return false;
  }
  *key_base64 = Base64(key);
  std::fill(key.begin(), key.end(), 0);
  return true;
}
