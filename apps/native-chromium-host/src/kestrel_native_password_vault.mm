#import <Foundation/Foundation.h>

#include "kestrel_native_password_vault.h"

#include <CommonCrypto/CommonCryptor.h>
#include <CommonCrypto/CommonRandom.h>

#include <cstdio>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <sstream>

namespace {

constexpr char kSealedPrefix[] = "kestrel-native-password-vault-v1\n";
constexpr size_t kMasterKeyBytes = 32;
constexpr size_t kIvBytes = kCCBlockSizeAES128;
constexpr size_t kMaxEntries = 2'000;

bool ensure_directory(const std::string& path) {
  NSString* ns_path = [NSString stringWithUTF8String:path.c_str()];
  NSError* error = nil;
  return [[NSFileManager defaultManager]
             createDirectoryAtPath:ns_path
       withIntermediateDirectories:YES
                        attributes:@{NSFilePosixPermissions : @0700}
                             error:&error] == YES;
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
  if (fsync(fd) != 0 || chmod(temporary.c_str(), 0600) != 0) {
    close(fd);
    unlink(temporary.c_str());
    return false;
  }
  close(fd);
  if (rename(temporary.c_str(), path.c_str()) != 0) {
    unlink(temporary.c_str());
    return false;
  }
  return true;
}

std::optional<std::string> read_bytes(const std::string& path) {
  NSData* data = [NSData dataWithContentsOfFile:@(path.c_str())];
  if (!data) return std::nullopt;
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

std::string random_bytes(size_t count) {
  std::string out(count, '\0');
  if (CCRandomGenerateBytes(out.data(), count) != kCCSuccess) return {};
  return out;
}

std::optional<std::string> aes_encrypt(const std::string& key,
                                       const std::string& plaintext) {
  if (key.size() != kMasterKeyBytes) return std::nullopt;
  const std::string iv = random_bytes(kIvBytes);
  if (iv.size() != kIvBytes) return std::nullopt;
  std::string ciphertext(plaintext.size() + kCCBlockSizeAES128, '\0');
  size_t moved = 0;
  if (CCCrypt(kCCEncrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key.data(),
              key.size(), iv.data(), plaintext.data(), plaintext.size(),
              ciphertext.data(), ciphertext.size(), &moved) != kCCSuccess) {
    return std::nullopt;
  }
  ciphertext.resize(moved);
  return iv + ciphertext;
}

std::optional<std::string> aes_decrypt(const std::string& key,
                                       const std::string& payload) {
  if (key.size() != kMasterKeyBytes || payload.size() <= kIvBytes) {
    return std::nullopt;
  }
  const std::string iv = payload.substr(0, kIvBytes);
  const std::string ciphertext = payload.substr(kIvBytes);
  std::string plaintext(ciphertext.size() + kCCBlockSizeAES128, '\0');
  size_t moved = 0;
  if (CCCrypt(kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key.data(),
              key.size(), iv.data(), ciphertext.data(), ciphertext.size(),
              plaintext.data(), plaintext.size(), &moved) != kCCSuccess) {
    return std::nullopt;
  }
  plaintext.resize(moved);
  return plaintext;
}

std::string json_escape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
          out += buf;
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
  }
  return out;
}

}  // namespace

std::optional<std::string> OriginFromUrl(const std::string& url) {
  NSURL* parsed = [NSURL URLWithString:@(url.c_str())];
  if (!parsed || !parsed.scheme || !parsed.host) return std::nullopt;
  NSString* scheme = parsed.scheme.lowercaseString;
  if (![scheme isEqualToString:@"https"] && ![scheme isEqualToString:@"http"]) {
    return std::nullopt;
  }
  NSMutableString* origin =
      [NSMutableString stringWithFormat:@"%@://%@", scheme, parsed.host];
  if (parsed.port != nil) {
    const NSInteger port = parsed.port.integerValue;
    const bool default_https = [scheme isEqualToString:@"https"] && port == 443;
    const bool default_http = [scheme isEqualToString:@"http"] && port == 80;
    if (!default_https && !default_http) {
      [origin appendFormat:@":%@", parsed.port];
    }
  }
  return std::string(origin.UTF8String);
}

bool NativePasswordVault::Open(const std::string& isolated_profile_root,
                               std::string* error) {
  ready_ = false;
  master_key_.clear();
  if (isolated_profile_root.empty() || isolated_profile_root.front() != '/') {
    if (error) *error = "Password vault requires an absolute isolated profile.";
    return false;
  }
  root_ = isolated_profile_root + "/secure/passwords";
  vault_path_ = root_ + "/browser-password-vault.bin";
  if (!ensure_directory(root_)) {
    if (error) *error = "Kestrel could not create its password vault directory.";
    return false;
  }
  if (!EnsureMasterKey(error)) return false;
  ready_ = true;
  return true;
}

bool NativePasswordVault::EnsureReady(std::string* error) const {
  if (ready_) return true;
  if (error) *error = "Native password vault is unavailable.";
  return false;
}

bool NativePasswordVault::EnsureMasterKey(std::string* error) {
  const std::string key_path = root_ + ".master";
  if (const auto existing = read_bytes(key_path)) {
    if (existing->size() == kMasterKeyBytes) {
      master_key_ = *existing;
      return true;
    }
    if (error) *error = "Native password vault master key is corrupt.";
    return false;
  }
  master_key_ = random_bytes(kMasterKeyBytes);
  if (master_key_.size() != kMasterKeyBytes) {
    if (error) *error = "Kestrel could not create a password vault master key.";
    return false;
  }
  if (!write_bytes_0600(key_path, master_key_)) {
    if (error) *error = "Kestrel could not persist its password vault master key.";
    return false;
  }
  return true;
}

bool NativePasswordVault::LoadEntries(std::vector<NativePasswordEntry>* entries,
                                      std::string* error) const {
  entries->clear();
  if (!EnsureReady(error)) return false;
  const auto sealed = read_bytes(vault_path_);
  if (!sealed) return true;
  if (sealed->rfind(kSealedPrefix, 0) != 0) {
    if (error) *error = "Native password vault is corrupt.";
    return false;
  }
  const auto plaintext =
      aes_decrypt(master_key_, sealed->substr(std::strlen(kSealedPrefix)));
  if (!plaintext) {
    if (error) *error = "Kestrel could not open the password vault.";
    return false;
  }
  NSData* data = [NSData dataWithBytes:plaintext->data()
                                length:plaintext->size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data
                                              options:0
                                                error:&json_error];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    if (error) *error = "Native password vault JSON is invalid.";
    return false;
  }
  NSArray* list = parsed[@"entries"];
  if (![list isKindOfClass:[NSArray class]]) return true;
  for (id item in list) {
    if (![item isKindOfClass:[NSDictionary class]]) continue;
    NSString* entry_id = item[@"id"];
    NSString* origin = item[@"origin"];
    NSString* username = item[@"username"];
    NSString* password = item[@"password"];
    if (![entry_id isKindOfClass:[NSString class]] ||
        ![origin isKindOfClass:[NSString class]] ||
        ![username isKindOfClass:[NSString class]] ||
        ![password isKindOfClass:[NSString class]]) {
      continue;
    }
    NativePasswordEntry entry;
    entry.id = entry_id.UTF8String;
    entry.origin = origin.UTF8String;
    entry.username = username.UTF8String;
    entry.password = password.UTF8String;
    entries->push_back(std::move(entry));
    if (entries->size() >= kMaxEntries) break;
  }
  return true;
}

bool NativePasswordVault::WriteEntries(
    const std::vector<NativePasswordEntry>& entries, std::string* error) const {
  if (!EnsureReady(error)) return false;
  std::ostringstream json;
  json << "{\"version\":1,\"entries\":[";
  for (size_t index = 0; index < entries.size(); ++index) {
    if (index > 0) json << ',';
    const auto& entry = entries[index];
    json << "{\"id\":\"" << json_escape(entry.id) << "\",\"origin\":\""
         << json_escape(entry.origin) << "\",\"username\":\""
         << json_escape(entry.username) << "\",\"password\":\""
         << json_escape(entry.password) << "\"}";
  }
  json << "]}";
  const auto encrypted = aes_encrypt(master_key_, json.str());
  if (!encrypted) {
    if (error) *error = "Kestrel could not seal the password vault.";
    return false;
  }
  if (!write_bytes_0600(vault_path_, std::string(kSealedPrefix) + *encrypted)) {
    if (error) *error = "Kestrel could not persist the password vault.";
    return false;
  }
  return true;
}

std::vector<NativePasswordEntry> NativePasswordVault::ListForOrigin(
    const std::string& origin) const {
  std::vector<NativePasswordEntry> all;
  std::string error;
  if (!LoadEntries(&all, &error)) return {};
  std::vector<NativePasswordEntry> matched;
  for (auto& entry : all) {
    if (entry.origin == origin) matched.push_back(std::move(entry));
  }
  return matched;
}

bool NativePasswordVault::Save(const std::string& origin,
                               const std::string& username,
                               const std::string& password,
                               std::string* error) {
  if (!EnsureReady(error)) return false;
  if (origin.empty() || username.empty() || password.empty() ||
      password.size() > 4'096) {
    if (error) *error = "Password vault entry is invalid.";
    return false;
  }
  std::vector<NativePasswordEntry> entries;
  if (!LoadEntries(&entries, error)) return false;
  for (auto& entry : entries) {
    if (entry.origin == origin && entry.username == username) {
      entry.password = password;
      return WriteEntries(entries, error);
    }
  }
  if (entries.size() >= kMaxEntries) {
    if (error) *error = "Kestrel can store up to 2,000 saved passwords.";
    return false;
  }
  NativePasswordEntry entry;
  entry.id = std::string("password-") +
             [[[NSUUID UUID] UUIDString] UTF8String];
  entry.origin = origin;
  entry.username = username;
  entry.password = password;
  entries.push_back(std::move(entry));
  return WriteEntries(entries, error);
}
