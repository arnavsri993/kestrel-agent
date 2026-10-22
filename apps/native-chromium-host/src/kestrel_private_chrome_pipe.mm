#import <Foundation/Foundation.h>

#include "kestrel_private_chrome_pipe.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <climits>
#include <cstring>
#include <deque>
#include <map>
#include <set>
#include <utility>

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include "include/cef_parser.h"
#include "include/cef_task.h"

namespace {
constexpr size_t kMaxMessageBytes = 16 * 1024 * 1024;
constexpr size_t kMaxOutstanding = 64;
constexpr int64_t kTimeoutNanoseconds = 15LL * NSEC_PER_SEC;

class CompletionTask final : public CefTask {
 public:
  CompletionTask(KestrelPrivateChromePipe::Callback callback,
                 CefRefPtr<CefDictionaryValue> result, std::string error)
      : callback_(std::move(callback)), result_(result), error_(std::move(error)) {}
  void Execute() override { callback_(result_, error_); }
 private:
  KestrelPrivateChromePipe::Callback callback_;
  CefRefPtr<CefDictionaryValue> result_;
  std::string error_;
  IMPLEMENT_REFCOUNTING(CompletionTask);
};

void Complete(KestrelPrivateChromePipe::Callback callback,
              CefRefPtr<CefDictionaryValue> result, std::string error) {
  if (callback) {
    CefPostTask(TID_UI, new CompletionTask(std::move(callback), result,
                                         std::move(error)));
  }
}

bool PermittedMethod(const std::string& method) {
  static const std::set<std::string> methods = {
      "Browser.getVersion", "Extensions.loadUnpacked",
      "Extensions.getExtensions", "Extensions.uninstall", "Target.getTargets",
      "Target.attachToTarget", "Target.detachFromTarget", "Target.createTarget",
      "Target.closeTarget", "Runtime.evaluate",
      "ServiceWorker.enable", "ServiceWorker.startWorker"};
  return methods.count(method) != 0;
}

bool SetCloseOnExec(int fd) {
  const int flags = fcntl(fd, F_GETFD);
  return flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

bool SetNonBlocking(int fd) {
  const int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool IsClosed(int fd) {
  errno = 0;
  return fcntl(fd, F_GETFD) == -1 && errno == EBADF;
}

// CEF can close its own ends during shutdown. Do not close an unrelated fd
// subsequently allocated at the same number.
void CloseIfSameSocket(int fd, const struct stat& identity) {
  struct stat current = {};
  if (fstat(fd, &current) == 0 && S_ISSOCK(current.st_mode) &&
      current.st_dev == identity.st_dev && current.st_ino == identity.st_ino) {
    close(fd);
  }
}
}  // namespace

struct KestrelPrivateChromePipe::State
    : public std::enable_shared_from_this<KestrelPrivateChromePipe::State> {
  struct Pending {
    Callback callback;
    std::string session_id;
  };
  struct Frame {
    std::string bytes;
    size_t offset = 0;
  };

  dispatch_queue_t queue;
  dispatch_source_t reader = nil;
  dispatch_source_t writer = nil;
  int host_read = -1;
  int host_write = -1;
  struct stat chrome_read_identity = {};
  struct stat chrome_write_identity = {};
  std::atomic<bool> shutting_down{false};
  std::atomic<bool> quiesced{false};
  std::atomic<size_t> admitted{0};
  bool failed = false;
  bool writer_resumed = false;
  int next_id = 1;
  std::string incoming;
  std::map<int, Pending> pending;
  std::deque<Frame> outgoing;
  size_t queued_bytes = 0;

  void Start() {
    queue = dispatch_queue_create("com.kestrel.private-chrome-pipe",
                                  DISPATCH_QUEUE_SERIAL);
    std::weak_ptr<State> weak = shared_from_this();
    reader = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, host_read, 0, queue);
    writer = dispatch_source_create(DISPATCH_SOURCE_TYPE_WRITE, host_write, 0, queue);
    dispatch_source_set_event_handler(reader, ^{
      if (auto state = weak.lock()) state->Read();
    });
    dispatch_source_set_event_handler(writer, ^{
      if (auto state = weak.lock()) state->Write();
    });
    const int read_fd = host_read;
    const int write_fd = host_write;
    dispatch_source_set_cancel_handler(reader, ^{ close(read_fd); });
    dispatch_source_set_cancel_handler(writer, ^{ close(write_fd); });
    dispatch_resume(reader);
    // The writable source remains suspended until a queued frame needs it.
  }

  void Fail(const std::string& error) {
    if (failed) return;
    failed = true;
    auto callbacks = std::move(pending);
    pending.clear();
    outgoing.clear();
    queued_bytes = 0;
    incoming.clear();
    if (writer_resumed) {
      dispatch_suspend(writer);
      writer_resumed = false;
    }
    for (auto& entry : callbacks) {
      if (!quiesced && !shutting_down)
        Complete(std::move(entry.second.callback), nullptr, error);
    }
    // Keep both socket endpoints alive until Shutdown. An error or timeout
    // must not incidentally request that Chrome close all its windows.
  }

  void Enqueue(const std::string& method, CefRefPtr<CefDictionaryValue> params,
               const std::string& session_id, Callback callback) {
    if (quiesced) return;
    if (shutting_down || failed) {
      Complete(std::move(callback), nullptr, "Private Chrome pipe is unavailable.");
      return;
    }
    if (pending.size() >= kMaxOutstanding || next_id == INT_MAX) {
      Complete(std::move(callback), nullptr, "Private Chrome request limit reached.");
      return;
    }
    const int id = next_id++;
    auto message = CefDictionaryValue::Create();
    message->SetInt("id", id);
    message->SetString("method", method);
    if (params) message->SetDictionary("params", params);
    if (!session_id.empty()) message->SetString("sessionId", session_id);
    auto value = CefValue::Create();
    value->SetDictionary(message);
    std::string bytes = CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
    if (bytes.empty() || bytes.size() > kMaxMessageBytes ||
        queued_bytes + bytes.size() + 1 > kMaxMessageBytes + 1) {
      Complete(std::move(callback), nullptr, "Private Chrome message limit reached.");
      return;
    }
    bytes.push_back('\0');
    queued_bytes += bytes.size();
    outgoing.push_back({std::move(bytes), 0});
    pending.emplace(id, Pending{std::move(callback), session_id});
    std::weak_ptr<State> weak = shared_from_this();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kTimeoutNanoseconds), queue, ^{
      if (auto state = weak.lock()) {
        if (state->pending.count(id)) {
          // Fail the channel so a partially transmitted command is never
          // retried, reordered, or completed later as a different operation.
          state->Fail("Private Chrome request timed out; outcome is unknown.");
        }
      }
    });
    if (!writer_resumed) {
      writer_resumed = true;
      dispatch_resume(writer);
    }
  }

  void Write() {
    if (failed || shutting_down) return;
    size_t budget = 1024 * 1024;
    while (!outgoing.empty() && budget) {
      auto& frame = outgoing.front();
      const size_t remaining = frame.bytes.size() - frame.offset;
      const size_t amount = std::min(remaining, budget);
      const ssize_t count = send(host_write, frame.bytes.data() + frame.offset,
                                 amount, 0);
      if (count < 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        Fail("Private Chrome pipe write failed.");
        return;
      }
      if (count == 0) {
        Fail("Private Chrome pipe write closed.");
        return;
      }
      frame.offset += static_cast<size_t>(count);
      queued_bytes -= static_cast<size_t>(count);
      budget -= static_cast<size_t>(count);
      if (frame.offset == frame.bytes.size()) outgoing.pop_front();
    }
    if (outgoing.empty() && writer_resumed) {
      dispatch_suspend(writer);
      writer_resumed = false;
    }
  }

  void HandleMessage(const std::string& bytes) {
    auto value = CefParseJSON(bytes, JSON_PARSER_RFC);
    if (!value || value->GetType() != VTYPE_DICTIONARY) {
      Fail("Private Chrome pipe returned invalid JSON.");
      return;
    }
    auto message = value->GetDictionary();
    if (!message->HasKey("id")) return;  // Browser events stay private.
    if (message->GetType("id") != VTYPE_INT) {
      Fail("Private Chrome pipe returned an invalid response identifier.");
      return;
    }
    auto found = pending.find(message->GetInt("id"));
    if (found == pending.end()) return;
    const std::string session = message->GetType("sessionId") == VTYPE_STRING
        ? message->GetString("sessionId").ToString() : std::string();
    if (session != found->second.session_id) {
      Fail("Private Chrome response session did not match its request.");
      return;
    }
    auto callback = std::move(found->second.callback);
    pending.erase(found);
    if (message->GetType("error") == VTYPE_DICTIONARY) {
      auto error = message->GetDictionary("error");
      std::string detail = error->GetString("message").ToString();
      if (detail.size() > 1024) detail.resize(1024);
      Complete(std::move(callback), nullptr, "Chrome protocol error: " + detail);
    } else if (message->GetType("result") == VTYPE_DICTIONARY) {
      // This completion runs on another task. Detach the result from the
      // parsed envelope before that envelope releases its owned children.
      Complete(std::move(callback), message->GetDictionary("result")->Copy(false), "");
    } else {
      Complete(std::move(callback), nullptr, "Private Chrome response has no result.");
    }
  }

  void Read() {
    if (shutting_down) return;
    std::array<char, 64 * 1024> buffer;
    size_t budget = 1024 * 1024;
    while (budget) {
      const ssize_t count = recv(host_read, buffer.data(), buffer.size(), 0);
      if (count < 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        Fail("Private Chrome pipe read failed.");
        // Avoid a permanently readable failing descriptor and a busy loop.
        dispatch_source_cancel(reader);
        return;
      }
      if (count == 0) {
        Fail("Private Chrome pipe disconnected.");
        dispatch_source_cancel(reader);
        return;
      }
      budget -= static_cast<size_t>(count);
      if (failed) continue;  // Drain events, retaining the connection.
      size_t start = 0;
      for (size_t index = 0; index < static_cast<size_t>(count); ++index) {
        if (buffer[index] != '\0') continue;
        const size_t length = index - start;
        if (incoming.size() + length > kMaxMessageBytes) {
          Fail("Private Chrome response exceeds the message limit.");
          break;
        }
        incoming.append(buffer.data() + start, length);
        if (incoming.empty()) {
          Fail("Private Chrome pipe returned an empty frame.");
          break;
        }
        HandleMessage(incoming);
        incoming.clear();
        start = index + 1;
        if (failed) break;
      }
      if (failed) continue;
      const size_t remaining = static_cast<size_t>(count) - start;
      if (incoming.size() + remaining > kMaxMessageBytes) {
        Fail("Private Chrome response exceeds the message limit.");
      } else {
        incoming.append(buffer.data() + start, remaining);
      }
    }
  }

  void Stop() {
    Fail("Private Chrome pipe shut down.");
    dispatch_source_cancel(reader);
    dispatch_source_cancel(writer);
    if (!writer_resumed) {
      writer_resumed = true;
      dispatch_resume(writer);  // Cancellation handlers require a resumed source.
    }
    CloseIfSameSocket(3, chrome_read_identity);
    CloseIfSameSocket(4, chrome_write_identity);
  }
};

KestrelPrivateChromePipe::KestrelPrivateChromePipe(std::shared_ptr<State> state)
    : state_(std::move(state)) {}

std::shared_ptr<KestrelPrivateChromePipe> KestrelPrivateChromePipe::Create(
    std::string* error) {
  if (error) error->clear();
  if (!IsClosed(3) || !IsClosed(4)) {
    if (error) *error = "Private Chrome pipe requires unoccupied descriptors 3 and 4.";
    return nullptr;
  }
  int first[2] = {-1, -1};
  int second[2] = {-1, -1};
  std::array<int, 4> relocated = {-1, -1, -1, -1};
  bool installed_read = false;
  bool installed_write = false;
  auto fail = [&]() -> std::shared_ptr<KestrelPrivateChromePipe> {
    const int failure = errno;
    for (int fd : first) if (fd >= 0) close(fd);
    for (int fd : second) if (fd >= 0) close(fd);
    for (int fd : relocated) if (fd >= 0) close(fd);
    if (installed_read) close(3);
    if (installed_write) close(4);
    if (error) *error = std::string("Cannot reserve private Chrome pipe: ") +
                        std::strerror(failure);
    return nullptr;
  };
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, first) != 0 ||
      socketpair(AF_UNIX, SOCK_STREAM, 0, second) != 0) return fail();
  // Only relocate endpoints we just created. Existing descriptors are never
  // renumbered: other subsystems may retain their original descriptor numbers.
  std::array<int, 4> originals = {first[0], first[1], second[0], second[1]};
  for (size_t index = 0; index < originals.size(); ++index) {
    if (!SetCloseOnExec(originals[index])) return fail();
    relocated[index] = fcntl(originals[index], F_DUPFD_CLOEXEC, 5);
    if (relocated[index] < 0) return fail();
  }
  for (int& fd : first) { close(fd); fd = -1; }
  for (int& fd : second) { close(fd); fd = -1; }
  if (!IsClosed(3) || !IsClosed(4)) { errno = EBUSY; return fail(); }
  if (dup2(relocated[0], 3) != 3) return fail();
  installed_read = true;
  if (dup2(relocated[2], 4) != 4) return fail();
  installed_write = true;
  if (!SetCloseOnExec(3) || !SetCloseOnExec(4) ||
      !SetNonBlocking(relocated[1]) || !SetNonBlocking(relocated[3])) return fail();
  const int no_sigpipe = 1;
  if (setsockopt(relocated[1], SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                 sizeof(no_sigpipe)) != 0) return fail();
  auto state = std::make_shared<State>();
  if (fstat(3, &state->chrome_read_identity) != 0 ||
      fstat(4, &state->chrome_write_identity) != 0) return fail();
  state->host_write = relocated[1];
  state->host_read = relocated[3];
  close(relocated[0]);
  close(relocated[2]);
  state->Start();
  return std::shared_ptr<KestrelPrivateChromePipe>(
      new KestrelPrivateChromePipe(std::move(state)));
}

KestrelPrivateChromePipe::~KestrelPrivateChromePipe() { Shutdown(); }

bool KestrelPrivateChromePipe::Request(
    const std::string& method, CefRefPtr<CefDictionaryValue> params,
    const std::string& session_id, Callback callback) {
  if (!callback) return false;
  if (!CefCurrentlyOn(TID_UI) || !PermittedMethod(method) ||
      session_id.size() > 1024 || session_id.find('\0') != std::string::npos) {
    Complete(std::move(callback), nullptr, "Private Chrome request is not permitted.");
    return false;
  }
  auto state = state_;
  if (state->quiesced) return false;
  if (state->shutting_down) {
    Complete(std::move(callback), nullptr, "Private Chrome pipe is shut down.");
    return false;
  }
  size_t admitted = state->admitted.load();
  do {
    if (admitted >= kMaxOutstanding) {
      Complete(std::move(callback), nullptr, "Private Chrome request limit reached.");
      return false;
    }
  } while (!state->admitted.compare_exchange_weak(admitted, admitted + 1));
  // Bound requests waiting for the serial queue as well as requests already
  // transmitted. Release admission only when the UI receives the completion.
  Callback admitted_callback = [state, callback = std::move(callback)](
      CefRefPtr<CefDictionaryValue> result, const std::string& error) {
    state->admitted.fetch_sub(1);
    callback(result, error);
  };
  // Copy on the caller thread before returning ownership to callers.
  auto copied_params = params ? params->Copy(false) : nullptr;
  if (params && !copied_params) {
    Complete(std::move(admitted_callback), nullptr, "Cannot copy private Chrome parameters.");
    return false;
  }
  const std::string copied_method = method;
  const std::string copied_session = session_id;
  dispatch_async(state->queue, ^{
    state->Enqueue(copied_method, copied_params, copied_session, admitted_callback);
  });
  return true;
}

void KestrelPrivateChromePipe::Quiesce() {
  auto state = state_;
  if (!state || state->quiesced.exchange(true)) return;
  dispatch_sync(state->queue, ^{ state->Fail("Private Chrome pipe quiesced."); });
}

void KestrelPrivateChromePipe::Shutdown() {
  auto state = state_;
  if (!state || state->shutting_down.exchange(true)) return;
  dispatch_sync(state->queue, ^{ state->Stop(); });
}
