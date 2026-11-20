#include "kestrel_profile_reservation.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <array>
#include <string>
#include <cstring>
#include <iostream>

using kestrel::ProfileReservation;
using kestrel::ProfileReservationError;
std::string Name(const std::string& path) {
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256(path.data(), static_cast<CC_LONG>(path.size()), digest.data());
  constexpr char hex[] = "0123456789abcdef";
  std::string name = ".kestrel-profile-";
  for (const auto c : digest) { name.push_back(hex[c >> 4]); name.push_back(hex[c & 15]); }
  return name + ".lock";
}
bool File(const std::string& path, mode_t mode, const char* content = "") {
  int fd = open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, mode);
  if (fd < 0) return false;
  const size_t length = strlen(content);
  bool ok = write(fd, content, length) == static_cast<ssize_t>(length);
  return close(fd) == 0 && ok;
}
int Child(const char* exe, const std::string& profile, const char* expected) {
  pid_t pid = fork(); if (pid < 0) return -1;
  if (pid == 0) { execl(exe, exe, "child", profile.c_str(), expected, nullptr); _exit(127); }
  int status = 0; if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
  return WEXITSTATUS(status);
}
int main(int argc, char** argv) {
  if (argc == 4 && std::string(argv[1]) == "child") {
    ProfileReservationError error; auto value = ProfileReservation::Acquire(argv[2], &error);
    const bool busy = std::string(argv[3]) == "busy";
    return busy ? (!value && error == ProfileReservationError::kBusy ? 0 : 1)
                : (value && value->IsCurrent() ? 0 : 1);
  }
  if (argc != 3) return 2;
  const std::string root = argv[1], scenario = argv[2], parent = root + "/parent", profile = parent + "/profile";
  if (mkdir(parent.c_str(), 0700) || mkdir(profile.c_str(), 0700)) return 3;
  const std::string lock = parent + "/" + Name(profile);
  ProfileReservationError error;
  if (scenario == "process") {
    auto value = ProfileReservation::Acquire(profile, &error); if (!value || !value->IsCurrent()) return 4;
    if (Child(argv[0], profile, "busy")) return 5;
    if (mkdir((parent + "/other").c_str(), 0700) || Child(argv[0], parent + "/other", "free")) return 6;
    if (rename(profile.c_str(), (parent + "/old").c_str()) || mkdir(profile.c_str(), 0700)) return 7;
    if (!value->IsCurrent() || Child(argv[0], profile, "busy")) return 8;
    value.reset(); if (Child(argv[0], profile, "free")) return 9;
  } else if (scenario == "parent-replace") {
    auto value = ProfileReservation::Acquire(profile, &error); if (!value) return 25;
    if (rename(parent.c_str(), (root + "/displaced-parent").c_str()) || mkdir(parent.c_str(), 0700)) return 26;
    if (value->IsCurrent()) return 27;
  } else if (scenario == "replace") {
    auto value = ProfileReservation::Acquire(profile, &error); if (!value) return 10;
    if (rename(lock.c_str(), (parent + "/displaced").c_str()) || !File(lock, 0600)) return 11;
    if (value->IsCurrent()) return 12;
  } else {
    std::string requested = profile;
    if (scenario == "root-owner") { if (chown(profile.c_str(), 1, static_cast<gid_t>(-1))) return 28; }
    else if (scenario == "parent-owner") { if (chown(parent.c_str(), 1, static_cast<gid_t>(-1))) return 29; }
    else if (scenario == "root-mode") { if (chmod(profile.c_str(), 0755)) return 13; }
    else if (scenario == "parent-mode") { if (chmod(parent.c_str(), 0755)) return 14; }
    else if (scenario == "root-symlink") { if (rename(profile.c_str(), (parent + "/real").c_str()) || symlink("real", profile.c_str())) return 15; }
    else if (scenario == "parent-symlink") { if (symlink("parent", (root + "/alias").c_str())) return 16; requested = root + "/alias/profile"; }
    else if (scenario == "lock-symlink") { if (!File(parent + "/target", 0600, "keep") || symlink("target", lock.c_str())) return 17; }
    else if (scenario == "lock-hardlink") { if (!File(parent + "/target", 0600, "keep") || link((parent + "/target").c_str(), lock.c_str())) return 18; }
    else if (scenario == "lock-mode") { if (!File(lock, 0644)) return 19; }
    else if (scenario == "lock-directory") { if (mkdir(lock.c_str(), 0700)) return 20; }
    else if (scenario == "lock-content") { if (!File(lock, 0600, "keep")) return 21; }
    else return 22;
    auto value = ProfileReservation::Acquire(requested, &error);
    if (value || error != ProfileReservationError::kUnsafe) return 23;
    if (scenario == "lock-content" || scenario == "lock-hardlink" || scenario == "lock-symlink") {
      const std::string path = scenario == "lock-content" ? lock : parent + "/target";
      int fd = open(path.c_str(), O_RDONLY); char bytes[8]{};
      if (fd < 0 || read(fd, bytes, sizeof(bytes)) != 4 || memcmp(bytes, "keep", 4)) return 24;
      close(fd);
    }
  }
  std::cout << "ok\n"; return 0;
}
