#include "kestrel_local_vault.h"
#include "kestrel_local_vault_crypto.h"
#include "kestrel_local_vault_crypto_process.h"

#include <CommonCrypto/CommonRandom.h>
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
constexpr char kFile[] = ".kestrel-local-vault-v1";
constexpr size_t kKeyBytes = 32;
constexpr size_t kMaxEnvelope = 16384;
void Clear(std::vector<unsigned char>* bytes) {
  if (!bytes) return;
  volatile unsigned char* data = bytes->data();
  for (size_t n = bytes->size(); n; --n) *data++ = 0;
  bytes->clear();
}
struct Secret {
  std::vector<unsigned char> bytes;
  ~Secret() { Clear(&bytes); }
};
struct File {
  int fd;
  explicit File(int value) : fd(value) {}
  ~File() { if (fd >= 0) close(fd); }
};
bool PrivateDirectory(const struct stat& value) {
  return S_ISDIR(value.st_mode) && value.st_uid == getuid() &&
         (value.st_mode & 0077) == 0;
}
bool PrivateFile(const struct stat& value) {
  return S_ISREG(value.st_mode) && value.st_uid == getuid() &&
         value.st_nlink == 1 && (value.st_mode & 0777) == 0600 &&
         value.st_size > 0 && value.st_size <= static_cast<off_t>(kMaxEnvelope);
}
bool SameFile(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}
bool StillProfile(int fd, const std::string& path) {
  struct stat held {}, current {};
  return fstat(fd, &held) == 0 && lstat(path.c_str(), &current) == 0 &&
         PrivateDirectory(held) && PrivateDirectory(current) && SameFile(held, current);
}
bool FreshProfile(int parent) {
  const int copy = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (copy < 0) return false;
  DIR* directory = fdopendir(copy);
  if (!directory) { close(copy); return false; }
  bool fresh = true;
  errno = 0;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    const char* marker = nullptr;
    if (name == ".kestrel-native-default-v1") marker = "kestrel-native-v1\n";
    else if (name == ".kestrel-native-test-profile-v1") marker = "native-test-profile-v1\n";
    else if (name != ".kestrel-desktop.lock") { fresh = false; break; }
    File file(openat(parent, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
    struct stat info {}; std::array<char, 64> bytes {};
    const ssize_t count = file.fd >= 0 ? read(file.fd, bytes.data(), bytes.size()) : -1;
    const size_t expected = marker ? strlen(marker) : 0;
    if (file.fd < 0 || fstat(file.fd, &info) != 0 || !S_ISREG(info.st_mode) ||
        info.st_uid != getuid() || info.st_nlink != 1 || (info.st_mode & 0777) != 0600 ||
        info.st_size != static_cast<off_t>(expected) || count != static_cast<ssize_t>(expected) ||
        (marker && memcmp(bytes.data(), marker, expected) != 0)) { fresh = false; break; }
    errno = 0;
  }
  if (errno != 0) fresh = false;
  closedir(directory);
  return fresh;
}
enum class ReadResult { Found, Missing, Invalid };
ReadResult ReadEnvelope(int parent, std::vector<unsigned char>* result) {
  File file(openat(parent, kFile, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
  if (file.fd < 0) return errno == ENOENT ? ReadResult::Missing : ReadResult::Invalid;
  struct stat before {}, after {}, current {};
  if (fstat(file.fd, &before) != 0 || !PrivateFile(before)) return ReadResult::Invalid;
  result->resize(static_cast<size_t>(before.st_size));
  size_t count = 0;
  while (count < result->size()) {
    ssize_t n = read(file.fd, result->data() + count, result->size() - count);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return ReadResult::Invalid;
    count += static_cast<size_t>(n);
  }
  unsigned char extra = 0;
  ssize_t n;
  do { n = read(file.fd, &extra, 1); } while (n < 0 && errno == EINTR);
  if (n != 0 || fstat(file.fd, &after) != 0 || !PrivateFile(after) ||
      before.st_size != after.st_size ||
      fstatat(parent, kFile, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !PrivateFile(current) || !SameFile(after, current)) return ReadResult::Invalid;
  return ReadResult::Found;
}
bool PublishEnvelope(int parent, const std::vector<unsigned char>& envelope) {
  std::array<unsigned char, 16> random {};
  if (envelope.empty() || envelope.size() > kMaxEnvelope ||
      CCRandomGenerateBytes(random.data(), random.size()) != kCCSuccess) return false;
  constexpr char hex[] = "0123456789abcdef";
  std::string temporary = std::string(kFile) + ".pending-";
  for (unsigned char byte : random) {
    temporary += hex[byte >> 4]; temporary += hex[byte & 15];
  }
  File file(openat(parent, temporary.c_str(),
                   O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (file.fd < 0) return false;
  bool saved = fchmod(file.fd, 0600) == 0;
  size_t count = 0;
  while (saved && count < envelope.size()) {
    ssize_t n = write(file.fd, envelope.data() + count, envelope.size() - count);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { saved = false; break; }
    count += static_cast<size_t>(n);
  }
  struct stat info {};
  saved = saved && fsync(file.fd) == 0 && fstat(file.fd, &info) == 0 &&
          PrivateFile(info) && info.st_size == static_cast<off_t>(envelope.size());
  if (!saved) { unlinkat(parent, temporary.c_str(), 0); return false; }
  // RENAME_EXCL never overwrites a concurrent creator. Always reopen the
  // winner and authenticate it before returning any key.
  const int renamed = renameatx_np(parent, temporary.c_str(), parent, kFile, RENAME_EXCL);
  const int rename_error = errno;
  if (renamed != 0) {
    if (unlinkat(parent, temporary.c_str(), 0) != 0) return false;
    if (rename_error != EEXIST) return false;
  }
  return fsync(parent) == 0;
}

class SecureEnclaveCrypto final : public NativeLocalVaultCrypto {
 public:
  bool Seal(const std::string& context, const std::vector<unsigned char>& master,
            std::vector<unsigned char>* envelope) override {
    return NativeVaultSealIsolated(
        std::vector<unsigned char>(context.begin(), context.end()), master, envelope);
  }
  bool Open(const std::string& context, const std::vector<unsigned char>& envelope,
            std::vector<unsigned char>* master) override {
    return NativeVaultOpenIsolated(
        std::vector<unsigned char>(context.begin(), context.end()), envelope, master);
  }
  bool Derive(const std::string& context, const std::vector<unsigned char>& master,
              const std::string& purpose, std::vector<unsigned char>* key) override {
    key->resize(kKeyBytes); size_t length = 0;
    const int status = kestrel_vault_derive(
        reinterpret_cast<const unsigned char*>(context.data()), context.size(),
        master.data(), master.size(), reinterpret_cast<const unsigned char*>(purpose.data()),
        purpose.size(), key->data(), key->size(), &length);
    if (status != KESTREL_VAULT_OK || length != kKeyBytes) { Clear(key); return false; }
    return true;
  }
};
}  // namespace

NativeLocalVault::NativeLocalVault(std::shared_ptr<NativeLocalVaultCrypto> crypto)
    : crypto_(crypto ? std::move(crypto) : std::make_shared<SecureEnclaveCrypto>()) {}

bool NativeLocalVault::GetKey(const std::string& profile, const std::string& purpose,
                              bool allow_create, std::vector<unsigned char>* key,
                              std::string* error) {
  Clear(key);
  auto fail = [&](const char* message) { if (error) *error = message; Clear(key); return false; };
  if (!key || profile.empty() || profile.front() != '/' || profile.size() > 4000 ||
      (purpose != "native-core-database/v1" && purpose != "chromium-oscrypt/v1"))
    return fail("Local vault requires a canonical private profile and a supported key purpose.");
  std::array<char, PATH_MAX> canonical {};
  if (!realpath(profile.c_str(), canonical.data()) || profile != canonical.data())
    return fail("Local vault profile path is not canonical; data was preserved.");
  File parent(open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (parent.fd < 0 || !StillProfile(parent.fd, profile))
    return fail("Local vault profile is unavailable or not private; data was preserved.");
  const std::string context = "com.kestrel.local-vault.profile.v1:" + profile;
  std::vector<unsigned char> envelope;
  ReadResult state = ReadEnvelope(parent.fd, &envelope);
  if (state == ReadResult::Missing && allow_create) {
    if (!FreshProfile(parent.fd))
      return fail("An existing profile has no local vault. Explicit migration or recovery is required; data was preserved.");
    // An interrupted creation is never repaired by implicitly replacing a key.
    // A successful publish is authenticated again through the read path below.
    Secret generated; generated.bytes.resize(kKeyBytes);
    if (CCRandomGenerateBytes(generated.bytes.data(), generated.bytes.size()) != kCCSuccess ||
        !crypto_->Seal(context, generated.bytes, &envelope) ||
        !StillProfile(parent.fd, profile) || !FreshProfile(parent.fd) ||
        !PublishEnvelope(parent.fd, envelope))
      return fail("Local vault could not be securely created; data was preserved.");
    state = ReadEnvelope(parent.fd, &envelope);
  }
  if (state != ReadResult::Found)
    return fail("Local vault is missing or invalid. Existing data requires explicit migration or recovery.");
  Secret master;
  if (!crypto_->Open(context, envelope, &master.bytes) || master.bytes.size() != kKeyBytes ||
      !crypto_->Derive(context, master.bytes, purpose, key) || key->size() != kKeyBytes ||
      !StillProfile(parent.fd, profile))
    return fail("Local vault cannot unlock on this Mac; data was preserved.");
  if (error) error->clear();
  return true;
}
