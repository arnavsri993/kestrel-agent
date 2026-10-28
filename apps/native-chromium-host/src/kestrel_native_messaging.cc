#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {
constexpr uint32_t kMaxMessage = 1024 * 1024;

bool ValidOrigin(const char* origin) {
  if (!origin) return false;
  const std::string value(origin);
  const std::string prefix = "chrome-extension://";
  if (value.size() != prefix.size() + 33 || value.compare(0, prefix.size(), prefix) ||
      value.back() != '/') return false;
  for (size_t i = prefix.size(); i < prefix.size() + 32; ++i) {
    if (value[i] < 'a' || value[i] > 'p') return false;
  }
  return true;
}

bool Nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

// Exactly one message per direction may be buffered. This preserves framing,
// bounds memory and naturally applies backpressure to either producer.
struct Direction {
  Direction(int input_fd, int output_fd) : input(input_fd), output(output_fd) {}
  int input;
  int output;
  std::vector<unsigned char> frame;
  size_t written = 0;
  size_t expected = sizeof(uint32_t);
  bool eof = false;

  bool Read() {
    unsigned char buffer[16384];
    size_t remaining = expected - frame.size();
    ssize_t count = read(input, buffer, remaining < sizeof(buffer) ? remaining : sizeof(buffer));
    if (count == 0) {
      if (!frame.empty()) return false;
      eof = true;
      return true;
    }
    if (count < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    frame.insert(frame.end(), buffer, buffer + count);
    if (frame.size() == sizeof(uint32_t) && expected == sizeof(uint32_t)) {
      uint32_t size;
      std::memcpy(&size, frame.data(), sizeof(size));
      if (size == 0 || size > kMaxMessage) return false;
      expected += size;
    }
    return true;
  }

  bool Ready() const { return frame.size() == expected && expected > sizeof(uint32_t); }
  bool Write() {
    ssize_t count = write(output, frame.data() + written, frame.size() - written);
    if (count < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    if (count == 0) return false;
    written += static_cast<size_t>(count);
    if (written == frame.size()) {
      frame.clear();
      written = 0;
      expected = sizeof(uint32_t);
    }
    return true;
  }
};
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2 || !ValidOrigin(argv[1])) return 1;
  size_t length = confstr(_CS_DARWIN_USER_TEMP_DIR, nullptr, 0);
  if (length == 0 || length > 4096) return 1;
  std::vector<char> temp(length);
  if (confstr(_CS_DARWIN_USER_TEMP_DIR, temp.data(), temp.size()) != length) return 1;
  std::string path(temp.data());
  if (path.empty()) return 1;
  if (path.back() != '/') path.push_back('/');
  path += "kestrel-native-" + std::to_string(getppid()) + "/bridge.sock";
  sockaddr_un address{};
  if (path.size() >= sizeof(address.sun_path)) return 1;
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (socket_fd < 0) return 1;
  if (connect(socket_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
    close(socket_fd);
    return 1;
  }
  signal(SIGPIPE, SIG_IGN);
  if (!Nonblocking(STDIN_FILENO) || !Nonblocking(STDOUT_FILENO) || !Nonblocking(socket_fd)) {
    close(socket_fd);
    return 1;
  }

  Direction to_broker{STDIN_FILENO, socket_fd};
  Direction to_chrome{socket_fd, STDOUT_FILENO};
  const std::string hello = std::string("{\"kind\":\"native-host\",\"origin\":\"") + argv[1] + "\"}";
  uint32_t hello_size = static_cast<uint32_t>(hello.size());
  to_broker.frame.resize(sizeof(hello_size));
  std::memcpy(to_broker.frame.data(), &hello_size, sizeof(hello_size));
  to_broker.frame.insert(to_broker.frame.end(), hello.begin(), hello.end());
  to_broker.expected = to_broker.frame.size();

  bool half_closed = false;
  bool ok = true;
  while (ok) {
    if (to_broker.eof && !to_broker.Ready() && !half_closed) {
      shutdown(socket_fd, SHUT_WR);
      half_closed = true;
    }
    if (to_chrome.eof && !to_chrome.Ready()) break;
    pollfd fds[3] = {{STDIN_FILENO, 0, 0}, {STDOUT_FILENO, 0, 0}, {socket_fd, 0, 0}};
    if (!to_broker.eof && !to_broker.Ready()) fds[0].events |= POLLIN;
    if (to_chrome.Ready()) fds[1].events |= POLLOUT;
    if (!to_chrome.eof && !to_chrome.Ready()) fds[2].events |= POLLIN;
    if (to_broker.Ready()) fds[2].events |= POLLOUT;
    int result = poll(fds, 3, -1);
    if (result < 0) { if (errno == EINTR) continue; ok = false; break; }
    if ((fds[0].revents & (POLLIN | POLLHUP)) && !to_broker.Ready()) ok = to_broker.Read();
    if (ok && (fds[2].revents & POLLOUT) && to_broker.Ready()) ok = to_broker.Write();
    if (ok && (fds[2].revents & (POLLIN | POLLHUP)) && !to_chrome.Ready()) ok = to_chrome.Read();
    if (ok && (fds[1].revents & POLLOUT) && to_chrome.Ready()) ok = to_chrome.Write();
    if ((fds[0].revents | fds[1].revents | fds[2].revents) & (POLLERR | POLLNVAL)) ok = false;
    if ((fds[1].revents & POLLHUP) != 0) ok = false;
  }
  close(socket_fd);
  return ok ? 0 : 1;
}
