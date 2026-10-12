#ifndef KESTREL_EXTENSION_WORKBENCH_H_
#define KESTREL_EXTENSION_WORKBENCH_H_

#include <iostream>
#include <map>

#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_life_span_handler.h"

// An opt-in compatibility workbench, not the production shell. Chrome owns
// extension permission prompts, management, toolbar actions and popup windows.
// No message router, custom scheme, Node/Core relay or credential API exists here.
namespace {
class ExtensionWorkbenchClient final : public CefClient,
                                       public CefLifeSpanHandler {
 public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    browsers_[browser->GetIdentifier()] = browser;
    if (closing_) browser->GetHost()->CloseBrowser(true);
    std::cout << "KESTREL_EXTENSION_WORKBENCH_BROWSER_READY" << std::endl;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    browsers_.erase(browser->GetIdentifier());
    if (browsers_.empty()) CefQuitMessageLoop();
  }

  void CloseAll() {
    closing_ = true;
    // Closing can synchronously trigger callbacks; iterate a snapshot.
    const auto browsers = browsers_;
    for (const auto& [id, browser] : browsers)
      browser->GetHost()->CloseBrowser(true);
  }

 private:
  bool closing_ = false;
  std::map<int, CefRefPtr<CefBrowser>> browsers_;
  IMPLEMENT_REFCOUNTING(ExtensionWorkbenchClient);
};

CefRefPtr<ExtensionWorkbenchClient> extension_workbench_client;
int extension_workbench_exit_code = 0;

void StartExtensionWorkbench() {
  extension_workbench_client = new ExtensionWorkbenchClient();
  CefWindowInfo window_info;
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserSettings browser_settings;
  if (!CefBrowserHost::CreateBrowserSync(
          window_info, extension_workbench_client, "chrome://extensions/",
          browser_settings, nullptr, nullptr)) {
    std::cerr << "Could not create the native Chrome extension workbench." << std::endl;
    extension_workbench_exit_code = 1;
    extension_workbench_client = nullptr;
    CefQuitMessageLoop();
  }
}
}  // namespace
#endif
