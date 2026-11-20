#include "kestrel_profile_reservation.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>
#include <array>
#include <cerrno>
#include <utility>

namespace kestrel {
namespace {
bool PrivateDirectory(const struct stat& s) {
  return S_ISDIR(s.st_mode) && s.st_uid == geteuid() && (s.st_mode & 07777) == 0700;
}
bool PrivateLock(const struct stat& s) {
  return S_ISREG(s.st_mode) && s.st_uid == geteuid() && s.st_nlink == 1 &&
         (s.st_mode & 07777) == 0600 && s.st_size == 0;
}
bool Same(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}
std::string LockName(const std::string& path) {
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256(path.data(), static_cast<CC_LONG>(path.size()), digest.data());
  constexpr char hex[] = "0123456789abcdef";
  std::string name = ".kestrel-profile-";
  for (const auto c : digest) { name.push_back(hex[c >> 4]); name.push_back(hex[c & 15]); }
  return name + ".lock";
}
}

ProfileReservation::ProfileReservation(int parent_fd, int lock_fd,
    std::string parent, std::string lock_name, dev_t parent_dev,
    ino_t parent_ino, dev_t lock_dev, ino_t lock_ino)
    : parent_fd_(parent_fd), lock_fd_(lock_fd), parent_(std::move(parent)),
      lock_name_(std::move(lock_name)), parent_dev_(parent_dev), parent_ino_(parent_ino),
      lock_dev_(lock_dev), lock_ino_(lock_ino) {}
ProfileReservation::~ProfileReservation() { close(lock_fd_); close(parent_fd_); }

bool ProfileReservation::IsCurrent() const {
  struct stat parent{}, named_parent{}, lock{}, named_lock{};
  return fstat(parent_fd_, &parent) == 0 && lstat(parent_.c_str(), &named_parent) == 0 &&
      PrivateDirectory(parent) && PrivateDirectory(named_parent) && Same(parent, named_parent) &&
      parent.st_dev == parent_dev_ && parent.st_ino == parent_ino_ &&
      fstat(lock_fd_, &lock) == 0 && fstatat(parent_fd_, lock_name_.c_str(), &named_lock, AT_SYMLINK_NOFOLLOW) == 0 &&
      PrivateLock(lock) && PrivateLock(named_lock) && Same(lock, named_lock) &&
      lock.st_dev == lock_dev_ && lock.st_ino == lock_ino_;
}

std::unique_ptr<ProfileReservation> ProfileReservation::Acquire(
    const std::string& path, ProfileReservationError* error) {
  auto fail = [&](ProfileReservationError value) -> std::unique_ptr<ProfileReservation> {
    if (error) *error = value;
    return nullptr;
  };
  if (error) *error = ProfileReservationError::kNone;
  if (path.empty() || path.size() > 4096 || path.front() != '/' || path.back() == '/' ||
      path.find('\0') != std::string::npos) return fail(ProfileReservationError::kUnsafe);
  for (size_t i = 0; i < path.size(); ++i) {
    const auto c = static_cast<unsigned char>(path[i]);
    if (c < 32 || c == 127 || (c == 0xc2 && i + 1 < path.size() &&
        static_cast<unsigned char>(path[i + 1]) >= 0x80 && static_cast<unsigned char>(path[i + 1]) <= 0x9f))
      return fail(ProfileReservationError::kUnsafe);
  }
  std::array<char, PATH_MAX> canonical{};
  if (!realpath(path.c_str(), canonical.data()) || path != canonical.data()) return fail(ProfileReservationError::kUnsafe);
  const auto slash = path.rfind('/');
  if (slash == std::string::npos || slash == 0 || slash + 1 == path.size()) return fail(ProfileReservationError::kUnsafe);
  const std::string parent_path = path.substr(0, slash), child = path.substr(slash + 1);
  const int parent_fd = open(parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) return fail(ProfileReservationError::kUnsafe);
  auto close_parent = [&] { close(parent_fd); };
  struct stat parent{}, named_parent{}, root{}, named_root{};
  if (fstat(parent_fd, &parent) || lstat(parent_path.c_str(), &named_parent) ||
      !PrivateDirectory(parent) || !PrivateDirectory(named_parent) || !Same(parent, named_parent) ||
      fstatat(parent_fd, child.c_str(), &named_root, AT_SYMLINK_NOFOLLOW) || !PrivateDirectory(named_root)) {
    close_parent(); return fail(ProfileReservationError::kUnsafe);
  }
  const int root_fd = openat(parent_fd, child.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) { close_parent(); return fail(ProfileReservationError::kUnsafe); }
  const bool root_ok = fstat(root_fd, &root) == 0 && PrivateDirectory(root) && Same(root, named_root);
  close(root_fd);
  if (!root_ok) { close_parent(); return fail(ProfileReservationError::kUnsafe); }
  const std::string name = LockName(path);
  int lock_fd = openat(parent_fd, name.c_str(), O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
  if (lock_fd >= 0) {
    if (fchmod(lock_fd, 0600)) { close(lock_fd); close_parent(); return fail(ProfileReservationError::kFailed); }
  } else if (errno == EEXIST) {
    lock_fd = openat(parent_fd, name.c_str(), O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  }
  if (lock_fd < 0) { close_parent(); return fail(ProfileReservationError::kUnsafe); }
  struct stat lock{}, named_lock{}, root_after{};
  if (fstat(lock_fd, &lock) || fstatat(parent_fd, name.c_str(), &named_lock, AT_SYMLINK_NOFOLLOW) ||
      !PrivateLock(lock) || !PrivateLock(named_lock) || !Same(lock, named_lock) ||
      fstatat(parent_fd, child.c_str(), &root_after, AT_SYMLINK_NOFOLLOW) || !PrivateDirectory(root_after) || !Same(root, root_after)) {
    close(lock_fd); close_parent(); return fail(ProfileReservationError::kUnsafe);
  }
  if (flock(lock_fd, LOCK_EX | LOCK_NB)) {
    const auto result = errno == EWOULDBLOCK || errno == EAGAIN ? ProfileReservationError::kBusy : ProfileReservationError::kFailed;
    close(lock_fd); close_parent(); return fail(result);
  }
  auto reservation = std::unique_ptr<ProfileReservation>(new ProfileReservation(parent_fd, lock_fd, parent_path, name, parent.st_dev, parent.st_ino, lock.st_dev, lock.st_ino));
  if (!reservation->IsCurrent() || fstatat(parent_fd, child.c_str(), &root_after, AT_SYMLINK_NOFOLLOW) ||
      !PrivateDirectory(root_after) || !Same(root, root_after)) return fail(ProfileReservationError::kUnsafe);
  return reservation;
}
}  // namespace kestrel
