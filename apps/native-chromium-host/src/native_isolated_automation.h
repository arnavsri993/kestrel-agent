#ifndef KESTREL_NATIVE_ISOLATED_AUTOMATION_H_
#define KESTREL_NATIVE_ISOLATED_AUTOMATION_H_

#include <functional>
#include <memory>
#include <string>
#include "include/cef_browser.h"
#include "include/cef_values.h"

// UI-thread-owned, nonpersistent, windowless background browser sessions. The
// desktop owns this manager and must call Shutdown before closing its owner.
// CefSettings.windowless_rendering_enabled must be set before CefInitialize.
// Request accepts only the authenticated internal browser operation schema;
// callers never supply JavaScript or DevTools methods.
class NativeIsolatedAutomation final {
 public:
  using Reply = std::function<void(const std::string& request_id, bool ok,
                                   const std::string& result_json,
                                   const std::string& error)>;
  NativeIsolatedAutomation(CefRefPtr<CefBrowser> owner, Reply reply);
  ~NativeIsolatedAutomation();
  NativeIsolatedAutomation(const NativeIsolatedAutomation&) = delete;
  NativeIsolatedAutomation& operator=(const NativeIsolatedAutomation&) = delete;
  void Request(const std::string& request_id,
               CefRefPtr<CefDictionaryValue> request);
  void Cancel(const std::string& request_id);
  void Shutdown(std::function<void()> on_closed = {});

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

#endif  // KESTREL_NATIVE_ISOLATED_AUTOMATION_H_
