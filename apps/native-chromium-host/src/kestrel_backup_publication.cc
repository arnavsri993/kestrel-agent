#include "kestrel_backup_publication.h"
#include <sys/stat.h>
#include <sys/stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>

namespace kestrel {
namespace {
struct Descriptor {
  int fd = -1;
  explicit Descriptor(int value) : fd(value) {}
  ~Descriptor() { if (fd >= 0) close(fd); }
};
bool SplitPath(const std::string& path, std::string* parent, std::string* name) {
  if (path.empty() || path[0] != '/' || path.size() > 4096 ||
      path.find('\0') != std::string::npos) return false;
  const auto slash = path.rfind('/');
  *parent = slash == 0 ? "/" : path.substr(0, slash);
  *name = path.substr(slash + 1);
  return !name->empty() && *name != "." && *name != "..";
}
bool Matches(const struct stat& info, uint64_t dev, uint64_t ino) {
  return S_ISDIR(info.st_mode) && info.st_uid == geteuid() &&
         static_cast<uint64_t>(info.st_dev) == dev &&
         static_cast<uint64_t>(info.st_ino) == ino;
}
bool Same(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino &&
         S_ISDIR(b.st_mode) && b.st_uid == geteuid();
}
}  // namespace

BackupPublication PublishBackupDirectory(
    const std::string& staging, const std::string& final_path,
    const BackupDirectoryIdentity& expected, int (*sync_directory)(int)) {
  std::string parent, stage_name, final_parent, final_name;
  if (!SplitPath(staging, &parent, &stage_name) ||
      !SplitPath(final_path, &final_parent, &final_name) || parent != final_parent)
    return BackupPublication::kInvalid;
  const std::string prefix = ".kestrel-native-core-";
  const std::string suffix = ".partial";
  if (stage_name.size() != prefix.size() + 24 + suffix.size() ||
      stage_name.compare(0, prefix.size(), prefix) != 0 ||
      stage_name.compare(stage_name.size() - suffix.size(), suffix.size(), suffix) != 0)
    return BackupPublication::kInvalid;
  const auto nonce = stage_name.substr(prefix.size(), 24);
  if (!std::all_of(nonce.begin(), nonce.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
      }) || final_name.size() > 150 ||
      final_name.rfind("Kestrel-Native-Core-", 0) != 0 ||
      final_name.size() < nonce.size() + 1 ||
      final_name.compare(final_name.size() - nonce.size() - 1, nonce.size() + 1, "-" + nonce) != 0)
    return BackupPublication::kInvalid;
  const Descriptor directory(open(parent.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (directory.fd < 0) return BackupPublication::kChanged;
  struct stat parent_info{}, stage_info{}, named{};
  if (fstat(directory.fd, &parent_info) != 0 ||
      !Matches(parent_info, expected.parent_dev, expected.parent_ino))
    return BackupPublication::kChanged;
  const Descriptor stage(openat(directory.fd, stage_name.c_str(),
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (stage.fd < 0 || fstat(stage.fd, &stage_info) != 0 ||
      !Matches(stage_info, expected.staging_dev, expected.staging_ino) ||
      (stage_info.st_mode & 07777) != 0700 ||
      fstatat(directory.fd, stage_name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !Same(stage_info, named))
    return BackupPublication::kChanged;
  if (renameatx_np(directory.fd, stage_name.c_str(), directory.fd,
                   final_name.c_str(), RENAME_EXCL) != 0)
    return errno == EEXIST || errno == ENOTEMPTY ? BackupPublication::kExists
                                               : BackupPublication::kFailed;
  // The commit has happened. Every subsequent error must preserve the backup
  // and be distinguishable from a failure that left only an owned partial.
  if (fstatat(directory.fd, final_name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !Same(stage_info, named))
    return BackupPublication::kCommittedSyncUncertain;
  int result;
  do { result = sync_directory ? sync_directory(directory.fd) : fsync(directory.fd); }
  while (result != 0 && errno == EINTR);
  return result == 0 ? BackupPublication::kPublished
                     : BackupPublication::kCommittedSyncUncertain;
}
}  // namespace kestrel
