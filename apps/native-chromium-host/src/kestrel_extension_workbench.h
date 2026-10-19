#ifndef KESTREL_EXTENSION_WORKBENCH_H_
#define KESTREL_EXTENSION_WORKBENCH_H_

#include <iostream>
#include <map>
#include <set>

#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_life_span_handler.h"
#include "kestrel_browser_commands.h"

// An opt-in compatibility workbench, not the production shell. Chrome owns
// extension permission prompts, management, toolbar actions and popup windows.
// No message router, custom scheme, Node/Core relay or credential API exists here.
namespace {
class ExtensionWorkbenchClient final : public CefClient,
                                       public CefLifeSpanHandler,
                                       public CefRequestHandler,
                                       public CefDisplayHandler,
                                       public CefLoadHandler {
 public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  bool OnBeforeBrowse(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request, bool, bool) override {
    return browser_child_mode && frame && frame->IsMain() && request &&
           !browser_child_url(request->GetURL().ToString());
  }
  void OnAddressChange(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>,
                       const CefString&) override { Publish(); }
  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
    titles_[browser->GetIdentifier()] = title.ToString();
    Publish();
  }
  void OnLoadingStateChange(CefRefPtr<CefBrowser>, bool, bool, bool) override {
    Publish();
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    if (browser_child_mode && browsers_.size() >= 32) {
      rejected_browser_closures_.insert(browser->GetIdentifier());
      browser->GetHost()->CloseBrowser(true);
      return;
    }
    browsers_[browser->GetIdentifier()] = browser;
    if (closing_) { browser->GetHost()->CloseBrowser(true); return; }
    ids_[browser->GetIdentifier()] = "tab-" + std::string(
        [[[NSUUID UUID] UUIDString].lowercaseString UTF8String]);
    timestamps_[browser->GetIdentifier()] = std::string(
        [[[NSISO8601DateFormatter alloc] init] stringFromDate:[NSDate date]].UTF8String);
    active_ = browser->GetIdentifier();
    Publish();
    std::cout << "KESTREL_EXTENSION_WORKBENCH_BROWSER_READY" << std::endl;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    rejected_browser_closures_.erase(browser->GetIdentifier());
    browsers_.erase(browser->GetIdentifier());
    ids_.erase(browser->GetIdentifier());
    timestamps_.erase(browser->GetIdentifier());
    titles_.erase(browser->GetIdentifier());
    if (active_ == browser->GetIdentifier())
      active_ = browsers_.empty() ? 0 : browsers_.begin()->first;
    Publish();
    if (browsers_.empty() && rejected_browser_closures_.empty()) CefQuitMessageLoop();
  }

  void CloseAll() {
    closing_ = true;
    if (browsers_.empty() && rejected_browser_closures_.empty()) { CefQuitMessageLoop(); return; }
    // Closing can synchronously trigger callbacks; iterate a snapshot.
    const auto browsers = browsers_;
    for (const auto& [id, browser] : browsers)
      browser->GetHost()->CloseBrowser(true);
  }

  CefRefPtr<CefDictionaryValue> Snapshot() {
    auto state = CefDictionaryValue::Create();
    auto tabs = CefListValue::Create();
    size_t index = 0;
    for (const auto& [id, browser] : browsers_) {
      if (!ids_.contains(id) || !browser->IsValid()) continue;
      auto tab = CefDictionaryValue::Create();
      tab->SetString("id", ids_[id]);
      std::string url = browser->GetMainFrame()->GetURL().ToString();
      tab->SetString("url", browser_child_url(url) && url != "about:blank" ? url : "");
      std::string title = titles_[id];
      if (title.size() > 500) title.resize(500);
      tab->SetString("title", title.empty() ? "Native browser" : title);
      tab->SetBool("loading", browser->IsLoading());
      tab->SetBool("canGoBack", browser->CanGoBack());
      tab->SetBool("canGoForward", browser->CanGoForward());
      tab->SetBool("discarded", false);
      tab->SetBool("crashed", false);
      tab->SetBool("pinned", false);
      tab->SetBool("muted", false);
      tab->SetString("createdAt", timestamps_[id]);
      tab->SetString("lastActiveAt", timestamps_[id]);
      tabs->SetDictionary(index++, tab);
    }
    state->SetList("tabs", tabs);
    if (ids_.contains(active_)) state->SetString("activeTabId", ids_[active_]);
    else state->SetNull("activeTabId");
    return state;
  }

  void Publish() {
    if (!browser_child_mode) return;
    auto event = CefDictionaryValue::Create();
    event->SetString("type", "state");
    event->SetDictionary("state", Snapshot());
    browser_emit(event);
  }

  void Command(const std::string& line) {
    if (closing_) return;
    auto value = CefParseJSON(line, JSON_PARSER_RFC);
    if (!value || value->GetType() != VTYPE_DICTIONARY) return;
    auto envelope = value->GetDictionary();
    if (envelope->GetInt("version") != 1) return;
    if (envelope->GetString("type") == "shutdown") { CloseAll(); return; }
    auto request = envelope->GetDictionary("request");
    const std::string request_id = envelope->GetString("id").ToString();
    if (envelope->GetString("type") != "request" || !request ||
        request_id.empty() || request_id.size() > 64) return;
    const std::string type = request->GetString("type").ToString();
    auto response = CefDictionaryValue::Create();
    response->SetString("type", "response");
    response->SetString("id", request_id);
    response->SetBool("ok", true);
    std::string error;
    CefRefPtr<CefBrowser> browser;
    const std::string tab_id = request->GetString("tabId").ToString();
    for (const auto& [id, candidate] : browsers_)
      if (ids_[id] == tab_id) browser = candidate;
    if (type == "browser-create-tab" || type == "browser-open-native-extensions") {
      std::string url = type == "browser-open-native-extensions"
          ? "chrome://extensions/" : request->GetString("input").ToString();
      if (url.empty()) url = "about:blank";
      if (type == "browser-open-native-extensions") {
        for (const auto& [id, candidate] : browsers_) {
          const auto current = candidate->GetMainFrame()->GetURL().ToString();
          if (current == "chrome://extensions/" || (browsers_.size() == 1 && current == "about:blank")) {
            browser = candidate;
            active_ = id;
            if (current != url) browser->GetMainFrame()->LoadURL(url);
            browser->GetHost()->SetFocus(true);
            NSView* view = (__bridge NSView*)browser->GetHost()->GetWindowHandle();
            [view.window makeKeyAndOrderFront:nil];
            break;
          }
        }
      }
      if (!browser_child_url(url)) error = "Enter an HTTP or HTTPS address.";
      else if (type == "browser-open-native-extensions" && browser) {
        // Reuse the manager or initial blank window instead of opening duplicates.
      } else if (browsers_.size() >= 32) error = "The native browser window limit was reached.";
      else {
        CefWindowInfo info;
        info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
        CefBrowserSettings settings;
        browser = CefBrowserHost::CreateBrowserSync(info, this, url, settings, nullptr, nullptr);
        if (!browser) error = "The native browser window could not open.";
      }
    } else if (type == "browser-get-state") {
      // Read only; no selected tab required.
    } else if (!browser || !browser->IsValid()) {
      error = "The native browser tab no longer exists.";
    } else if (type == "browser-select-tab") {
      active_ = browser->GetIdentifier();
      browser->GetHost()->SetFocus(true);
      NSView* view = (__bridge NSView*)browser->GetHost()->GetWindowHandle();
      [view.window makeKeyAndOrderFront:nil];
    } else if (type == "browser-navigate") {
      const std::string url = request->GetString("input").ToString();
      if (!browser_child_url(url)) error = "Enter an HTTP or HTTPS address.";
      else browser->GetMainFrame()->LoadURL(url);
    } else if (type == "browser-close-tab") browser->GetHost()->CloseBrowser(true);
    else if (type == "browser-back") browser->GoBack();
    else if (type == "browser-forward") browser->GoForward();
    else if (type == "browser-reload") {
      if (request->GetBool("ignoreCache")) browser->ReloadIgnoreCache();
      else browser->Reload();
    } else if (type == "browser-stop") browser->StopLoad();
    else error = "This native browser command is unavailable.";
    if (!error.empty()) {
      response->SetBool("ok", false);
      response->SetString("error", error);
    }
    response->SetDictionary("state", Snapshot());
    browser_emit(response);
    Publish();
  }

 private:
  int active_ = 0;
  std::map<int, std::string> ids_, timestamps_, titles_;
  std::set<int> rejected_browser_closures_;
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
          window_info, extension_workbench_client, browser_child_mode ? "about:blank" : "chrome://extensions/",
          browser_settings, nullptr, nullptr)) {
    std::cerr << "Could not create the native Chrome extension workbench." << std::endl;
    extension_workbench_exit_code = 1;
    extension_workbench_client = nullptr;
    CefQuitMessageLoop();
  }
  if (browser_child_mode && extension_workbench_client) {
    // Only the browser process owns stdin. Helpers have no command channel.
    NSFileHandle* input = [NSFileHandle fileHandleWithStandardInput];
    NSMutableData* buffer = [[NSMutableData alloc] init];
    input.readabilityHandler = ^(NSFileHandle* handle) {
      NSData* data = handle.availableData;
      if (data.length == 0 || buffer.length + data.length > 65536) {
        handle.readabilityHandler = nil;
        CefPostTask(TID_UI, new BrowserCommandTask([] {
          if (extension_workbench_client) extension_workbench_client->CloseAll();
        }));
        return;
      }
      [buffer appendData:data];
      const uint8_t newline = '\n';
      NSData* separator = [NSData dataWithBytes:&newline length:1];
      while (true) {
        NSRange range = [buffer rangeOfData:separator options:0
                                   range:NSMakeRange(0, buffer.length)];
        if (range.location == NSNotFound) break;
        NSData* bytes = [buffer subdataWithRange:NSMakeRange(0, range.location)];
        [buffer replaceBytesInRange:NSMakeRange(0, range.location + 1)
                          withBytes:nullptr length:0];
        NSString* text = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
        if (!text) continue;
        const std::string line(text.UTF8String);
        CefPostTask(TID_UI, new BrowserCommandTask([line] {
          if (extension_workbench_client) extension_workbench_client->Command(line);
        }));
      }
    };
  }
}
}  // namespace
#endif
