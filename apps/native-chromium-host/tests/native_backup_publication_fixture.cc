#include "kestrel_backup_publication.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {
constexpr char kNonce[] = "0123456789abcdef01234567";
constexpr char kFixtureBytes[] = "generated-private-publication-fixture";

int FailSync(int) {
  errno = EIO;
  return -1;
}

bool MakeDirectory(const std::string& path, mode_t mode = 0700) {
  return mkdir(path.c_str(), mode) == 0;
}

bool WriteFile(const std::string& path, const char* contents) {
  const int fd = open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
  if (fd < 0) return false;
  size_t offset = 0;
  const size_t size = strlen(contents);
  while (offset < size) {
    const ssize_t count = write(fd, contents + offset, size - offset);
    if (count <= 0) {
      close(fd);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return close(fd) == 0;
}

const char* ResultName(kestrel::BackupPublication result) {
  using kestrel::BackupPublication;
  switch (result) {
    case BackupPublication::kPublished: return "published";
    case BackupPublication::kInvalid: return "invalid";
    case BackupPublication::kChanged: return "changed";
    case BackupPublication::kExists: return "exists";
    case BackupPublication::kFailed: return "failed";
    case BackupPublication::kCommittedSyncUncertain: return "committedSyncUncertain";
  }
  return "unknown";
}

bool ReadFixture(const std::string& path) {
  const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return false;
  char bytes[sizeof(kFixtureBytes)] = {};
  const ssize_t count = read(fd, bytes, sizeof(bytes));
  close(fd);
  return count == static_cast<ssize_t>(sizeof(kFixtureBytes) - 1) &&
         memcmp(bytes, kFixtureBytes, sizeof(kFixtureBytes) - 1) == 0;
}

bool ReadText(const std::string& path, const char* expected) {
	const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	if (fd < 0) return false;
	char bytes[128] = {};
	const ssize_t count = read(fd, bytes, sizeof(bytes));
	close(fd);
	return count == static_cast<ssize_t>(strlen(expected)) && memcmp(bytes, expected, strlen(expected)) == 0;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) return 2;
  const std::string root(argv[1]);
  const std::string scenario(argv[2]);
  if (root.empty() || root.size() > 3000 || root[0] != '/' || scenario.size() > 40) return 2;
  struct stat root_info{};
  if (lstat(root.c_str(), &root_info) != 0 || !S_ISDIR(root_info.st_mode) ||
      root_info.st_uid != geteuid() || (root_info.st_mode & 0077) != 0) return 3;

  const std::string parent = root + "/parent";
  const std::string outside = root + "/outside";
  if (!MakeDirectory(parent) || !MakeDirectory(outside)) return 4;
  const std::string nonce(kNonce);
  const std::string stage_name = ".kestrel-native-core-" + nonce + ".partial";
  std::string final_name = "Kestrel-Native-Core-fixture-" + nonce;
  if (scenario == "forged-nonce") final_name.back() = final_name.back() == '0' ? '1' : '0';
  const std::string staging = parent + "/" + stage_name;
  const std::string final_path = (scenario == "forged-path" ? outside : parent) + "/" + final_name;
  if (!MakeDirectory(staging) || !WriteFile(staging + "/fixture.txt", kFixtureBytes)) return 5;

  std::string displaced;
  struct stat parent_info{}, stage_info{};
  if (stat(parent.c_str(), &parent_info) != 0 || stat(staging.c_str(), &stage_info) != 0) return 6;
	const uint64_t captured_stage_dev = static_cast<uint64_t>(stage_info.st_dev);
	const uint64_t captured_stage_ino = static_cast<uint64_t>(stage_info.st_ino);
  if (scenario == "existing-empty" && !MakeDirectory(final_path)) return 7;
  if (scenario == "existing-nonempty") {
    if (!MakeDirectory(final_path) || !WriteFile(final_path + "/keep.txt", "preexisting-content")) return 8;
  }
  if (scenario == "staging-symlink") {
    displaced = parent + "/staging-held-for-fixture";
    if (rename(staging.c_str(), displaced.c_str()) != 0 || symlink(displaced.c_str(), staging.c_str()) != 0) return 9;
  }
  if (scenario == "staging-mode" && chmod(staging.c_str(), 0755) != 0) return 10;

  kestrel::BackupDirectoryIdentity expected{
      static_cast<uint64_t>(parent_info.st_dev), static_cast<uint64_t>(parent_info.st_ino),
      static_cast<uint64_t>(stage_info.st_dev), static_cast<uint64_t>(stage_info.st_ino)};
  if (scenario == "parent-identity") ++expected.parent_ino;
  if (scenario == "staging-identity") ++expected.staging_ino;
  int (*sync_hook)(int) = scenario == "sync-failure" ? &FailSync : nullptr;
  const auto result = kestrel::PublishBackupDirectory(staging, final_path, expected, sync_hook);

  struct stat final_info{};
  const bool final_exists = lstat(final_path.c_str(), &final_info) == 0;
  const bool final_is_real_directory = final_exists && S_ISDIR(final_info.st_mode);
  const bool fixture_preserved = final_is_real_directory && ReadFixture(final_path + "/fixture.txt");
	const bool identity_preserved = final_is_real_directory && final_info.st_uid == geteuid() &&
		static_cast<uint64_t>(final_info.st_dev) == captured_stage_dev &&
		static_cast<uint64_t>(final_info.st_ino) == captured_stage_ino;
  bool existing_content_preserved = false;
	if (scenario == "existing-nonempty") existing_content_preserved = ReadText(final_path + "/keep.txt", "preexisting-content");
  if (scenario == "existing-empty") existing_content_preserved = final_is_real_directory && !fixture_preserved;
  const bool stage_exists = lstat(staging.c_str(), &stage_info) == 0;
	printf("{\"result\":\"%s\",\"finalExists\":%s,\"fixturePreserved\":%s,\"identityPreserved\":%s,\"stageExists\":%s,\"existingContentPreserved\":%s}\n",
         ResultName(result), final_exists ? "true" : "false", fixture_preserved ? "true" : "false",
	       identity_preserved ? "true" : "false", stage_exists ? "true" : "false", existing_content_preserved ? "true" : "false");
  return 0;
}
