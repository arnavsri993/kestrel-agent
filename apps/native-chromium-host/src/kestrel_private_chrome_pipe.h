#ifndef KESTREL_PRIVATE_CHROME_PIPE_H_
#define KESTREL_PRIVATE_CHROME_PIPE_H_

#include <functional>
#include <memory>
#include <string>

#include "include/cef_values.h"

// Native browser-process use only. Never expose this command transport to a
// renderer, page, extension, or generic bridge. Callers must validate their
// typed operation, arguments, target/session ownership, and approval policy.
class KestrelPrivateChromePipe {
 public:
  using Callback = std::function<void(CefRefPtr<CefDictionaryValue> result,
                                      const std::string& error)>;

  // Call once, before loading the CEF library, with fd 3 and 4 unoccupied.
  // Fails closed if either fd already belongs to another owner. Chromium must
  // subsequently be initialized with --remote-debugging-pipe. No TCP listener
  // is created. Keep this object alive until CEF has completely shut down:
  // disconnecting Chrome's pipe can close its browser windows.
  static std::shared_ptr<KestrelPrivateChromePipe> Create(std::string* error);
  ~KestrelPrivateChromePipe();

  // Call on CEF's UI thread after initialization. An empty session_id addresses
  // the trusted browser target. The callback is always posted to CEF's UI
  // thread (and cannot run once that thread has shut down). True means queued,
  // not completed; all protocol, capacity, timeout, and connection failures are
  // reported through the callback. Requests time out after 15 seconds.
  bool Request(const std::string& method,
               CefRefPtr<CefDictionaryValue> params,
               const std::string& session_id,
               Callback callback);

  // Stop protocol work while CEF is still alive, retaining the socket ends
  // until Shutdown so disconnect cannot initiate a second browser close.
  void Quiesce();

  // Only call after CefShutdown / the final CEF work. This is idempotent.
  void Shutdown();

 private:
  struct State;
  explicit KestrelPrivateChromePipe(std::shared_ptr<State> state);
  std::shared_ptr<State> state_;
  KestrelPrivateChromePipe(const KestrelPrivateChromePipe&) = delete;
  KestrelPrivateChromePipe& operator=(const KestrelPrivateChromePipe&) = delete;
};

#endif  // KESTREL_PRIVATE_CHROME_PIPE_H_
