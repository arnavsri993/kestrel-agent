#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <functional>
#include <iostream>
#include <limits.h>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "include/cef_application_mac.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_display_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_parser.h"
#include "include/cef_request_context.h"
#include "include/cef_request_context_handler.h"
#include "include/cef_request_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_stream.h"
#include "include/cef_task.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_library_loader.h"
#include "include/wrapper/cef_message_router.h"
#include "include/wrapper/cef_stream_resource_handler.h"
#include "kestrel_chromium_app.h"
#include "kestrel_extension_workbench.h"

@interface KestrelNativeCoreRelay : NSObject
- (instancetype)initWithProfileRoot:(NSString*)profileRoot
                        lineHandler:(void (^)(NSString* line))lineHandler
                 terminationHandler:(void (^)(NSString* error))terminationHandler;
- (BOOL)start:(NSError**)error;
- (BOOL)sendLine:(NSString*)line;
- (void)shutdown;
@end

@interface KestrelNativeCoreRelay ()
@property(nonatomic, copy) NSString* profileRoot;
@property(nonatomic, copy) void (^lineHandler)(NSString* line);
@property(nonatomic, copy) void (^terminationHandler)(NSString* error);
@property(nonatomic, strong) NSTask* task;
@property(nonatomic, strong) NSFileHandle* input;
@property(nonatomic, strong) NSFileHandle* output;
@property(nonatomic, strong) NSMutableData* outputBuffer;
@property(nonatomic) BOOL stopping;
@end

@implementation KestrelNativeCoreRelay

- (instancetype)initWithProfileRoot:(NSString*)profileRoot
                        lineHandler:(void (^)(NSString* line))lineHandler
                 terminationHandler:(void (^)(NSString* error))terminationHandler {
  self = [super init];
  if (!self) return nil;
  _profileRoot = [profileRoot copy];
  _lineHandler = [lineHandler copy];
  _terminationHandler = [terminationHandler copy];
  _outputBuffer = [[NSMutableData alloc] init];
  return self;
}

- (BOOL)start:(NSError**)error {
  NSString* resources = [[NSBundle mainBundle] resourcePath];
  NSString* node =
      [resources stringByAppendingPathComponent:@"agent-core/node/bin/node"];
  NSString* relay =
      [resources stringByAppendingPathComponent:@"native-core-relay.mjs"];
  NSFileManager* files = [NSFileManager defaultManager];
  if (![files isExecutableFileAtPath:node] || ![files isReadableFileAtPath:relay]) {
    if (error) {
      *error = [NSError
          errorWithDomain:@"com.kestrel.native-chromium-host"
                     code:1
                 userInfo:@{
                   NSLocalizedDescriptionKey :
                       @"Kestrel's standalone Node Core bundle is missing."
                 }];
    }
    return NO;
  }

  self.task = [[NSTask alloc] init];
  self.task.executableURL = [NSURL fileURLWithPath:node];
  self.task.arguments = @[ relay, @"--profile-root", self.profileRoot ];
  NSPipe* inputPipe = [NSPipe pipe];
  NSPipe* outputPipe = [NSPipe pipe];
  self.input = [inputPipe fileHandleForWriting];
  self.output = [outputPipe fileHandleForReading];
  self.task.standardInput = inputPipe;
  self.task.standardOutput = outputPipe;
  self.task.standardError = [NSFileHandle fileHandleWithStandardError];

  __weak KestrelNativeCoreRelay* weakSelf = self;
  self.output.readabilityHandler = ^(NSFileHandle* handle) {
    KestrelNativeCoreRelay* strongSelf = weakSelf;
    if (!strongSelf) return;
    NSData* data = [handle availableData];
    if (data.length == 0) {
      handle.readabilityHandler = nil;
      return;
    }
    [strongSelf consumeOutput:data];
  };
  self.task.terminationHandler = ^(NSTask* task) {
    KestrelNativeCoreRelay* strongSelf = weakSelf;
    if (!strongSelf || strongSelf.stopping) return;
    NSString* error = [NSString
        stringWithFormat:@"Kestrel's standalone Node Core relay exited (%d).",
                         task.terminationStatus];
    if (strongSelf.terminationHandler) strongSelf.terminationHandler(error);
  };
  return [self.task launchAndReturnError:error];
}

- (void)consumeOutput:(NSData*)data {
  [self.outputBuffer appendData:data];
  const uint8_t newline = '\n';
  while (true) {
    NSRange range = [self.outputBuffer
        rangeOfData:[NSData dataWithBytes:&newline length:1]
            options:0
              range:NSMakeRange(0, self.outputBuffer.length)];
    if (range.location == NSNotFound) return;
    NSData* lineData =
        [self.outputBuffer subdataWithRange:NSMakeRange(0, range.location)];
    [self.outputBuffer
        replaceBytesInRange:NSMakeRange(0, range.location + 1)
                  withBytes:nullptr
                     length:0];
    NSString* line =
        [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
    if (line && self.lineHandler) self.lineHandler(line);
  }
}

- (BOOL)sendLine:(NSString*)line {
  if (self.stopping || !self.task.isRunning || !self.input) return NO;
  NSData* data =
      [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  @try {
    [self.input writeData:data];
    return YES;
  } @catch (NSException*) {
    return NO;
  }
}

- (void)shutdown {
  if (self.stopping) return;
  self.stopping = YES;
  self.output.readabilityHandler = nil;
  self.task.terminationHandler = nil;
  @try {
    [self.input closeFile];
  } @catch (NSException*) {
  }
  if (self.task.isRunning) [self.task terminate];
}

@end

namespace {

std::string shell_url;
std::string isolated_profile_path;
std::string renderer_resource_root;
int exit_after_ready_ms = 0;
bool ephemeral_core_enabled = false;
bool full_renderer_enabled = false;
std::optional<std::string> smoke_user_browser_url;
bool smoke_user_browser_via_bridge = false;
CefRefPtr<CefWindow> kestrel_window;

std::optional<std::string> argument_value(int argc,
                                          char* argv[],
                                          const std::string& name) {
  for (int index = 1; index < argc - 1; ++index) {
    if (name == argv[index]) {
      return std::string(argv[index + 1]);
    }
  }
  return std::nullopt;
}

bool has_argument(int argc, char* argv[], const std::string& name) {
  for (int index = 1; index < argc; ++index) {
    if (name == argv[index]) {
      return true;
    }
  }
  return false;
}

std::string trim_ascii(std::string value) {
  const auto is_space = [](unsigned char character) {
    return std::isspace(character) != 0;
  };
  while (!value.empty() && is_space(value.front())) value.erase(value.begin());
  while (!value.empty() && is_space(value.back())) value.pop_back();
  return value;
}

bool has_control_character(const std::string& value) {
  return std::any_of(value.begin(), value.end(), [](unsigned char character) {
    return character < 0x20 || character == 0x7f;
  });
}

std::string renderer_safe_text(std::string value, size_t limit,
                               std::string_view fallback = "Untitled") {
  value.erase(std::remove_if(value.begin(), value.end(),
                             [](unsigned char character) {
                               return character < 0x20 || character == 0x7f;
                             }),
              value.end());
  if (value.size() > limit) value.resize(limit);
  return value.empty() ? std::string(fallback) : value;
}

std::string iso8601_now() {
  const auto now = std::chrono::system_clock::now();
  const auto seconds = std::chrono::time_point_cast<std::chrono::seconds>(now);
  const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
      now - seconds);
  const std::time_t seconds_since_epoch =
      std::chrono::system_clock::to_time_t(seconds);
  std::tm utc{};
  gmtime_r(&seconds_since_epoch, &utc);
  char date[32]{};
  std::strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc);
  char result[40]{};
  std::snprintf(result, sizeof(result), "%s.%03lldZ", date,
                static_cast<long long>(milliseconds.count()));
  return result;
}

std::string native_uuid() {
  NSString* uuid = [[[NSUUID UUID] UUIDString] lowercaseString];
  return std::string([uuid UTF8String] ?: "");
}

std::string native_local_model_status() {
  // Reading this process-local hardware summary does not consult Keychain,
  // start a local runtime, or ask macOS for protected data. The native host
  // intentionally reports its local-model capability as unavailable until it
  // owns an explicit, user-approved local runtime lifecycle.
  NSProcessInfo* const process_info = [NSProcessInfo processInfo];
  const uint64_t memory_bytes =
      std::max<uint64_t>(1, static_cast<uint64_t>(process_info.physicalMemory));
  const int logical_cpus =
      std::max(1, static_cast<int>(process_info.activeProcessorCount));
  return "{\"ok\":true,\"systemProfile\":{\"platform\":\"darwin\","
         "\"architecture\":\"arm64\",\"memoryBytes\":" +
         std::to_string(memory_bytes) + ",\"logicalCpus\":" +
         std::to_string(logical_cpus) +
         "},\"ollamaAvailable\":false,\"localModels\":[],"
         "\"localRuntime\":{\"automaticSupported\":false,"
         "\"managedRuntime\":false,\"ollamaAvailable\":false,"
         "\"source\":\"none\",\"runtimeDownloadBytes\":145355166,"
         "\"localModels\":[],\"unavailableReason\":"
         "\"Local model setup is not available in the native Chromium host "
         "yet. Continue without a model or add one after this host migrates "
         "that runtime.\"},\"localModelError\":"
         "\"Local model setup is not available in the native Chromium host yet.\""
         "}";
}

std::optional<std::string> safe_user_browser_url(
    const std::string& candidate) {
  if (candidate.empty() || candidate.size() > 8 * 1024 ||
      has_control_character(candidate)) {
    return std::nullopt;
  }
  CefURLParts parts;
  if (!CefParseURL(candidate, parts)) return std::nullopt;
  const std::string scheme = CefString(&parts.scheme).ToString();
  const std::string host = CefString(&parts.host).ToString();
  if ((scheme != "http" && scheme != "https") || host.empty() ||
      !CefString(&parts.username).ToString().empty() ||
      !CefString(&parts.password).ToString().empty()) {
    return std::nullopt;
  }
  const std::string canonical = CefString(&parts.spec).ToString();
  if (canonical.empty() || canonical.size() > 8 * 1024) return std::nullopt;
  return canonical;
}

std::optional<std::string> normalize_user_browser_input(std::string input) {
  input = trim_ascii(std::move(input));
  if (input.empty()) return std::nullopt;
  if (input.size() > 8 * 1024 || has_control_character(input)) {
    return std::nullopt;
  }

  const size_t separator = input.find_first_of("/?#");
  const size_t colon = input.find(':');
  const bool has_explicit_scheme =
      colon != std::string::npos &&
      (separator == std::string::npos || colon < separator);
  if (has_explicit_scheme) return safe_user_browser_url(input);

  const bool has_whitespace = std::any_of(
      input.begin(), input.end(), [](unsigned char character) {
        return std::isspace(character) != 0;
      });
  const bool looks_like_loopback =
      input.starts_with("localhost") || input.starts_with("127.") ||
      input.starts_with("[::1]");
  const bool looks_like_host = looks_like_loopback ||
                               input.find('.') != std::string::npos;
  if (looks_like_host && !has_whitespace) {
    return safe_user_browser_url(
        std::string(looks_like_loopback ? "http://" : "https://") + input);
  }

  const std::string query = CefURIEncode(input, false).ToString();
  return safe_user_browser_url("https://www.google.com/search?q=" + query);
}

class KestrelRendererSchemeFactory final : public CefSchemeHandlerFactory {
 public:
  explicit KestrelRendererSchemeFactory(std::string resource_root)
      : resource_root_(std::move(resource_root)) {}

  CefRefPtr<CefResourceHandler> Create(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      const CefString& scheme_name,
      CefRefPtr<CefRequest> request) override {
    CefURLParts parts;
    if (!request || !CefParseURL(request->GetURL(), parts) ||
        CefString(&parts.host).ToString() != "app") {
      return nullptr;
    }
    std::string path = CefString(&parts.path).ToString();
    if (path.empty() || path == "/") path = "/index.html";
    if (path.front() != '/') return nullptr;
    const std::string relative_path = path.substr(1);
    if (!is_allowed_path(relative_path)) return nullptr;
    const std::string file_path = resource_root_ + "/" + relative_path;
    CefRefPtr<CefStreamReader> stream =
        CefStreamReader::CreateForFile(file_path);
    if (!stream) return nullptr;

    const size_t extension_start = relative_path.rfind('.');
    CefString mime_type =
        extension_start == std::string::npos
            ? CefString()
            : CefGetMimeType(relative_path.substr(extension_start + 1));
    if (mime_type.empty()) mime_type = "application/octet-stream";
    CefResponse::HeaderMap headers;
    headers.insert({"Cross-Origin-Resource-Policy", "same-origin"});
    headers.insert({"X-Content-Type-Options", "nosniff"});
    return new CefStreamResourceHandler(
        200, "OK", mime_type, headers, stream);
  }

 private:
  static bool is_allowed_path(const std::string& path) {
    if (path.empty() || path.size() > 4 * 1024 ||
        path.find("..") != std::string::npos) {
      return false;
    }
    for (const unsigned char character : path) {
      if (!(std::isalnum(character) || character == '/' ||
            character == '.' || character == '-' || character == '_')) {
        return false;
      }
    }
    return true;
  }

  std::string resource_root_;

  IMPLEMENT_REFCOUNTING(KestrelRendererSchemeFactory);
};

CefRefPtr<KestrelRendererSchemeFactory> renderer_scheme_factory;

bool register_renderer_scheme() {
  if (!full_renderer_enabled) return true;
  renderer_scheme_factory =
      new KestrelRendererSchemeFactory(renderer_resource_root);
  return CefRegisterSchemeHandlerFactory(
      "kestrel", "app", renderer_scheme_factory);
}

// Kestrel owns its browser chrome in the React renderer. Alloy BrowserViews
// keep CEF in content-runtime mode, which supports multiple sibling views in
// one native window and avoids bringing Chrome's own profile UI/services along
// for the ride.
class KestrelAlloyBrowserViewDelegate final : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_ALLOY;
  }

 private:
  IMPLEMENT_REFCOUNTING(KestrelAlloyBrowserViewDelegate);
};

class KestrelClient;
KestrelClient* client_instance = nullptr;
void schedule_close_after_ready();
void post_bridge_teardown(CefRefPtr<KestrelClient> client);
void post_bridge_router_release(CefRefPtr<KestrelClient> client);
void post_core_relay_line(CefRefPtr<KestrelClient> client, std::string line);
void post_core_relay_termination(CefRefPtr<KestrelClient> client);
void post_user_browser_close_cleanup(CefRefPtr<KestrelClient> client);
void post_user_browser_creation(
    CefRefPtr<KestrelClient> client,
    std::string input,
    bool active,
    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback);

// A request context is created asynchronously. In particular, CEF 152 will
// return a context object before it is ready to create a BrowserView. Keep the
// native browser profile lazy, but wait for this callback before attaching the
// first user tab to the window.
class KestrelUserBrowserContextHandler final : public CefRequestContextHandler {
 public:
  using ContextInitialized =
      std::function<void(CefRefPtr<CefRequestContext> request_context)>;

  explicit KestrelUserBrowserContextHandler(ContextInitialized on_initialized)
      : on_initialized_(std::move(on_initialized)) {}

  void OnRequestContextInitialized(
      CefRefPtr<CefRequestContext> request_context) override {
    if (on_initialized_) on_initialized_(request_context);
  }

 private:
  ContextInitialized on_initialized_;

  IMPLEMENT_REFCOUNTING(KestrelUserBrowserContextHandler);
};

// User pages deliberately use a different client from the privileged Kestrel
// UI. It owns no renderer bridge, rejects non-HTTP(S) top-level navigation,
// and blocks popup routing until the native popup/adoption path is migrated.
class KestrelUserBrowserClient final : public CefClient,
                                       public CefLifeSpanHandler,
                                       public CefLoadHandler,
                                       public CefDisplayHandler,
                                       public CefRequestHandler {
 public:
  using BrowserCreated = std::function<void(const std::string&,
                                            CefRefPtr<CefBrowser>)>;
  using LoadingChanged = std::function<void(const std::string&, bool, bool,
                                            bool)>;
  using StringChanged =
      std::function<void(const std::string&, const std::string&)>;
  using NavigationBlocked = std::function<void(const std::string&)>;
  using BrowserClosed = std::function<void(const std::string&, int)>;

  KestrelUserBrowserClient(std::string tab_id, BrowserCreated on_created,
                           LoadingChanged on_loading,
                           StringChanged on_address,
                           StringChanged on_title,
                           StringChanged on_load_end,
                           NavigationBlocked on_navigation_blocked,
                           BrowserClosed on_closed)
      : tab_id_(std::move(tab_id)),
        on_created_(std::move(on_created)),
        on_loading_(std::move(on_loading)),
        on_address_(std::move(on_address)),
        on_title_(std::move(on_title)),
        on_load_end_(std::move(on_load_end)),
        on_navigation_blocked_(std::move(on_navigation_blocked)),
        on_closed_(std::move(on_closed)) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    if (on_created_) on_created_(tab_id_, browser);
  }

  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                     CefRefPtr<CefFrame> frame,
                     int popup_id,
                     const CefString& target_url,
                     const CefString& target_frame_name,
                     WindowOpenDisposition target_disposition,
                     bool user_gesture,
                     const CefPopupFeatures& popup_features,
                     CefWindowInfo& window_info,
                     CefRefPtr<CefClient>& client,
                     CefBrowserSettings& settings,
                     CefRefPtr<CefDictionaryValue>& extra_info,
                     bool* no_javascript_access) override {
    // Do not silently fall back to a CEF popup that would lose the intended
    // opener/context semantics. The existing Electron popup behavior is not
    // claimed as migrated until native adoption is implemented explicitly.
    return true;
  }

  void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                            bool is_loading,
                            bool can_go_back,
                            bool can_go_forward) override {
    if (on_loading_)
      on_loading_(tab_id_, is_loading, can_go_back, can_go_forward);
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int http_status_code) override {
    if (!frame || !frame->IsMain() || !on_load_end_) return;
    on_load_end_(tab_id_, frame->GetURL().ToString());
  }

  void OnAddressChange(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       const CefString& url) override {
    if (!frame || !frame->IsMain() || !on_address_) return;
    const auto safe_url = safe_user_browser_url(url.ToString());
    if (safe_url) on_address_(tab_id_, *safe_url);
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override {
    if (on_title_)
      on_title_(tab_id_, renderer_safe_text(title.ToString(), 500));
  }

  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                      CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request,
                      bool user_gesture,
                      bool is_redirect) override {
    if (!frame || !frame->IsMain() || !request) return false;
    if (safe_user_browser_url(request->GetURL().ToString())) return false;
    if (on_navigation_blocked_) on_navigation_blocked_(tab_id_);
    return true;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    if (on_closed_) on_closed_(tab_id_, browser ? browser->GetIdentifier() : 0);
  }

 private:
  std::string tab_id_;
  BrowserCreated on_created_;
  LoadingChanged on_loading_;
  StringChanged on_address_;
  StringChanged on_title_;
  StringChanged on_load_end_;
  NavigationBlocked on_navigation_blocked_;
  BrowserClosed on_closed_;

  IMPLEMENT_REFCOUNTING(KestrelUserBrowserClient);
};

struct NativeUserBrowserTab {
  std::string id;
  std::string title;
  std::string url;
  std::string created_at;
  std::string last_active_at;
  std::string error;
  bool loading = false;
  bool can_go_back = false;
  bool can_go_forward = false;
  bool discarded = false;
  bool crashed = false;
  bool closing = false;
  bool browser_closed = false;
  int browser_id = 0;
  CefRefPtr<KestrelUserBrowserClient> client;
  CefRefPtr<CefBrowserView> view;
};

class KestrelBridgeQueryHandler final
    : public CefMessageRouterBrowserSide::Handler {
 public:
  using CoreRequestDispatcher = std::function<void(
      const std::string& request,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback)>;
  using HostRequestDispatcher = std::function<bool(
      CefRefPtr<CefDictionaryValue> request,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback)>;

  KestrelBridgeQueryHandler(std::string allowed_shell_url,
                            HostRequestDispatcher host_request_dispatcher,
                            CoreRequestDispatcher core_request_dispatcher)
      : allowed_shell_url_(std::move(allowed_shell_url)),
        host_request_dispatcher_(std::move(host_request_dispatcher)),
        core_request_dispatcher_(std::move(core_request_dispatcher)) {}

  bool OnQuery(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      int64_t query_id,
      const CefString& request,
      bool persistent,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) override {
    if (!frame || !frame->IsMain() ||
        frame->GetURL().ToString() != allowed_shell_url_) {
      callback->Failure(403, "Kestrel native bridge rejects this document.");
      return true;
    }
    if (request.length() > 256 * 1024) {
      callback->Failure(413, "Kestrel native bridge request was too large.");
      return true;
    }
    if (!bridge_ready_logged_) {
      bridge_ready_logged_ = true;
      std::cout << "KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY"
                << std::endl;
    }
    CefRefPtr<CefValue> envelope =
        CefParseJSON(request, JSON_PARSER_RFC);
    if (!envelope || envelope->GetType() != VTYPE_DICTIONARY) {
      callback->Failure(400, "Kestrel native bridge request was invalid.");
      return true;
    }
    CefRefPtr<CefDictionaryValue> value = envelope->GetDictionary();
    const std::string kind = value->GetString("kind").ToString();
    if (kind == "subscribe") {
      const std::string channel = value->GetString("channel").ToString();
      if (!persistent || !is_allowed_channel(channel)) {
        callback->Failure(400, "Kestrel native bridge subscription was invalid.");
        return true;
      }
      subscriptions_.emplace(
          query_id,
          Subscription{channel, callback});
      return true;
    }
    if (kind != "request" || persistent) {
      callback->Failure(400, "Kestrel native bridge envelope was invalid.");
      return true;
    }
    CefRefPtr<CefDictionaryValue> bridge_request =
        value->GetDictionary("request");
    if (!bridge_request ||
        bridge_request->GetType("type") != VTYPE_STRING) {
      callback->Failure(400, "Kestrel native bridge command was invalid.");
      return true;
    }
    if (bridge_request->GetString("type").ToString() ==
        "native-host-status") {
      callback->Success(
          R"JSON({"ok":true,"host":"chromium-cef","profile":"isolated","credentialStorage":"disabled","core":"ephemeral-or-unavailable","browser":"native-cef-in-memory-tabs"})JSON");
      std::cout << "KESTREL_NATIVE_CHROMIUM_BRIDGE_REQUEST_OK"
                << std::endl;
      return true;
    }
    if (host_request_dispatcher_ &&
        host_request_dispatcher_(bridge_request->Copy(false), callback)) {
      return true;
    }
    CefRefPtr<CefValue> core_request = CefValue::Create();
    if (!core_request->SetDictionary(bridge_request->Copy(false))) {
      callback->Failure(500, "Kestrel native bridge could not serialize the command.");
      return true;
    }
    const CefString serialized =
        CefWriteJSON(core_request, JSON_WRITER_DEFAULT);
    if (serialized.empty()) {
      callback->Failure(500, "Kestrel native bridge could not encode the command.");
      return true;
    }
    core_request_dispatcher_(serialized.ToString(), callback);
    return true;
  }

  void OnQueryCanceled(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       int64_t query_id) override {
    subscriptions_.erase(query_id);
  }

  void Publish(const std::string& channel, const std::string& event) {
    for (const auto& [query_id, subscription] : subscriptions_) {
      if (subscription.channel == channel) {
        subscription.callback->Success(event);
      }
    }
  }

 private:
  struct Subscription {
    std::string channel;
    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback;
  };

  static bool is_allowed_channel(const std::string& channel) {
    return channel == "browser-event" || channel == "window-focus" ||
           channel == "password-prompt" || channel == "payment-prompt" ||
           channel == "browser-command" || channel == "deep-link" ||
           channel == "external-intake" || channel == "snapshot" ||
           channel == "pet-status" || channel == "pet-activity" ||
           channel == "runtime-event" || channel == "agent-stream" ||
           channel == "local-runtime-progress";
  }

  std::string allowed_shell_url_;
  HostRequestDispatcher host_request_dispatcher_;
  CoreRequestDispatcher core_request_dispatcher_;
  std::map<int64_t, Subscription> subscriptions_;
  bool bridge_ready_logged_ = false;
};

class KestrelClient : public CefClient,
                      public CefLifeSpanHandler,
                      public CefLoadHandler,
                      public CefRequestHandler {
 public:
  KestrelClient(std::string allowed_shell_url,
                NSString* isolated_profile_root,
                bool enable_ephemeral_core)
      : bridge_handler_(
            std::make_unique<KestrelBridgeQueryHandler>(
                std::move(allowed_shell_url),
                [this](
                    CefRefPtr<CefDictionaryValue> request,
                    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
                  return DispatchNativeHostRequest(request, callback);
                },
                [this](
                    const std::string& request,
                    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
                  DispatchCoreRequest(request, callback);
        })) {
    client_instance = this;
    bridge_router_ =
        CefMessageRouterBrowserSide::Create(KestrelBridgeRouterConfig());
    if (isolated_profile_root) {
      isolated_profile_root_ =
          std::string([isolated_profile_root fileSystemRepresentation] ?: "");
      user_browser_cache_path_ = isolated_profile_root_ + "/user-browser";
    }
    CreateBlankUserBrowserTab(true);
    if (!bridge_router_ ||
        !bridge_router_->AddHandler(bridge_handler_.get(), true)) {
      std::cerr << "Kestrel could not initialize its native Chromium bridge."
                << std::endl;
    }
    if (enable_ephemeral_core) {
      StartEphemeralCore(isolated_profile_root);
    }
  }
  ~KestrelClient() override {
    if (native_owner_alive_) *native_owner_alive_ = false;
    // CEF has already started releasing the BrowserView graph by the time the
    // owning client is destructed. Do not mutate that graph here: CEF 152
    // correctly rejects retaining or releasing an object while its destructor
    // is active. BrowserView teardown happens in DoClose(), while the top-level
    // window is still valid.
    StopCoreRelay();
    client_instance = nullptr;
  }

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    browser_ = browser;
  }

  bool DoClose(CefRefPtr<CefBrowser> browser) override {
    if (!closing_) {
      closing_ = true;
      std::cout << "KESTREL_NATIVE_CHROMIUM_MAIN_CLOSE_BEGIN" << std::endl;
      if (native_owner_alive_) *native_owner_alive_ = false;
      // The CEF Views hierarchy owns sibling BrowserViews. Let top-level
      // window teardown close them in the framework's ordering, and delay
      // CefShutdown until each user browser reports OnBeforeClose.
      for (NativeUserBrowserTab& tab : user_browser_tabs_) {
        CefRefPtr<CefBrowser> user_browser =
            tab.view ? tab.view->GetBrowser() : nullptr;
        if (user_browser && user_browser->IsValid()) {
          tab.closing = true;
          pending_user_browser_closures_.insert(tab.id);
        }
      }
    }
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    if (native_owner_alive_) *native_owner_alive_ = false;
    StopCoreRelay();
    ShutdownBridge(browser);
    // The router has canceled all bridge queries for this closing document.
    // Drop the Core relay's retained callback references without trying to
    // complete them after cancellation. Retaining them into router teardown
    // can release the router from inside its own destructor on CEF 152.
    DiscardPendingCoreRequests();
    browser_ = nullptr;
    main_browser_closed_ = true;
    std::cout << "KESTREL_NATIVE_CHROMIUM_MAIN_CLOSE_READY pending_tabs="
              << pending_user_browser_closures_.size() << std::endl;
    MaybeQuitMessageLoop();
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int http_status_code) override {
    if (!frame || !frame->IsMain() || host_ready_logged_) {
      return;
    }
    host_ready_logged_ = true;
    const CefRefPtr<CefCommandLine> command_line =
        CefCommandLine::GetGlobalCommandLine();
    std::cout << "KESTREL_NATIVE_CHROMIUM_HOST_READY pid=" << getpid()
              << " credential_storage="
              << (command_line && command_line->HasSwitch("use-mock-keychain")
                      ? "disabled"
                      : "unsafe")
              << " background_networking="
              << (command_line &&
                          command_line->HasSwitch("disable-background-networking")
                      ? "disabled"
                      : "enabled")
              << std::endl;
    if (smoke_user_browser_url && !smoke_user_browser_via_bridge &&
        !smoke_user_browser_started_) {
      smoke_user_browser_started_ = true;
      std::string error;
      if (!CreateUserBrowserTab(*smoke_user_browser_url, true, &error)) {
        std::cerr << "Kestrel native user-browser smoke setup failed: "
                  << error << std::endl;
      }
    }
    schedule_close_after_ready();
  }

  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                      CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request,
                      bool user_gesture,
                      bool is_redirect) override {
    if (request->GetURL().ToString() != shell_url) {
      // The bridge is only made available to this bundled local document.
      // Reject all navigation, including subframes, until a trusted browser
      // runtime owns a separate profile and permission policy.
      return true;
    }
    if (bridge_router_) {
      bridge_router_->OnBeforeBrowse(browser, frame);
    }
    return false;
  }

  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    return bridge_router_ &&
           bridge_router_->OnProcessMessageReceived(
               browser, frame, source_process, message);
  }

  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                 TerminationStatus status,
                                 int error_code,
                                 const CefString& error_string) override {
    if (bridge_router_) {
      bridge_router_->OnRenderProcessTerminated(browser);
    }
  }

  bool IsClosing() const { return closing_; }

  void CloseBrowser() {
    if (browser_ && !closing_) {
      browser_->GetHost()->CloseBrowser(false);
    }
  }

  void OnCoreRelayLine(const std::string& line) {
    CefRefPtr<CefValue> message = CefParseJSON(line, JSON_PARSER_RFC);
    if (!message || message->GetType() != VTYPE_DICTIONARY) {
      FailPendingCoreRequests("Kestrel native Core sent an invalid response.");
      return;
    }
    CefRefPtr<CefDictionaryValue> value = message->GetDictionary();
    const std::string type = value->GetString("type").ToString();
    if (type == "ready") {
      core_ready_ = true;
      std::cout << "KESTREL_NATIVE_CHROMIUM_CORE_READY" << std::endl;
      FlushQueuedCoreRequests();
      return;
    }
    if (type == "response") {
      const std::string id = value->GetString("id").ToString();
      auto pending = core_requests_.find(id);
      if (pending == core_requests_.end()) return;
      CefRefPtr<CefValue> response = value->GetValue("response");
      const CefString serialized =
          // CefWriteJSON takes ownership of its input value. The parsed relay
          // envelope still owns this child, so serialize a copy rather than
          // invalidating a value the envelope may release afterwards.
          response ? CefWriteJSON(response->Copy(), JSON_WRITER_DEFAULT)
                   : CefString();
      if (serialized.empty()) {
        pending->second.callback->Success(
            R"JSON({"ok":false,"error":"Kestrel native Core returned an invalid response."})JSON");
      } else {
        pending->second.callback->Success(serialized);
        if (pending->second.is_snapshot) {
          std::cout << "KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK"
                    << std::endl;
        }
      }
      core_requests_.erase(pending);
      return;
    }
    if (type == "event") {
      const std::string channel = value->GetString("channel").ToString();
      CefRefPtr<CefValue> event = value->GetValue("event");
      const CefString serialized =
          event ? CefWriteJSON(event->Copy(), JSON_WRITER_DEFAULT)
                : CefString();
      if (!channel.empty() && !serialized.empty() && bridge_handler_) {
        bridge_handler_->Publish(channel, serialized.ToString());
      }
      return;
    }
    if (type == "start-error" || type == "core-exit" ||
        type == "protocol-error") {
      core_ready_ = false;
      FailPendingCoreRequests("Kestrel native Core is unavailable.");
    }
  }

  void OnCoreRelayTerminated() {
    core_ready_ = false;
    FailPendingCoreRequests("Kestrel native Core stopped unexpectedly.");
  }

  // Called from a UI task only after a user BrowserView's OnBeforeClose
  // callback has returned. Releasing its CEF client inside that callback can
  // destroy the callback receiver re-entrantly.
  void FinalizeClosedUserBrowserTabs() {
    closed_tab_cleanup_scheduled_ = false;
    if (closing_) {
      for (NativeUserBrowserTab& tab : user_browser_tabs_) {
        if (!tab.browser_closed) continue;
        tab.view = nullptr;
        tab.client = nullptr;
        tab.browser_id = 0;
      }
      MaybeQuitMessageLoop();
      return;
    }
    user_browser_tabs_.erase(
        std::remove_if(user_browser_tabs_.begin(), user_browser_tabs_.end(),
                       [](const NativeUserBrowserTab& tab) {
                         return tab.browser_closed;
                       }),
        user_browser_tabs_.end());
    if (user_browser_tabs_.empty()) CreateBlankUserBrowserTab(true);
    if (!FindUserBrowserTab(user_browser_active_tab_id_)) {
      user_browser_active_tab_id_ = user_browser_tabs_.front().id;
    }
    SyncUserBrowserViewVisibility();
    PublishUserBrowserState();
  }

  // The only safe point to discard BrowserView and CefClient references during
  // app termination is after every browser's OnBeforeClose callback and after
  // the CEF message loop has returned. main() invokes this immediately before
  // releasing the final KestrelClient owner and calling CefShutdown().
  void FinalizeUserBrowserShutdown() {
    for (NativeUserBrowserTab& tab : user_browser_tabs_) {
      tab.view = nullptr;
      tab.client = nullptr;
      tab.browser_id = 0;
    }
    user_browser_tabs_.clear();
    pending_user_browser_closures_.clear();
    user_browser_context_handler_ = nullptr;
    user_browser_context_ = nullptr;
    user_browser_context_initializing_ = false;
    user_browser_context_ready_ = false;
  }

  // Remove the bridge handler and release the router from a trailing UI task.
  // CEF's message-router callbacks post their completion work back to this
  // queue. Waiting until every browser close callback has returned lets that
  // work drain before the router and its handler are destroyed.
  void FinalizeBridgeTeardown() {
    bridge_teardown_scheduled_ = false;
    if (!closing_ || !main_browser_closed_ ||
        closed_tab_cleanup_scheduled_ ||
        !pending_user_browser_closures_.empty()) {
      return;
    }
    if (bridge_router_) {
      if (bridge_handler_) {
        bridge_router_->RemoveHandler(bridge_handler_.get());
        bridge_handler_.reset();
      }
      // Let the handler-removal cancellation and any already-posted router
      // callback tasks finish before releasing the router itself. Keeping this
      // as a separate UI task avoids releasing a callback-owned router from
      // inside the router's own cancellation stack on CEF 152.
      if (!bridge_router_release_scheduled_) {
        bridge_router_release_scheduled_ = true;
        post_bridge_router_release(CefRefPtr<KestrelClient>(this));
      }
      return;
    }
    FinalizeBridgeRouterRelease();
  }

  void FinalizeBridgeRouterRelease() {
    bridge_router_release_scheduled_ = false;
    if (!closing_ || !main_browser_closed_ ||
        closed_tab_cleanup_scheduled_ ||
        !pending_user_browser_closures_.empty()) {
      return;
    }
    bridge_router_ = nullptr;
    bridge_teardown_complete_ = true;
    std::cout << "KESTREL_NATIVE_CHROMIUM_BRIDGE_TEARDOWN_COMPLETE"
              << std::endl;
    MaybeQuitMessageLoop();
  }

  // BrowserView creation changes CEF's native view hierarchy. A renderer
  // bridge query is itself dispatched from the CEF UI thread, so create the
  // view in a follow-up task rather than nesting native view creation inside
  // the message-router callback.
  void CompleteCreateUserBrowserTab(
      std::string input,
      bool active,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
    if (!callback || closing_) return;
    std::string error;
    if (!CreateUserBrowserTab(input, active, &error)) {
      RespondNativeError(callback, error);
      return;
    }
    SyncUserBrowserViewVisibility();
    RespondWithBrowserState(callback);
    std::cout << "KESTREL_NATIVE_CHROMIUM_BRIDGE_BROWSER_REQUEST_OK"
              << std::endl;
    PublishUserBrowserState();
  }

 private:
  struct PendingCoreRequest {
    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback;
    bool is_snapshot;
  };

  struct QueuedCoreRequest {
    std::string request;
    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback;
  };

  using BridgeCallback = CefRefPtr<CefMessageRouterBrowserSide::Callback>;

  NativeUserBrowserTab* FindUserBrowserTab(const std::string& tab_id) {
    const auto found = std::find_if(
        user_browser_tabs_.begin(), user_browser_tabs_.end(),
        [&tab_id](const NativeUserBrowserTab& tab) { return tab.id == tab_id; });
    return found == user_browser_tabs_.end() ? nullptr : &*found;
  }

  NativeUserBrowserTab& CreateBlankUserBrowserTab(bool active) {
    const std::string timestamp = iso8601_now();
    NativeUserBrowserTab tab;
    tab.id = "tab-" + native_uuid();
    tab.title = "New Tab";
    tab.created_at = timestamp;
    tab.last_active_at = timestamp;
    user_browser_tabs_.push_back(std::move(tab));
    if (active || user_browser_active_tab_id_.empty()) {
      user_browser_active_tab_id_ = user_browser_tabs_.back().id;
    }
    return user_browser_tabs_.back();
  }

  std::string SerializeUserBrowserState() const {
    CefRefPtr<CefDictionaryValue> state = CefDictionaryValue::Create();
    CefRefPtr<CefListValue> tabs = CefListValue::Create();
    size_t tab_count = 0;
    for (const NativeUserBrowserTab& tab : user_browser_tabs_) {
      if (!tab.closing) ++tab_count;
    }
    tabs->SetSize(tab_count);
    size_t state_index = 0;
    for (const NativeUserBrowserTab& tab : user_browser_tabs_) {
      if (tab.closing) continue;
      CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
      item->SetString("id", tab.id);
      item->SetString("title", tab.title);
      item->SetString("url", tab.url);
      item->SetBool("loading", tab.loading);
      item->SetBool("canGoBack", tab.can_go_back);
      item->SetBool("canGoForward", tab.can_go_forward);
      item->SetBool("discarded", tab.discarded);
      item->SetBool("crashed", tab.crashed);
      item->SetBool("pinned", false);
      item->SetBool("muted", false);
      item->SetString("createdAt", tab.created_at);
      item->SetString("lastActiveAt", tab.last_active_at);
      if (!tab.error.empty()) item->SetString("error", tab.error);
      tabs->SetDictionary(state_index++, item);
    }
    state->SetList("tabs", tabs);
    state->SetList("tabFolders", CefListValue::Create());
    if (user_browser_active_tab_id_.empty()) {
      state->SetNull("activeTabId");
    } else {
      state->SetString("activeTabId", user_browser_active_tab_id_);
    }
    state->SetList("history", CefListValue::Create());
    state->SetList("originFavicons", CefListValue::Create());
    state->SetList("downloads", CefListValue::Create());
    state->SetList("bookmarks", CefListValue::Create());
    state->SetList("bookmarkFolders", CefListValue::Create());
    state->SetList("recentlyClosedTabs", CefListValue::Create());
    state->SetList("sitePermissions", CefListValue::Create());

    // Keep the first native browser pass honest: these are the same visible
    // defaults as a new Kestrel browser profile, held only in memory until a
    // separately reviewed profile migration exists.
    CefRefPtr<CefDictionaryValue> settings = CefDictionaryValue::Create();
    settings->SetString("startupBehavior", "new_tab");
    settings->SetString("homepageUrl", "");
    settings->SetList("startupPages", CefListValue::Create());
    settings->SetString("searchEngine", "google");
    settings->SetString("tabLayout", "horizontal");
    settings->SetString("tabSizing", "scrolling");
    settings->SetString("newTabBackground", "graphite");
    CefRefPtr<CefDictionaryValue> greeting = CefDictionaryValue::Create();
    greeting->SetInt("version", 1);
    greeting->SetList("days", CefListValue::Create());
    settings->SetDictionary("newTabGreetingActivity", greeting);
    CefRefPtr<CefDictionaryValue> widgets = CefDictionaryValue::Create();
    widgets->SetInt("version", 1);
    CefRefPtr<CefListValue> widget_ids = CefListValue::Create();
    widget_ids->SetSize(4);
    widget_ids->SetString(0, "frequent-tabs");
    widget_ids->SetString(1, "recent-work");
    widget_ids->SetString(2, "recent-memories");
    widget_ids->SetString(3, "quick-actions");
    widgets->SetList("enabled", widget_ids);
    widgets->SetDictionary("layouts", CefDictionaryValue::Create());
    settings->SetDictionary("newTabWidgets", widgets);
    settings->SetBool("restoreSession", true);
    settings->SetInt("historyRetentionDays", 90);
    settings->SetBool("sleepingTabsEnabled", true);
    settings->SetInt("sleepingTabTimeoutMinutes", 30);
    settings->SetList("sleepingTabExcludedDomains", CefListValue::Create());
    settings->SetBool("memorySaverMode", true);
    settings->SetBool("showBookmarksBar", true);
    settings->SetBool("addressBarSuggestionsEnabled", true);
    settings->SetBool("passwordAutofillEnabled", true);
    settings->SetBool("offerToSavePasswords", true);
    settings->SetBool("autofillPasswords", true);
    settings->SetBool("autofillUsernames", true);
    settings->SetBool("offerStrongPasswords", true);
    settings->SetList("neverSavePasswordOrigins", CefListValue::Create());
    settings->SetBool("paymentAutofillEnabled", true);
    settings->SetInt("defaultZoomPercent", 100);
    settings->SetInt("minimumFontSize", 0);
    settings->SetString("defaultFontFamily", "system-ui");
    settings->SetBool("spellcheckEnabled", true);
    settings->SetString("spellcheckLanguage", "en-US");
    settings->SetBool("hardwareAccelerationEnabled", true);
    settings->SetString("downloadBehavior", "automatic");
    settings->SetString("downloadDirectory", "");
    state->SetDictionary("settings", settings);

    CefRefPtr<CefValue> root = CefValue::Create();
    if (!root->SetDictionary(state)) return "";
    return CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
  }

  std::string BrowserStateResponse() const {
    const std::string state = SerializeUserBrowserState();
    if (state.empty()) {
      return R"JSON({"ok":false,"error":"Kestrel could not serialize the native browser state."})JSON";
    }
    return "{\"ok\":true,\"browserState\":" + state + "}";
  }

  void PublishUserBrowserState() {
    if (!bridge_handler_) return;
    const std::string state = SerializeUserBrowserState();
    if (!state.empty()) {
      bridge_handler_->Publish("browser-event",
                               "{\"type\":\"state\",\"state\":" + state +
                                   "}");
    }
  }

  void RespondWithBrowserState(BridgeCallback callback) {
    callback->Success(BrowserStateResponse());
  }

  void RespondNativeError(BridgeCallback callback, const std::string& error) {
    callback->Success("{\"ok\":false,\"error\":\"" + error + "\"}");
  }

  void ShutdownBridge(CefRefPtr<CefBrowser> browser) {
    if (!bridge_router_ || bridge_shutdown_pending_) return;
    // This call is required by CEF's router contract. It cancels queries for
    // the closing main browser. The router itself remains alive until the
    // native message loop has completely exited.
    bridge_router_->OnBeforeClose(browser);
    bridge_shutdown_pending_ = true;
  }

  void MaybeQuitMessageLoop() {
    if (main_browser_closed_ && !closed_tab_cleanup_scheduled_ &&
        pending_user_browser_closures_.empty()) {
      if (!bridge_teardown_complete_) {
        if (!bridge_teardown_scheduled_) {
          bridge_teardown_scheduled_ = true;
          std::cout << "KESTREL_NATIVE_CHROMIUM_BRIDGE_TEARDOWN_SCHEDULED"
                    << std::endl;
          post_bridge_teardown(CefRefPtr<KestrelClient>(this));
        }
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_MAIN_CLOSE_COMPLETE" << std::endl;
      CefQuitMessageLoop();
    }
  }

  void ScheduleClosedUserBrowserCleanup() {
    if (closed_tab_cleanup_scheduled_) return;
    closed_tab_cleanup_scheduled_ = true;
    post_user_browser_close_cleanup(CefRefPtr<KestrelClient>(this));
  }

  void SyncUserBrowserViewVisibility() {
    for (NativeUserBrowserTab& tab : user_browser_tabs_) {
      if (!tab.view) continue;
      tab.view->SetBounds(user_browser_bounds_);
      tab.view->SetVisible(!tab.closing && user_browser_view_visible_ &&
                           tab.id == user_browser_active_tab_id_ &&
                           !tab.url.empty());
    }
  }

  void CloseUserBrowserView(NativeUserBrowserTab& tab) {
    if (tab.closing) return;
    tab.closing = true;
    tab.loading = false;
    if (!tab.view) return;
    tab.view->SetVisible(false);
    CefRefPtr<CefBrowser> browser = tab.view->GetBrowser();
    const bool browser_is_live = browser && browser->IsValid();
    if (browser_is_live) {
      pending_user_browser_closures_.insert(tab.id);
      std::cout << "KESTREL_NATIVE_CHROMIUM_USER_BROWSER_CLOSE_BEGIN tab="
                << tab.id << std::endl;
      browser->GetHost()->CloseBrowser(true);
    }
    if (kestrel_window && !kestrel_window->IsClosed()) {
      kestrel_window->RemoveChildView(tab.view);
    }
    // Keep the CEF references until the user browser's OnBeforeClose callback.
    // The top-level host must not quit while that callback is still pending.
    if (!browser_is_live) {
      tab.view = nullptr;
      tab.client = nullptr;
      tab.browser_id = 0;
      tab.browser_closed = true;
    }
  }

  void CloseAllUserBrowserViews() {
    for (NativeUserBrowserTab& tab : user_browser_tabs_) {
      CloseUserBrowserView(tab);
    }
  }

  bool EnsureUserBrowserContext(std::string* error) {
    if (user_browser_context_ || user_browser_context_initializing_) return true;
    if (isolated_profile_root_.empty()) {
      if (error) {
        *error = "The isolated native browser profile is unavailable.";
      }
      return false;
    }

    CefRequestContextSettings user_browser_settings;
    CefString(&user_browser_settings.cache_path) = user_browser_cache_path_;
    // Do not start a second Chromium storage context until someone explicitly
    // opens a native browser tab. Its session remains transient while profile
    // migration and credential storage stay deferred by user choice.
    user_browser_settings.persist_session_cookies = false;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    user_browser_context_initializing_ = true;
    user_browser_context_handler_ = new KestrelUserBrowserContextHandler(
        [this, owner_token](CefRefPtr<CefRequestContext> request_context) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnUserBrowserContextInitialized(request_context);
        });
    user_browser_context_ =
        CefRequestContext::CreateContext(user_browser_settings,
                                         user_browser_context_handler_);
    if (user_browser_context_) return true;
    user_browser_context_handler_ = nullptr;
    user_browser_context_initializing_ = false;
    if (error) {
      *error = "The isolated native browser context is unavailable.";
    }
    return false;
  }

  void OnUserBrowserContextInitialized(
      CefRefPtr<CefRequestContext> request_context) {
    if (!request_context || closing_) return;
    if (user_browser_context_ &&
        !user_browser_context_->IsSame(request_context)) {
      return;
    }
    user_browser_context_ = request_context;
    user_browser_context_initializing_ = false;
    user_browser_context_ready_ = true;

    bool browser_creation_failed = false;
    for (NativeUserBrowserTab& tab : user_browser_tabs_) {
      if (tab.closing || tab.url.empty() || tab.view) continue;
      std::string error;
      if (!EnsureLiveUserBrowser(tab, &error)) {
        tab.loading = false;
        tab.error = error.empty()
                        ? "Kestrel could not create the native Chromium tab."
                        : error;
        browser_creation_failed = true;
      }
    }
    SyncUserBrowserViewVisibility();
    if (browser_creation_failed || !user_browser_tabs_.empty()) {
      PublishUserBrowserState();
    }
  }

  bool EnsureLiveUserBrowser(NativeUserBrowserTab& tab,
                             std::string* error) {
    if (tab.url.empty()) return true;
    if (!EnsureUserBrowserContext(error)) return false;
    // CefRequestContext::CreateContext returns before the profile has finished
    // initializing. The tab remains in the in-memory browser state and is
    // attached by OnUserBrowserContextInitialized(), preserving lazy profile
    // startup without attempting an invalid BrowserView creation.
    if (!user_browser_context_ready_) return true;
    if (!kestrel_window || kestrel_window->IsClosed()) {
      if (error) *error = "The native Kestrel window is unavailable.";
      return false;
    }
    if (tab.view) {
      CefRefPtr<CefBrowser> browser = tab.view->GetBrowser();
      if (browser && browser->IsValid()) {
        browser->GetMainFrame()->LoadURL(tab.url);
      }
      SyncUserBrowserViewVisibility();
      return true;
    }

    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    tab.client = new KestrelUserBrowserClient(
        tab.id,
        [this, owner_token](const std::string& tab_id,
                            CefRefPtr<CefBrowser> browser) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserCreated(tab_id, browser);
        },
        [this, owner_token](const std::string& tab_id, bool loading,
                            bool can_go_back, bool can_go_forward) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserLoadingChanged(tab_id, loading, can_go_back,
                                            can_go_forward);
        },
        [this, owner_token](const std::string& tab_id,
                            const std::string& url) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserAddressChanged(tab_id, url);
        },
        [this, owner_token](const std::string& tab_id,
                            const std::string& title) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserTitleChanged(tab_id, title);
        },
        [this, owner_token](const std::string& tab_id,
                            const std::string& url) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserLoadEnd(tab_id, url);
        },
        [this, owner_token](const std::string& tab_id) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserNavigationBlocked(tab_id);
        },
        [this, owner_token](const std::string& tab_id, int browser_id) {
          // The host intentionally makes all ordinary browser callbacks inert
          // once teardown starts. This lifecycle callback is the exception:
          // it is how the main process waits for every native BrowserView to
          // finish closing before CefShutdown().
          if (!owner_token.lock()) return;
          OnNativeUserBrowserClosed(tab_id, browser_id);
        });
    CefBrowserSettings browser_settings;
    tab.view = CefBrowserView::CreateBrowserView(
        tab.client, tab.url, browser_settings, nullptr, user_browser_context_,
        new KestrelAlloyBrowserViewDelegate());
    if (!tab.view) {
      tab.client = nullptr;
      if (error) *error = "Kestrel could not create the native Chromium tab.";
      return false;
    }
    tab.view->SetBounds(user_browser_bounds_);
    tab.view->SetVisible(false);
    kestrel_window->AddChildView(tab.view);
    SyncUserBrowserViewVisibility();
    return true;
  }

  bool NavigateUserBrowserTab(NativeUserBrowserTab& tab,
                              const std::string& input,
                              std::string* error) {
    const std::optional<std::string> url = normalize_user_browser_input(input);
    if (!url) {
      if (error) *error = "Enter an HTTP(S) address or search.";
      return false;
    }
    tab.url = *url;
    tab.title = "Loading…";
    tab.loading = true;
    tab.discarded = false;
    tab.crashed = false;
    tab.error.clear();
    tab.last_active_at = iso8601_now();
    return EnsureLiveUserBrowser(tab, error);
  }

  bool CreateUserBrowserTab(const std::string& input, bool active,
                            std::string* error) {
    if (input.empty()) {
      CreateBlankUserBrowserTab(active);
      SyncUserBrowserViewVisibility();
      return true;
    }
    const std::optional<std::string> url = normalize_user_browser_input(input);
    if (!url) {
      if (error) *error = "Enter an HTTP(S) address or search.";
      return false;
    }
    NativeUserBrowserTab& tab = CreateBlankUserBrowserTab(active);
    tab.url = *url;
    tab.title = "Loading…";
    tab.loading = true;
    if (!EnsureLiveUserBrowser(tab, error)) {
      const std::string failed_id = tab.id;
      user_browser_tabs_.erase(std::remove_if(user_browser_tabs_.begin(),
                                               user_browser_tabs_.end(),
                                               [&failed_id](const auto& item) {
                                                 return item.id == failed_id;
                                               }),
                               user_browser_tabs_.end());
      if (user_browser_active_tab_id_ == failed_id &&
          !user_browser_tabs_.empty()) {
        user_browser_active_tab_id_ = user_browser_tabs_.front().id;
      }
      return false;
    }
    return true;
  }

  void OnNativeUserBrowserCreated(const std::string& tab_id,
                                  CefRefPtr<CefBrowser> browser) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab || !browser) return;
    tab->browser_id = browser->GetIdentifier();
    SyncUserBrowserViewVisibility();
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserLoadingChanged(const std::string& tab_id,
                                         bool loading,
                                         bool can_go_back,
                                         bool can_go_forward) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->loading = loading;
    tab->can_go_back = can_go_back;
    tab->can_go_forward = can_go_forward;
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserAddressChanged(const std::string& tab_id,
                                         const std::string& url) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->url = url;
    tab->error.clear();
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserTitleChanged(const std::string& tab_id,
                                       const std::string& title) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->title = title;
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserLoadEnd(const std::string& tab_id,
                                  const std::string& url) {
    if (smoke_user_browser_url && url == *smoke_user_browser_url) {
      std::cout << "KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK url=" << url
                << std::endl;
    }
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserClosed(const std::string& tab_id, int browser_id) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (tab) {
      tab->browser_closed = true;
      tab->browser_id = browser_id;
      tab->loading = false;
    }
    pending_user_browser_closures_.erase(tab_id);
    std::cout << "KESTREL_NATIVE_CHROMIUM_USER_BROWSER_CLOSE_READY tab="
              << tab_id << std::endl;
    // Do not release |tab->client| here. This method runs synchronously from
    // that client's OnBeforeClose callback, so release is deferred to a UI
    // task (or to the post-loop shutdown finalizer).
    ScheduleClosedUserBrowserCleanup();
    MaybeQuitMessageLoop();
  }

  void OnNativeUserBrowserNavigationBlocked(const std::string& tab_id) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->loading = false;
    tab->error = "Kestrel blocked a non-HTTP(S) browser navigation.";
    PublishUserBrowserState();
  }

  bool DispatchNativeHostRequest(CefRefPtr<CefDictionaryValue> request,
                                 BridgeCallback callback) {
    if (!request || request->GetType("type") != VTYPE_STRING) return false;
    const std::string type = request->GetString("type").ToString();
    if (type == "window-minimize" || type == "window-toggle-zoom" ||
        type == "window-close") {
      if (!kestrel_window || kestrel_window->IsClosed()) {
        RespondNativeError(callback, "The native Kestrel window is unavailable.");
        return true;
      }
      callback->Success(R"JSON({"ok":true})JSON");
      if (type == "window-minimize") {
        kestrel_window->Minimize();
      } else if (type == "window-toggle-zoom") {
        if (kestrel_window->IsFullscreen()) {
          kestrel_window->SetFullscreen(false);
        } else if (kestrel_window->IsMaximized()) {
          kestrel_window->Restore();
        } else {
          kestrel_window->Maximize();
        }
      } else {
        CloseBrowser();
      }
      return true;
    }

    // These setup-status probes are read-only. Answer them directly with the
    // native host's empty capability state instead of forwarding them to Core
    // (where they are Electron-only requests). This keeps onboarding honest
    // and prompt-free while Keychain, subscription CLI, and local-runtime
    // ownership remain intentionally deferred.
    if (type == "credential-list") {
      callback->Success(R"JSON({"ok":true,"credentials":[]})JSON");
      std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_STATUS_EMPTY"
                << std::endl;
      return true;
    }
    if (type == "subscription-cli-status") {
      callback->Success(R"JSON({"ok":true,"subscriptionClis":[]})JSON");
      std::cout << "KESTREL_NATIVE_CHROMIUM_SUBSCRIPTION_CLI_STATUS_EMPTY"
                << std::endl;
      return true;
    }
    if (type == "local-model-status") {
      const std::string status = native_local_model_status();
      const CefRefPtr<CefValue> parsed = CefParseJSON(status, JSON_PARSER_RFC);
      if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) {
        RespondNativeError(callback,
                           "The native local-model status was invalid.");
        return true;
      }
      callback->Success(status);
      std::cout << "KESTREL_NATIVE_CHROMIUM_LOCAL_MODEL_STATUS_DEFERRED"
                << std::endl;
      return true;
    }

    if (type == "browser-get-state") {
      RespondWithBrowserState(callback);
      return true;
    }
    if (type == "browser-create-tab") {
      if (request->HasKey("input") && request->GetType("input") != VTYPE_STRING) {
        RespondNativeError(callback, "The native browser tab input was invalid.");
        return true;
      }
      if (request->HasKey("active") && request->GetType("active") != VTYPE_BOOL) {
        RespondNativeError(callback, "The native browser tab activation was invalid.");
        return true;
      }
      const std::string input = request->HasKey("input")
                                    ? request->GetString("input").ToString()
                                    : "";
      const bool active = !request->HasKey("active") || request->GetBool("active");
      post_user_browser_creation(CefRefPtr<KestrelClient>(this), input,
                                 active, callback);
      return true;
    }
    if (type == "browser-select-tab") {
      if (request->GetType("tabId") != VTYPE_STRING) {
        RespondNativeError(callback, "The native browser tab was invalid.");
        return true;
      }
      NativeUserBrowserTab* tab =
          FindUserBrowserTab(request->GetString("tabId").ToString());
      if (!tab) {
        RespondNativeError(callback, "The requested native browser tab no longer exists.");
        return true;
      }
      user_browser_active_tab_id_ = tab->id;
      tab->last_active_at = iso8601_now();
      SyncUserBrowserViewVisibility();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-navigate") {
      if (request->GetType("tabId") != VTYPE_STRING ||
          request->GetType("input") != VTYPE_STRING) {
        RespondNativeError(callback, "The native browser navigation was invalid.");
        return true;
      }
      NativeUserBrowserTab* tab =
          FindUserBrowserTab(request->GetString("tabId").ToString());
      if (!tab) {
        RespondNativeError(callback, "The requested native browser tab no longer exists.");
        return true;
      }
      std::string error;
      if (!NavigateUserBrowserTab(*tab, request->GetString("input").ToString(),
                                  &error)) {
        RespondNativeError(callback, error);
        return true;
      }
      SyncUserBrowserViewVisibility();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-close-tab") {
      if (request->GetType("tabId") != VTYPE_STRING) {
        RespondNativeError(callback, "The native browser tab was invalid.");
        return true;
      }
      const std::string tab_id = request->GetString("tabId").ToString();
      const auto found = std::find_if(
          user_browser_tabs_.begin(), user_browser_tabs_.end(),
          [&tab_id](const NativeUserBrowserTab& tab) { return tab.id == tab_id; });
      if (found == user_browser_tabs_.end()) {
        RespondNativeError(callback, "The requested native browser tab no longer exists.");
        return true;
      }
      CloseUserBrowserView(*found);
      const std::string closed_tab_id = found->id;
      const auto next_active = std::find_if(
          user_browser_tabs_.begin(), user_browser_tabs_.end(),
          [&closed_tab_id](const NativeUserBrowserTab& tab) {
            return tab.id != closed_tab_id && !tab.closing;
          });
      if (next_active != user_browser_tabs_.end()) {
        user_browser_active_tab_id_ = next_active->id;
      } else {
        CreateBlankUserBrowserTab(true);
      }
      SyncUserBrowserViewVisibility();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-back" || type == "browser-forward" ||
        type == "browser-reload" || type == "browser-stop") {
      if (request->GetType("tabId") != VTYPE_STRING) {
        RespondNativeError(callback, "The native browser tab was invalid.");
        return true;
      }
      NativeUserBrowserTab* tab =
          FindUserBrowserTab(request->GetString("tabId").ToString());
      CefRefPtr<CefBrowser> browser = tab && tab->view ? tab->view->GetBrowser()
                                                        : nullptr;
      if (!browser || !browser->IsValid()) {
        RespondNativeError(callback, "The native browser page is not loaded yet.");
        return true;
      }
      if (type == "browser-back") {
        browser->GoBack();
      } else if (type == "browser-forward") {
        browser->GoForward();
      } else if (type == "browser-reload") {
        const bool ignore_cache = request->HasKey("ignoreCache") &&
                                  request->GetType("ignoreCache") == VTYPE_BOOL &&
                                  request->GetBool("ignoreCache");
        if (ignore_cache) browser->ReloadIgnoreCache();
        else browser->Reload();
      } else {
        browser->StopLoad();
      }
      RespondWithBrowserState(callback);
      return true;
    }
    if (type == "browser-set-content-bounds") {
      CefRefPtr<CefDictionaryValue> bounds = request->GetDictionary("bounds");
      if (!bounds || request->GetType("visible") != VTYPE_BOOL ||
          bounds->GetType("x") != VTYPE_INT ||
          bounds->GetType("y") != VTYPE_INT ||
          bounds->GetType("width") != VTYPE_INT ||
          bounds->GetType("height") != VTYPE_INT) {
        RespondNativeError(callback, "The native browser bounds were invalid.");
        return true;
      }
      const int x = bounds->GetInt("x");
      const int y = bounds->GetInt("y");
      const int width = bounds->GetInt("width");
      const int height = bounds->GetInt("height");
      if (x < 0 || y < 0 || width < 0 || height < 0 || x > 20000 ||
          y > 20000 || width > 20000 || height > 20000) {
        RespondNativeError(callback, "The native browser bounds were out of range.");
        return true;
      }
      user_browser_bounds_ = CefRect(x, y, width, height);
      user_browser_view_visible_ = request->GetBool("visible");
      SyncUserBrowserViewVisibility();
      callback->Success(R"JSON({"ok":true})JSON");
      return true;
    }
    if (type.starts_with("browser-") || type.starts_with("window-")) {
      RespondNativeError(
          callback,
          "This native Chromium browser command is not migrated yet.");
      return true;
    }
    return false;
  }

  void StartEphemeralCore(NSString* isolated_profile_root) {
    if (!isolated_profile_root) return;
    KestrelClient* const relay_client = this;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    core_relay_ = [[KestrelNativeCoreRelay alloc]
        initWithProfileRoot:isolated_profile_root
                lineHandler:^(NSString* line) {
                  const std::shared_ptr<bool> alive = owner_token.lock();
                  KestrelClient* client = relay_client;
                  if (!alive || !*alive || !client || !line) return;
                  CefRefPtr<KestrelClient> retained(client);
                  post_core_relay_line(
                      retained,
                      std::string([line UTF8String] ?: ""));
         }
         terminationHandler:^(NSString* error) {
                  const std::shared_ptr<bool> alive = owner_token.lock();
                  KestrelClient* client = relay_client;
                  if (!alive || !*alive || !client) return;
                  CefRefPtr<KestrelClient> retained(client);
                  post_core_relay_termination(retained);
                }];
    NSError* error = nil;
    if (![core_relay_ start:&error]) {
      std::cerr << "Kestrel could not start its standalone native Core relay."
                << std::endl;
      core_relay_ = nil;
    }
  }

  void StopCoreRelay() {
    if (core_relay_) {
      [core_relay_ shutdown];
      core_relay_ = nil;
    }
    core_ready_ = false;
  }

  void DispatchCoreRequest(
      const std::string& request,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
    if (!core_relay_) {
      callback->Success(
          R"JSON({"ok":false,"error":"Kestrel native Core is unavailable. Start this isolated host with --kestrel-ephemeral-core while profile migration is deferred."})JSON");
      return;
    }
    if (!core_ready_) {
      queued_core_requests_.push_back({request, callback});
      return;
    }
    SendCoreRequest(request, callback);
  }

  void FlushQueuedCoreRequests() {
    auto queued = std::move(queued_core_requests_);
    queued_core_requests_.clear();
    for (const auto& request : queued) {
      SendCoreRequest(request.request, request.callback);
    }
  }

  void SendCoreRequest(
      const std::string& request,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
    if (!core_relay_) {
      callback->Success(
          R"JSON({"ok":false,"error":"Kestrel native Core is unavailable."})JSON");
      return;
    }
    const std::string id =
        "native-core-" + std::to_string(++next_core_request_id_);
    const std::string line =
        "{\"type\":\"request\",\"id\":\"" + id +
        "\",\"request\":" + request + "}";
    const bool is_snapshot = request.find("\"type\":\"snapshot\"") !=
                             std::string::npos;
    core_requests_.emplace(id, PendingCoreRequest{callback, is_snapshot});
    if (![core_relay_ sendLine:[NSString stringWithUTF8String:line.c_str()]]) {
      core_requests_.erase(id);
      callback->Success(
          R"JSON({"ok":false,"error":"Kestrel native Core could not receive the request."})JSON");
    }
  }

  void FailPendingCoreRequests(const char* error) {
    const std::string response =
        std::string("{\"ok\":false,\"error\":\"") + error + "\"}";
    for (auto& [id, request] : core_requests_) {
      request.callback->Success(response);
    }
    core_requests_.clear();
    for (const auto& request : queued_core_requests_) {
      request.callback->Success(response);
    }
    queued_core_requests_.clear();
  }

  void DiscardPendingCoreRequests() {
    core_requests_.clear();
    queued_core_requests_.clear();
  }

  CefRefPtr<CefBrowser> browser_;
  bool closing_ = false;
  bool main_browser_closed_ = false;
  bool bridge_shutdown_pending_ = false;
  bool bridge_teardown_scheduled_ = false;
  bool bridge_router_release_scheduled_ = false;
  bool bridge_teardown_complete_ = false;
  bool closed_tab_cleanup_scheduled_ = false;
  bool host_ready_logged_ = false;
  bool core_ready_ = false;
  bool smoke_user_browser_started_ = false;
  uint64_t next_core_request_id_ = 0;
  std::string isolated_profile_root_;
  std::string user_browser_cache_path_;
  std::shared_ptr<bool> native_owner_alive_ = std::make_shared<bool>(true);
  std::deque<NativeUserBrowserTab> user_browser_tabs_;
  std::set<std::string> pending_user_browser_closures_;
  std::string user_browser_active_tab_id_;
  CefRect user_browser_bounds_;
  bool user_browser_view_visible_ = false;
  bool user_browser_context_initializing_ = false;
  bool user_browser_context_ready_ = false;
  CefRefPtr<KestrelUserBrowserContextHandler> user_browser_context_handler_;
  CefRefPtr<CefRequestContext> user_browser_context_;
  __strong KestrelNativeCoreRelay* core_relay_ = nil;
  std::map<std::string, PendingCoreRequest> core_requests_;
  std::vector<QueuedCoreRequest> queued_core_requests_;
  std::unique_ptr<KestrelBridgeQueryHandler> bridge_handler_;
  CefRefPtr<CefMessageRouterBrowserSide> bridge_router_;

  IMPLEMENT_REFCOUNTING(KestrelClient);
};

class CoreRelayLineTask final : public CefTask {
 public:
  CoreRelayLineTask(CefRefPtr<KestrelClient> client, std::string line)
      : client_(std::move(client)), line_(std::move(line)) {}

  void Execute() override {
    if (client_) client_->OnCoreRelayLine(line_);
  }

 private:
  CefRefPtr<KestrelClient> client_;
  std::string line_;

  IMPLEMENT_REFCOUNTING(CoreRelayLineTask);
};

class UserBrowserCloseCleanupTask final : public CefTask {
 public:
  explicit UserBrowserCloseCleanupTask(CefRefPtr<KestrelClient> client)
      : client_(std::move(client)) {}

  void Execute() override {
    if (client_) client_->FinalizeClosedUserBrowserTabs();
  }

 private:
  CefRefPtr<KestrelClient> client_;

  IMPLEMENT_REFCOUNTING(UserBrowserCloseCleanupTask);
};

class UserBrowserCreateTask final : public CefTask {
 public:
  UserBrowserCreateTask(
      CefRefPtr<KestrelClient> client,
      std::string input,
      bool active,
      CefRefPtr<CefMessageRouterBrowserSide::Callback> callback)
      : client_(std::move(client)),
        input_(std::move(input)),
        active_(active),
        callback_(std::move(callback)) {}

  void Execute() override {
    if (client_) {
      client_->CompleteCreateUserBrowserTab(std::move(input_), active_,
                                            std::move(callback_));
    }
  }

 private:
  CefRefPtr<KestrelClient> client_;
  std::string input_;
  bool active_;
  CefRefPtr<CefMessageRouterBrowserSide::Callback> callback_;

  IMPLEMENT_REFCOUNTING(UserBrowserCreateTask);
};

class CoreRelayTerminationTask final : public CefTask {
 public:
  explicit CoreRelayTerminationTask(CefRefPtr<KestrelClient> client)
      : client_(std::move(client)) {}

  void Execute() override {
    if (client_) client_->OnCoreRelayTerminated();
  }

 private:
  CefRefPtr<KestrelClient> client_;

  IMPLEMENT_REFCOUNTING(CoreRelayTerminationTask);
};

class BridgeTeardownTask final : public CefTask {
 public:
  explicit BridgeTeardownTask(CefRefPtr<KestrelClient> client)
      : client_(std::move(client)) {}

  void Execute() override {
    if (client_) client_->FinalizeBridgeTeardown();
  }

 private:
  CefRefPtr<KestrelClient> client_;

  IMPLEMENT_REFCOUNTING(BridgeTeardownTask);
};

class BridgeRouterReleaseTask final : public CefTask {
 public:
  explicit BridgeRouterReleaseTask(CefRefPtr<KestrelClient> client)
      : client_(std::move(client)) {}

  void Execute() override {
    if (client_) client_->FinalizeBridgeRouterRelease();
  }

 private:
  CefRefPtr<KestrelClient> client_;

  IMPLEMENT_REFCOUNTING(BridgeRouterReleaseTask);
};

// CEF owns the client while BrowserViews are being destructed. Retain the
// application-level client through the native message loop as well, then
// release it after OnBeforeClose has returned and before CefShutdown(). That
// keeps the bridge router from being released re-entrantly by the BrowserView
// graph during window teardown.
CefRefPtr<KestrelClient> main_client_owner;

void post_bridge_teardown(CefRefPtr<KestrelClient> client) {
  CefPostTask(TID_UI, new BridgeTeardownTask(std::move(client)));
}

void post_bridge_router_release(CefRefPtr<KestrelClient> client) {
  CefPostTask(TID_UI, new BridgeRouterReleaseTask(std::move(client)));
}

void post_core_relay_line(CefRefPtr<KestrelClient> client, std::string line) {
  if (CefCurrentlyOn(TID_UI)) {
    client->OnCoreRelayLine(line);
    return;
  }
  CefPostTask(TID_UI, new CoreRelayLineTask(std::move(client), std::move(line)));
}

void post_user_browser_close_cleanup(CefRefPtr<KestrelClient> client) {
  CefPostTask(TID_UI,
              new UserBrowserCloseCleanupTask(std::move(client)));
}

void post_user_browser_creation(
    CefRefPtr<KestrelClient> client,
    std::string input,
    bool active,
    CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
  CefPostTask(TID_UI,
              new UserBrowserCreateTask(std::move(client), std::move(input),
                                        active, std::move(callback)));
}

void post_core_relay_termination(CefRefPtr<KestrelClient> client) {
  if (CefCurrentlyOn(TID_UI)) {
    client->OnCoreRelayTerminated();
    return;
  }
  CefPostTask(TID_UI, new CoreRelayTerminationTask(std::move(client)));
}

class CloseWhenReadyTask : public CefTask {
 public:
  void Execute() override {
    if (client_instance) {
      client_instance->CloseBrowser();
    }
  }

 private:
  IMPLEMENT_REFCOUNTING(CloseWhenReadyTask);
};

void schedule_close_after_ready() {
  if (exit_after_ready_ms > 0) {
    CefPostDelayedTask(TID_UI, new CloseWhenReadyTask(), exit_after_ready_ms);
  }
}

class KestrelWindowDelegate : public CefWindowDelegate {
 public:
  explicit KestrelWindowDelegate(CefRefPtr<CefBrowserView> browser_view)
      : browser_view_(browser_view) {}

  // Kestrel supplies its own window chrome and all of its child BrowserViews
  // are Alloy. Leaving the top-level window at CEF's default Chrome style
  // initializes Chrome profile services (including GCM) even though there is
  // no Kestrel feature that can use them. Keep the entire native surface in
  // the content-runtime style so a fresh no-credential launch cannot start
  // background registration or prompt through Chrome's account stack.
  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_ALLOY;
  }

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    kestrel_window = window;
    window->AddChildView(browser_view_);
    window->SetTitle("Kestrel");
    window->Show();
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    kestrel_window = nullptr;
  }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    CefRefPtr<CefBrowser> browser = browser_view_->GetBrowser();
    return !browser || browser->GetHost()->TryCloseBrowser();
  }

  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    return CefSize(1180, 780);
  }

 private:
  CefRefPtr<CefBrowserView> browser_view_;

  IMPLEMENT_REFCOUNTING(KestrelWindowDelegate);
};

}  // namespace

@interface KestrelApplication : NSApplication <CefAppProtocol> {
 @private
  BOOL handling_send_event_;
}
@end

@implementation KestrelApplication
- (BOOL)isHandlingSendEvent {
  return handling_send_event_;
}

- (void)setHandlingSendEvent:(BOOL)handling_send_event {
  handling_send_event_ = handling_send_event;
}

- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sending_event;
  [super sendEvent:event];
}

- (void)terminate:(id)sender {
  if (extension_workbench_client) {
    extension_workbench_client->CloseAll();
    return;
  }
  if (client_instance && !client_instance->IsClosing()) {
    client_instance->CloseBrowser();
  }
}
@end

@interface KestrelAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation KestrelAppDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
  if (extension_workbench_client) {
    extension_workbench_client->CloseAll();
    return NSTerminateCancel;
  }
  if (client_instance && !client_instance->IsClosing()) {
    client_instance->CloseBrowser();
    return NSTerminateCancel;
  }
  return NSTerminateNow;
}
@end

std::string bundled_shell_url() {
  NSString* resource_path = [[NSBundle mainBundle] resourcePath];
  if (full_renderer_enabled) {
    NSString* renderer_path =
        [resource_path stringByAppendingPathComponent:@"kestrel-renderer"];
    renderer_resource_root =
        std::string([renderer_path fileSystemRepresentation]);
    return "kestrel://app/index.html";
  }
  NSString* renderer_path = @"kestrel-shell/index.html";
  NSString* shell_path =
      [resource_path stringByAppendingPathComponent:renderer_path];
  NSURL* url = [NSURL fileURLWithPath:shell_path];
  return std::string([[url absoluteString] UTF8String]);
}

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) {
    std::cerr << "Kestrel could not load the bundled Chromium framework." << std::endl;
    return 1;
  }

  CefMainArgs main_args(argc, argv);
  @autoreleasepool {
    [KestrelApplication sharedApplication];
    const bool extension_workbench =
        has_argument(argc, argv, "--kestrel-extension-workbench");
    if (extension_workbench &&
        (has_argument(argc, argv, "--kestrel-renderer") ||
         has_argument(argc, argv, "--kestrel-ephemeral-core"))) {
      std::cerr << "Extension workbench cannot run the privileged shell or Core." << std::endl;
      return 1;
    }
    full_renderer_enabled =
        has_argument(argc, argv, "--kestrel-renderer");
    shell_url = bundled_shell_url();
    if (shell_url.empty()) {
      std::cerr << "Kestrel native Chromium shell resource is missing." << std::endl;
      return 1;
    }
    if (const auto exit_after_ready =
            argument_value(argc, argv, "--kestrel-exit-after-ready-ms")) {
      try {
        exit_after_ready_ms = std::stoi(*exit_after_ready);
      } catch (...) {
        std::cerr << "Kestrel received an invalid native-host exit delay."
                  << std::endl;
        return 1;
      }
      if (exit_after_ready_ms < 1) {
        std::cerr << "Kestrel native-host exit delay must be positive."
                  << std::endl;
        return 1;
      }
    }
    if (const auto smoke_url =
            argument_value(argc, argv, "--kestrel-smoke-user-browser-url")) {
      const std::optional<std::string> normalized =
          safe_user_browser_url(*smoke_url);
      if (!normalized) {
        std::cerr << "Kestrel received an invalid native user-browser smoke URL."
                  << std::endl;
        return 1;
      }
      smoke_user_browser_url = *normalized;
    }
    if (const auto smoke_bridge_url = argument_value(
            argc, argv, "--kestrel-smoke-bridge-user-browser-url")) {
      if (smoke_user_browser_url) {
        std::cerr << "Kestrel accepts only one native user-browser smoke mode."
                  << std::endl;
        return 1;
      }
      const std::optional<std::string> normalized =
          safe_user_browser_url(*smoke_bridge_url);
      if (!normalized || full_renderer_enabled) {
        std::cerr << "Kestrel bridge user-browser smoke requires a valid URL "
                     "and the bundled static shell."
                  << std::endl;
        return 1;
      }
      smoke_user_browser_url = *normalized;
      smoke_user_browser_via_bridge = true;
      shell_url += "?native-browser-smoke=" +
                   CefURIEncode(*smoke_user_browser_url, false).ToString();
    }

    CefSettings settings;
    // The production path is sandboxed. This switch exists only to make a
    // failed local signing diagnosis explicit; it is never a shipping fallback.
    settings.no_sandbox = has_argument(argc, argv, "--kestrel-allow-no-sandbox");
    settings.persist_session_cookies = true;
    const auto cache_path =
        argument_value(argc, argv, "--kestrel-cache-path");
    if (!cache_path) {
      std::cerr << "Kestrel native Chromium host requires an explicit isolated "
                   "profile path."
                << std::endl;
      return 1;
    }
    NSString* requested_profile =
        [NSString stringWithUTF8String:cache_path->c_str()];
    if (!requested_profile || ![requested_profile isAbsolutePath]) {
      std::cerr << "Kestrel native Chromium host requires an absolute isolated "
                   "profile path."
                << std::endl;
      return 1;
    }
    NSError* profile_error = nil;
    if (![[NSFileManager defaultManager]
            createDirectoryAtPath:requested_profile
       withIntermediateDirectories:YES
                        attributes:nil
                             error:&profile_error]) {
      std::cerr << "Kestrel could not create its explicit isolated profile path."
                << std::endl;
      return 1;
    }
    char resolved_profile[PATH_MAX]{};
    if (!realpath([requested_profile fileSystemRepresentation], resolved_profile)) {
      std::cerr << "Kestrel could not resolve its explicit isolated profile path."
                << std::endl;
      return 1;
    }
    isolated_profile_path = resolved_profile;
    CefString(&settings.root_cache_path) = isolated_profile_path;
    CefString(&settings.cache_path) = isolated_profile_path;
    ephemeral_core_enabled =
        has_argument(argc, argv, "--kestrel-ephemeral-core");

    CefRefPtr<KestrelChromiumApp> app(new KestrelChromiumApp([extension_workbench] {
      if (extension_workbench) {
        StartExtensionWorkbench();
        return;
      }
      if (!register_renderer_scheme()) {
        std::cerr << "Kestrel could not register its bundled renderer scheme."
                  << std::endl;
        CefQuitMessageLoop();
        return;
      }
      CefBrowserSettings browser_settings;
      NSString* isolated_profile =
          [NSString stringWithUTF8String:isolated_profile_path.c_str()];
      CefRefPtr<KestrelClient> client(new KestrelClient(
          shell_url,
          isolated_profile,
          ephemeral_core_enabled));
      main_client_owner = client;
      CefRefPtr<CefBrowserView> browser_view =
          CefBrowserView::CreateBrowserView(
              client, shell_url, browser_settings, nullptr, nullptr,
              new KestrelAlloyBrowserViewDelegate());
      CefWindow::CreateTopLevelWindow(
          new KestrelWindowDelegate(browser_view));
    }, extension_workbench));
    if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
      std::cerr << "Kestrel could not initialize Chromium." << std::endl;
      return CefGetExitCode();
    }

    KestrelAppDelegate* delegate = [[KestrelAppDelegate alloc] init];
    NSApp.delegate = delegate;
    if (extension_workbench) {
      // CEF supplies the browser toolbar, but the embedding app owns its
      // application menu and Cmd-Q. Route Quit through our tracked browsers.
      NSMenu* menu = [[NSMenu alloc] init];
      NSMenuItem* application_item = [[NSMenuItem alloc] init];
      NSMenu* application_menu = [[NSMenu alloc] initWithTitle:@"Kestrel"];
      [application_menu addItemWithTitle:@"Quit Kestrel Extension Workbench"
                                 action:@selector(terminate:)
                          keyEquivalent:@"q"];
      application_item.submenu = application_menu;
      [menu addItem:application_item];
      NSApp.mainMenu = menu;
    }
    CefRunMessageLoop();
    if (main_client_owner) {
      main_client_owner->FinalizeUserBrowserShutdown();
    }
    // The bridge router was removed by a trailing UI task before the message
    // loop quit. Release every application-owned CEF reference before calling
    // CefShutdown; CEF rejects ref-count operations after an object destructor
    // has started, which is easy to trigger when deferred router callbacks are
    // still owned by the client.
    main_client_owner = nullptr;
    extension_workbench_client = nullptr;
    if (full_renderer_enabled) {
      CefClearSchemeHandlerFactories();
      renderer_scheme_factory = nullptr;
    }
    app = nullptr;
    CefShutdown();
    delegate = nil;
  }
  return extension_workbench_exit_code;
}
