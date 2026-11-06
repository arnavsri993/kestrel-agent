#include "kestrel_legacy_core_key.h"

#include <CommonCrypto/CommonCryptor.h>
#include <CommonCrypto/CommonKeyDerivation.h>

#include <algorithm>
#include <string_view>

namespace {

constexpr std::string_view kWrapped = "kestrel-safestorage-v1\n";
constexpr std::string_view kDevelopment = "kestrel-plaintext-v1\n";
constexpr std::string_view kMacVersion = "v10";
constexpr std::string_view kAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
constexpr size_t kEncodedKeyBytes = 44;
constexpr size_t kCipherBytes = 48;
constexpr size_t kMaxPasswordBytes = 4096;
constexpr uint8_t kSalt[] = {'s', 'a', 'l', 't', 'y', 's', 'a', 'l', 't'};

void Clear(void* memory, size_t size) {
  volatile auto* bytes = static_cast<volatile uint8_t*>(memory);
  while (size--) *bytes++ = 0;
}

bool Starts(std::span<const uint8_t> input, std::string_view prefix) {
  return input.size() >= prefix.size() &&
      std::equal(prefix.begin(), prefix.end(), input.begin());
}

bool DecodeCanonicalKey(std::span<const uint8_t> text,
                        std::array<uint8_t, 32>* key) {
  if (!key || text.size() != kEncodedKeyBytes || text.back() != '=') return false;
  std::array<uint8_t, 43> sextets{};
  for (size_t i = 0; i < sextets.size(); ++i) {
    const size_t index = kAlphabet.find(static_cast<char>(text[i]));
    if (index == std::string_view::npos) {
      Clear(sextets.data(), sextets.size());
      return false;
    }
    sextets[i] = static_cast<uint8_t>(index);
  }
  // The final sextet's unused bits must be zero, matching the broker's
  // canonical base64 round trip rather than a permissive decoder.
  if ((sextets.back() & 3) != 0) {
    Clear(sextets.data(), sextets.size());
    return false;
  }
  for (size_t i = 0; i < 10; ++i) {
    (*key)[3 * i] = (sextets[4 * i] << 2) | (sextets[4 * i + 1] >> 4);
    (*key)[3 * i + 1] = (sextets[4 * i + 1] << 4) | (sextets[4 * i + 2] >> 2);
    (*key)[3 * i + 2] = (sextets[4 * i + 2] << 6) | sextets[4 * i + 3];
  }
  (*key)[30] = (sextets[40] << 2) | (sextets[41] >> 4);
  (*key)[31] = (sextets[41] << 4) | (sextets[42] >> 2);
  Clear(sextets.data(), sextets.size());
  return true;
}

}  // namespace

NativeLegacyCoreKeyFormat InspectLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope) {
  if (Starts(envelope, kDevelopment)) {
    return envelope.size() == kDevelopment.size() + kEncodedKeyBytes
        ? NativeLegacyCoreKeyFormat::DevelopmentPlaintext
        : NativeLegacyCoreKeyFormat::Unsupported;
  }
  if (Starts(envelope, kWrapped)) envelope = envelope.subspan(kWrapped.size());
  return Starts(envelope, kMacVersion) &&
      envelope.size() == kMacVersion.size() + kCipherBytes
      ? NativeLegacyCoreKeyFormat::MacSafeStorageV10
      : NativeLegacyCoreKeyFormat::Unsupported;
}

bool UnwrapLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope,
    std::span<const uint8_t> authorized_keychain_password,
    bool allow_development_plaintext,
    std::array<uint8_t, 32>* database_key,
    std::string* error) {
  if (database_key) Clear(database_key->data(), database_key->size());
  if (error) *error = "The legacy Kestrel database key could not be validated. Existing data was preserved.";
  if (!database_key) return false;
  const auto format = InspectLegacyKestrelCoreKey(envelope);
  std::array<uint8_t, 32> candidate{};
  bool valid = false;
  if (format == NativeLegacyCoreKeyFormat::DevelopmentPlaintext) {
    if (!allow_development_plaintext) return false;
    valid = DecodeCanonicalKey(envelope.subspan(kDevelopment.size()), &candidate);
  } else if (format == NativeLegacyCoreKeyFormat::MacSafeStorageV10) {
    if (authorized_keychain_password.empty() ||
        authorized_keychain_password.size() > kMaxPasswordBytes) return false;
    if (Starts(envelope, kWrapped)) envelope = envelope.subspan(kWrapped.size());
    std::array<uint8_t, 16> derived{};
    std::array<uint8_t, 16> iv{};
    iv.fill(' ');
    std::array<uint8_t, kCipherBytes> plaintext{};
    size_t written = 0;
    // Decryption-only compatibility with Chromium 150's macOS v10 format.
    const int derived_status = CCKeyDerivationPBKDF(
        kCCPBKDF2, reinterpret_cast<const char*>(authorized_keychain_password.data()),
        authorized_keychain_password.size(), kSalt, sizeof(kSalt),
        kCCPRFHmacAlgSHA1, 1003, derived.data(), derived.size());
    if (derived_status == kCCSuccess && CCCrypt(
        kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, derived.data(),
        derived.size(), iv.data(), envelope.data() + kMacVersion.size(),
        kCipherBytes, plaintext.data(), plaintext.size(), &written) == kCCSuccess &&
        written == kEncodedKeyBytes) {
      valid = DecodeCanonicalKey(std::span(plaintext).first(written), &candidate);
    }
    Clear(derived.data(), derived.size());
    Clear(plaintext.data(), plaintext.size());
  }
  if (valid) *database_key = candidate;
  Clear(candidate.data(), candidate.size());
  if (valid && error) error->clear();
  return valid;
}

bool UnlockLegacyKestrelCoreKey(
    std::span<const uint8_t> envelope,
    NativeLegacyKestrelKeychainReader& reader,
    NativeLegacyKeychainPromptPolicy policy,
    bool allow_development_plaintext,
    std::array<uint8_t, 32>* database_key,
    std::string* error) {
  if (database_key) Clear(database_key->data(), database_key->size());
  if (error) *error = "The legacy Kestrel database key could not be validated. Existing data was preserved.";
  if (!database_key) return false;
  const auto format = InspectLegacyKestrelCoreKey(envelope);
  if (format != NativeLegacyCoreKeyFormat::MacSafeStorageV10) {
    return UnwrapLegacyKestrelCoreKey(envelope, {}, allow_development_plaintext,
                                    database_key, error);
  }
  std::vector<uint8_t> password;
  NativeLegacyKeychainReadResult result;
  try {
    result = reader.ReadKestrelSafeStoragePassword(policy, &password);
  } catch (...) {
    Clear(password.data(), password.size());
    return false;
  }
  bool unlocked = false;
  if (result == NativeLegacyKeychainReadResult::Found) {
    unlocked = UnwrapLegacyKestrelCoreKey(envelope, password, false,
                                        database_key, error);
  }
  Clear(password.data(), password.size());
  return unlocked;
}
