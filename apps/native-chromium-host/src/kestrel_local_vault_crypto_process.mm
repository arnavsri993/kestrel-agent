#include "kestrel_local_vault_crypto_process.h"
#include "kestrel_local_vault_crypto.h"
#import <Foundation/Foundation.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <cstring>

namespace {
void Wipe(void* ptr, size_t len) { volatile uint8_t* p = static_cast<volatile uint8_t*>(ptr); while (len--) *p++ = 0; }
constexpr int kTimeoutMs = 10000;
int64_t NowMs() { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return int64_t(t.tv_sec) * 1000 + t.tv_nsec / 1000000; }
void Put32(uint8_t* p, uint32_t n) { n = htonl(n); memcpy(p, &n, 4); }
uint32_t Get32(const uint8_t* p) { uint32_t n; memcpy(&n, p, 4); return ntohl(n); }
void Clear(std::vector<uint8_t>* v) { if (v && !v->empty()) Wipe(v->data(), v->size()); if (v) v->clear(); }

bool HelperPath(const std::string& fixture, std::string* result) {
  std::string candidate;
  if (!fixture.empty()) candidate = fixture;
  else {
    @autoreleasepool {
      NSString* executable = [[NSBundle mainBundle] executablePath];
      NSString* bundle = [[NSBundle mainBundle] bundlePath];
      if (!executable || !bundle) return false;
      NSString* helper = [[executable stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"Kestrel Vault"];
      char canonical_bundle[PATH_MAX], canonical_exec[PATH_MAX];
      if (!realpath([bundle fileSystemRepresentation], canonical_bundle) ||
          !realpath([executable fileSystemRepresentation], canonical_exec)) return false;
      std::string prefix = std::string(canonical_bundle) + "/";
      if (std::string(canonical_exec).compare(0, prefix.size(), prefix) != 0) return false;
      candidate = [helper fileSystemRepresentation];
      char resolved[PATH_MAX];
      if (!realpath(candidate.c_str(), resolved) || std::string(resolved).compare(0, prefix.size(), prefix) != 0) return false;
    }
  }
  struct stat st;
  if (lstat(candidate.c_str(), &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      (st.st_uid != geteuid() && st.st_uid != 0) || (st.st_mode & (S_IWGRP | S_IWOTH)) ||
      !(st.st_mode & S_IXUSR) || access(candidate.c_str(), X_OK) != 0) return false;
  *result = candidate;
  return true;
}

bool Transfer(int fd, void* buffer, size_t len, bool writing, int64_t deadline) {
  auto* p = static_cast<uint8_t*>(buffer);
  while (len) {
    int64_t remaining = deadline - NowMs();
    if (remaining <= 0) return false;
    struct pollfd f = {fd, static_cast<short>(writing ? POLLOUT : POLLIN), 0};
    int r = poll(&f, 1, static_cast<int>(remaining));
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0 || (f.revents & (POLLERR | POLLNVAL))) return false;
    ssize_t n = writing ? send(fd, p, len, 0) : recv(fd, p, len, 0);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n <= 0) return false;
    p += n; len -= static_cast<size_t>(n);
  }
  return true;
}
bool Run(uint32_t op, const std::vector<uint8_t>& context, const std::vector<uint8_t>& input,
         std::vector<uint8_t>* output, const std::string& fixture) {
  if (!output) return false;
  Clear(output);
  if (context.empty() || context.size() > KESTREL_VAULT_MAX_CONTEXT ||
      (op == 1 ? input.size() != 32 : input.empty() || input.size() > KESTREL_VAULT_MAX_ENVELOPE)) return false;
  std::string path;
  if (!HelperPath(fixture, &path)) return false;
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return false;
  // Move both descriptors away from stdio and fd 3 before spawn file actions.
  int parent = fcntl(sockets[0], F_DUPFD_CLOEXEC, 4);
  int child = fcntl(sockets[1], F_DUPFD_CLOEXEC, 4);
  close(sockets[0]); close(sockets[1]);
  if (parent < 0 || child < 0) { if (parent >= 0) close(parent); if (child >= 0) close(child); return false; }
  int one = 1;
  if (setsockopt(parent, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) != 0 ||
      fcntl(parent, F_SETFL, fcntl(parent, F_GETFL) | O_NONBLOCK) != 0) { close(parent); close(child); return false; }
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attr;
  if (posix_spawn_file_actions_init(&actions) != 0) { close(parent); close(child); return false; }
  if (posix_spawnattr_init(&attr) != 0) { posix_spawn_file_actions_destroy(&actions); close(parent); close(child); return false; }
  int err = posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);
  if (!err) err = posix_spawn_file_actions_adddup2(&actions, child, 3);
  if (!err) err = posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
  if (!err) err = posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
  if (!err) err = posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
  pid_t pid = -1;
  char* argv[] = {const_cast<char*>(path.c_str()), nullptr};
  char* env[] = {nullptr};
  int64_t deadline = NowMs() + kTimeoutMs;
  if (!err) err = posix_spawn(&pid, path.c_str(), &actions, &attr, argv, env);
  posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions); close(child);
  if (err) { close(parent); return false; }
  uint8_t request[16]; memcpy(request, "KVC1", 4); Put32(request + 4, op);
  Put32(request + 8, static_cast<uint32_t>(context.size())); Put32(request + 12, static_cast<uint32_t>(input.size()));
  bool ok = Transfer(parent, request, sizeof(request), true, deadline) &&
      Transfer(parent, const_cast<uint8_t*>(context.data()), context.size(), true, deadline) &&
      Transfer(parent, const_cast<uint8_t*>(input.data()), input.size(), true, deadline) && shutdown(parent, SHUT_WR) == 0;
  uint8_t reply[8];
  if (ok) ok = Transfer(parent, reply, sizeof(reply), false, deadline) && memcmp(reply, "KVR1", 4) == 0;
  uint32_t len = ok ? Get32(reply + 4) : 0;
  if (ok) ok = op == 1 ? len > 0 && len <= KESTREL_VAULT_MAX_ENVELOPE : len == 32;
  if (ok) { output->resize(len); ok = Transfer(parent, output->data(), len, false, deadline); }
  // Require EOF: no trailing response bytes. Poll uses the same overall deadline.
  if (ok) {
    uint8_t extra;
    int64_t remaining = deadline - NowMs();
    struct pollfd f = {parent, POLLIN, 0};
    int r; do { r = remaining > 0 ? poll(&f, 1, static_cast<int>(remaining)) : 0; } while (r < 0 && errno == EINTR && (remaining = deadline - NowMs()) > 0);
    ok = r > 0 && recv(parent, &extra, 1, 0) == 0;
  }
  close(parent);
  int status = 0; pid_t waited = 0;
  while ((waited = waitpid(pid, &status, WNOHANG)) == 0 && NowMs() < deadline) poll(nullptr, 0, 5);
  if (waited != pid) { kill(pid, SIGKILL); while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {} ok = false; }
  if (waited == pid && (!WIFEXITED(status) || WEXITSTATUS(status) != 0)) ok = false;
  if (!ok) Clear(output);
  return ok;
}
}
bool NativeVaultSealIsolated(const std::vector<uint8_t>& context, const std::vector<uint8_t>& key,
                             std::vector<uint8_t>* envelope, const std::string& fixture) {
  return Run(1, context, key, envelope, fixture);
}
bool NativeVaultOpenIsolated(const std::vector<uint8_t>& context, const std::vector<uint8_t>& envelope,
                             std::vector<uint8_t>* key, const std::string& fixture) {
  return Run(2, context, envelope, key, fixture);
}
