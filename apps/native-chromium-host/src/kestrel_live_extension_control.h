#pragma once
#include <functional>
#include <deque>
#include <memory>
#include <string>
#include "include/cef_values.h"
#include "kestrel_private_chrome_pipe.h"

// Only the trusted Node package manager calls this typed boundary. Neither
// CDP methods nor JavaScript expressions are accepted from a renderer.
class KestrelLiveExtensionControl
    : public std::enable_shared_from_this<KestrelLiveExtensionControl> {
 public:
  using Callback = KestrelPrivateChromePipe::Callback;
  KestrelLiveExtensionControl(std::shared_ptr<KestrelPrivateChromePipe> pipe,
                              std::string profile_root,
                              std::function<void()> fatal_callback);
  void Handle(CefRefPtr<CefDictionaryValue> request, Callback callback);
  // Call on the UI thread before CefShutdown. No delayed work may retain CEF
  // objects or issue another command after this returns.
  void Shutdown();
 private:
  struct Operation;
  bool Current(const std::shared_ptr<Operation>& operation);
  void Expire(const std::shared_ptr<Operation>& operation);
  void Finish(const std::shared_ptr<Operation>& operation,
              CefRefPtr<CefDictionaryValue> result, const std::string& error);
  void Stop(bool fatal);
  void StartNext();
  void Request(const std::string& method, CefRefPtr<CefDictionaryValue> params,
               const std::string& session, Callback callback, bool mutation = false);
  void Retry(std::function<void()> callback);
  void EnsureControl(Callback callback, int attempts = 0);
  void Evaluate(const std::string& expression, Callback callback, bool mutation = false);
  void Get(const std::string& id, Callback callback);
  void Load(const std::string& id, const std::string& path, Callback callback);
  void Worker(const std::string& id, Callback callback, int attempts = 0);
  bool DenyFileAccessBeforeLoad(const std::string& id, const std::string& path);
  std::shared_ptr<KestrelPrivateChromePipe> pipe_;
  std::string profile_root_;
  std::string control_target_;
  std::string control_session_;
  std::function<void()> fatal_callback_;
  std::deque<std::shared_ptr<Operation>> queued_;
  std::shared_ptr<Operation> active_;
  bool stopped_ = false;
};
