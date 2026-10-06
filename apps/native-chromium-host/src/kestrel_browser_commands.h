#ifndef KESTREL_BROWSER_COMMANDS_H_
#define KESTREL_BROWSER_COMMANDS_H_

#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/cef_request_handler.h"
#include "include/cef_display_handler.h"
#include "include/cef_load_handler.h"

// This protocol only controls browsing. There is deliberately no eval, file,
// credential, Core, scheme-registration or renderer-bridge command.
namespace {
bool browser_child_mode = false;

std::string browser_json(CefRefPtr<CefDictionaryValue> dictionary) {
  auto value = CefValue::Create();
  value->SetDictionary(dictionary);
  return CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
}

void browser_emit(CefRefPtr<CefDictionaryValue> message) {
  message->SetInt("version", 1);
  std::cout << "KESTREL_BROWSER_IPC " << browser_json(message) << std::endl;
}

bool browser_child_url(const std::string& url) {
  if (url.size() > 8192) return false;
  if (url == "about:blank" || url == "chrome://extensions/" ||
      url == "chrome://newtab/") return true;
  CefURLParts parts;
  if (!CefParseURL(url, parts)) return false;
  const std::string scheme = CefString(&parts.scheme).ToString();
  return (scheme == "http" || scheme == "https" ||
          scheme == "chrome-extension") &&
         !CefString(&parts.host).empty() && CefString(&parts.username).empty() &&
         CefString(&parts.password).empty();
}

class BrowserCommandTask final : public CefTask {
 public:
  explicit BrowserCommandTask(std::function<void()> command)
      : command_(std::move(command)) {}
  void Execute() override { command_(); }
 private:
  std::function<void()> command_;
  IMPLEMENT_REFCOUNTING(BrowserCommandTask);
};
}  // namespace
#endif
