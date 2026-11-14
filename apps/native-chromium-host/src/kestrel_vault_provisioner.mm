#include "kestrel_local_vault.h"
#include <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <array>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <vector>

namespace {
constexpr int channel = 3, parent = 4;
void Wipe(void* value, size_t count) { volatile unsigned char* p = static_cast<volatile unsigned char*>(value); while (count--) *p++ = 0; }
struct Secret { std::vector<unsigned char> bytes; ~Secret() { Wipe(bytes.data(), bytes.size()); } };
struct File { int fd; explicit File(int value) : fd(value) {} ~File() { if (fd >= 0) close(fd); } };
int64_t Now() { timespec t {}; clock_gettime(CLOCK_MONOTONIC, &t); return int64_t(t.tv_sec) * 1000 + t.tv_nsec / 1000000; }
bool Transfer(void* value, size_t count, bool writing, int64_t deadline) {
 auto* p = static_cast<unsigned char*>(value);
 while (count) {
  const auto remaining = deadline - Now(); if (remaining <= 0) return false;
  pollfd descriptor {channel, static_cast<short>(writing ? POLLOUT : POLLIN), 0};
  int ready = poll(&descriptor, 1, static_cast<int>(remaining));
  if (ready < 0 && errno == EINTR) continue;
  if (ready <= 0 || (descriptor.revents & (POLLERR | POLLNVAL))) return false;
  const ssize_t n = writing ? send(channel, p, count, 0) : recv(channel, p, count, 0);
  if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
  if (n <= 0) return false;
  p += n; count -= static_cast<size_t>(n);
 }
 return true;
}
uint64_t Get64(const unsigned char* bytes) { uint64_t value = 0; for (int n = 0; n < 8; ++n) value = (value << 8) | bytes[n]; return value; }
void Put64(unsigned char* bytes, uint64_t value) { for (int n = 7; n >= 0; --n) { bytes[n] = value & 255; value >>= 8; } }
bool PrivateDirectory(const struct stat& info) { return S_ISDIR(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 0077) == 0; }
bool SameDirectory(const struct stat& before, const struct stat& after) {
 return PrivateDirectory(after) && before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_mode == after.st_mode && before.st_gid == after.st_gid && before.st_flags == after.st_flags;
}
bool StillDirectory(int fd, const std::string& path, const struct stat& before) {
 struct stat held {}, named {}; char canonical[PATH_MAX];
 return fstat(fd, &held) == 0 && lstat(path.c_str(), &named) == 0 && realpath(path.c_str(), canonical) && path == canonical && SameDirectory(before, held) && SameDirectory(before, named);
}
bool VaultDigest(int root, unsigned char* digest) {
 File vault(openat(root, ".kestrel-local-vault-v1", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
 struct stat before {}, after {}, named {};
 auto safe = [](const struct stat& s) { return S_ISREG(s.st_mode) && s.st_uid == getuid() && s.st_nlink == 1 && (s.st_mode & 0777) == 0600 && s.st_size > 0 && s.st_size <= 16384; };
 if (vault.fd < 0 || fstat(vault.fd, &before) || !safe(before)) return false;
 std::array<unsigned char, 16385> bytes {}; size_t length = 0;
 while (length < bytes.size()) {
  const ssize_t n = read(vault.fd, bytes.data() + length, bytes.size() - length);
  if (n < 0 && errno == EINTR) continue;
  if (n < 0) return false; if (!n) break; length += n;
 }
 if (fstat(vault.fd, &after) || fstatat(root, ".kestrel-local-vault-v1", &named, AT_SYMLINK_NOFOLLOW) || !safe(after) || !safe(named) ||
     length != static_cast<size_t>(before.st_size) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_dev != named.st_dev || before.st_ino != named.st_ino ||
     before.st_size != after.st_size || before.st_size != named.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
     before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) return false;
 CC_SHA256(bytes.data(), static_cast<CC_LONG>(length), digest); return true;
}
}

// One-shot host-private provisioning. It creates only <private-parent>/profile;
// an existing root is always refused. No source key or existing-vault unlock is
// accepted. Success returns a fresh key only on the inherited Unix socket.
int main(int argc, char* argv[]) {
 (void)argv; if (argc != 1 || getuid() != geteuid()) return 1;
 rlimit no_core {0, 0}; if (setrlimit(RLIMIT_CORE, &no_core)) return 1;
 struct stat socket_info {}, parent_info {}; sockaddr_un address {}; socklen_t address_size = sizeof(address);
 uid_t peer_uid; gid_t peer_gid;
 if (fstat(channel, &socket_info) || !S_ISSOCK(socket_info.st_mode) || getsockname(channel, reinterpret_cast<sockaddr*>(&address), &address_size) || address.sun_family != AF_UNIX ||
     getpeereid(channel, &peer_uid, &peer_gid) || peer_uid != getuid() || fstat(parent, &parent_info) || !PrivateDirectory(parent_info)) return 1;
 int one = 1; if (setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one))) return 1;
 const int original_flags = fcntl(channel, F_GETFL); if (original_flags < 0 || fcntl(channel, F_SETFL, original_flags | O_NONBLOCK)) return 1;
 const int64_t deadline = Now() + 30000;
 std::array<unsigned char, 40> request {};
 if (!Transfer(request.data(), request.size(), false, deadline) || memcmp(request.data(), "KVP1", 4) ||
     Get64(request.data() + 20) != static_cast<uint64_t>(parent_info.st_dev) || Get64(request.data() + 28) != static_cast<uint64_t>(parent_info.st_ino)) return 1;
 uint32_t path_size; memcpy(&path_size, request.data() + 36, 4); path_size = ntohl(path_size);
 if (!path_size || path_size > 4000) return 1;
 std::string path(path_size, '\0'); if (!Transfer(path.data(), path.size(), false, deadline) || path.find('\0') != std::string::npos || path.front() != '/') return 1;
 unsigned char extra; pollfd descriptor {channel, POLLIN, 0};
 int ready; do { const auto remaining = deadline - Now(); if (remaining <= 0) return 1; ready = poll(&descriptor, 1, static_cast<int>(remaining)); } while (ready < 0 && errno == EINTR);
 if (ready <= 0 || recv(channel, &extra, 1, 0) != 0) return 1;
 if (!StillDirectory(parent, path, parent_info)) return 1;
 // Exclusivity is the no-overwrite boundary. Failed/partial output is retained
 // for its owning host to review; this helper never removes or renames it.
 if (mkdirat(parent, "profile", 0700)) return 1;
 const std::string root_path = path + "/profile";
 File root(openat(parent, "profile", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
 struct stat root_info {}; if (root.fd < 0 || fstat(root.fd, &root_info) || !PrivateDirectory(root_info) ||
     !StillDirectory(parent, path, parent_info) || !StillDirectory(root.fd, root_path, root_info) || fsync(parent)) return 1;
 NativeLocalVault vault; Secret key; std::string error;
 if (!vault.GetKey(root_path, "native-core-database/v1", true, &key.bytes, &error) || key.bytes.size() != 32) return 1;
 Secret response; response.bytes.resize(100);
 memcpy(response.bytes.data(), "KVP2", 4); memcpy(response.bytes.data() + 4, request.data() + 4, 16);
 Put64(response.bytes.data() + 20, static_cast<uint64_t>(root_info.st_dev)); Put64(response.bytes.data() + 28, static_cast<uint64_t>(root_info.st_ino));
 if (!VaultDigest(root.fd, response.bytes.data() + 36) || !StillDirectory(parent, path, parent_info) || !StillDirectory(root.fd, root_path, root_info)) return 1;
 memcpy(response.bytes.data() + 68, key.bytes.data(), 32);
 return Transfer(response.bytes.data(), response.bytes.size(), true, deadline) ? 0 : 1;
}
