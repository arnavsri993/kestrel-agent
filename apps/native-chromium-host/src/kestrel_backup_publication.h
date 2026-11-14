#ifndef KESTREL_BACKUP_PUBLICATION_H_
#define KESTREL_BACKUP_PUBLICATION_H_
#include <cstdint>
#include <string>

namespace kestrel {
struct BackupDirectoryIdentity {
  uint64_t parent_dev;
  uint64_t parent_ino;
  uint64_t staging_dev;
  uint64_t staging_ino;
};
enum class BackupPublication {
  kPublished, kInvalid, kChanged, kExists, kFailed, kCommittedSyncUncertain
};
// The caller has verified the copied data. Publication binds both directory
// identities and must never replace even an empty pre-existing target.
BackupPublication PublishBackupDirectory(
    const std::string& staging, const std::string& final_path,
    const BackupDirectoryIdentity& expected, int (*sync_directory)(int) = nullptr);
}  // namespace kestrel
#endif
