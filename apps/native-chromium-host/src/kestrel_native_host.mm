#import <Cocoa/Cocoa.h>
#import <ImageIO/ImageIO.h>

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
#include "include/cef_devtools_message_observer.h"
#include "include/cef_display_handler.h"
#include "include/cef_download_handler.h"
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
#include "kestrel_durable_browser_library.h"
#include "kestrel_extension_workbench.h"
#include "kestrel_native_credentials.h"

@interface KestrelNativeCoreRelay : NSObject
- (instancetype)initWithProfileRoot:(NSString*)profileRoot
                        environment:(NSDictionary<NSString*, NSString*>*)environment
                        lineHandler:(void (^)(NSString* line))lineHandler
                 terminationHandler:(void (^)(NSString* error))terminationHandler;
- (BOOL)start:(NSError**)error;
- (BOOL)sendLine:(NSString*)line;
- (void)shutdown;
@end

@interface KestrelNativeCoreRelay ()
@property(nonatomic, copy) NSString* profileRoot;
@property(nonatomic, copy) NSDictionary<NSString*, NSString*>* environment;
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
                        environment:(NSDictionary<NSString*, NSString*>*)environment
                        lineHandler:(void (^)(NSString* line))lineHandler
                 terminationHandler:(void (^)(NSString* error))terminationHandler {
  self = [super init];
  if (!self) return nil;
  _profileRoot = [profileRoot copy];
  _environment = [environment copy];
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
  if (self.environment.count > 0) {
    NSMutableDictionary* environment =
        [[[NSProcessInfo processInfo] environment] mutableCopy];
    [environment addEntriesFromDictionary:self.environment];
    self.task.environment = environment;
  }
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
bool user_extensions_enabled = false;
bool durable_profile_enabled = false;
bool real_keychain_enabled = false;
bool smoke_durable_library_seed = false;
bool smoke_durable_library_verify = false;
bool smoke_browser_backend = false;
bool smoke_isolated_automation = false;
bool smoke_isolated_automation_done = false;
bool smoke_credentials = false;
std::optional<std::string> smoke_user_browser_url;
std::optional<std::string> smoke_download_url;
std::optional<std::string> smoke_browser_backend_url;
std::optional<std::string> smoke_isolated_automation_url;
std::optional<std::string> smoke_isolated_upload_path;
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

std::string json_escape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (character < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", character);
          escaped += buffer;
        } else {
          escaped.push_back(static_cast<char>(character));
        }
        break;
    }
  }
  return escaped;
}

std::string base64_encode_bytes(const uint8_t* data, size_t length) {
  if (!data || length == 0) return {};
  NSData* payload = [NSData dataWithBytes:data length:length];
  NSString* encoded =
      [payload base64EncodedStringWithOptions:0];
  return encoded ? std::string([encoded UTF8String] ?: "") : std::string();
}

std::vector<uint8_t> base64_decode_bytes(const std::string& encoded) {
  if (encoded.empty()) return {};
  NSData* payload = [[NSData alloc]
      initWithBase64EncodedString:@(encoded.c_str())
                          options:NSDataBase64DecodingIgnoreUnknownCharacters];
  if (!payload || payload.length == 0) return {};
  const auto* bytes = static_cast<const uint8_t*>(payload.bytes);
  return std::vector<uint8_t>(bytes, bytes + payload.length);
}

bool decode_png_to_rgba(const std::vector<uint8_t>& png, int* width,
                        int* height, std::vector<uint8_t>* rgba) {
  if (!width || !height || !rgba || png.empty()) return false;
  NSData* data = [NSData dataWithBytes:png.data() length:png.size()];
  CGImageSourceRef source =
      CGImageSourceCreateWithData((__bridge CFDataRef)data, nullptr);
  if (!source) return false;
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
  CFRelease(source);
  if (!image) return false;
  const size_t image_width = CGImageGetWidth(image);
  const size_t image_height = CGImageGetHeight(image);
  if (image_width == 0 || image_height == 0 ||
      image_width > 7680 || image_height > 4320) {
    CGImageRelease(image);
    return false;
  }
  std::vector<uint8_t> pixels(image_width * image_height * 4, 0);
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
      pixels.data(), image_width, image_height, 8, image_width * 4, space,
      static_cast<CGBitmapInfo>(kCGImageAlphaPremultipliedLast) |
          static_cast<CGBitmapInfo>(kCGBitmapByteOrder32Big));
  CGColorSpaceRelease(space);
  if (!context) {
    CGImageRelease(image);
    return false;
  }
  CGContextDrawImage(context, CGRectMake(0, 0, image_width, image_height),
                     image);
  CGContextRelease(context);
  CGImageRelease(image);
  *width = static_cast<int>(image_width);
  *height = static_cast<int>(image_height);
  *rgba = std::move(pixels);
  return true;
}

std::string encode_screenshot_frame_json(int width, int height,
                                         const std::vector<uint8_t>& rgba,
                                         const std::vector<uint8_t>& png,
                                         bool visible_tab = false) {
  const std::string rgba_b64 =
      base64_encode_bytes(rgba.data(), rgba.size());
  const std::string png_b64 = base64_encode_bytes(png.data(), png.size());
  std::string json = "{\"width\":" + std::to_string(width) + ",\"height\":" +
                     std::to_string(height) +
                     ",\"rgba\":{\"__kestrel_binary_base64__\":\"" + rgba_b64 +
                     "\"},\"png\":{\"__kestrel_binary_base64__\":\"" + png_b64 +
                     "\"}";
  if (visible_tab) json += ",\"trust\":\"untrusted_browser\"";
  json += "}";
  return json;
}

std::string json_string_literal(const std::string& value) {
  CefRefPtr<CefValue> root = CefValue::Create();
  root->SetString(value);
  return CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
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

std::string http_origin_from_url(const std::string& url) {
  const auto scheme_end = url.find("://");
  if (scheme_end == std::string::npos) return {};
  const size_t host_start = scheme_end + 3;
  const size_t host_end = url.find_first_of("/?#", host_start);
  if (host_end == std::string::npos) return url;
  return url.substr(0, host_end);
}

bool is_about_blank_url(const std::string& url) {
  return url == "about:blank" || url.rfind("about:blank?", 0) == 0;
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

// Fixed host scripts for isolated automation. Never concatenate model text into
// these expressions; action payloads are JSON-escaped and passed as literals.
constexpr char kAutomationSnapshotScript[] = R"JS(
(() => {
  const nodes = Array.from(document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), textarea, select'));
  const interactive = [];
  const children = [];
  let truncated = false;
  let index = 0;
  for (const el of nodes) {
    if (interactive.length >= 200) { truncated = true; break; }
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || Number(style.opacity) <= 0 ||
        el.getClientRects().length === 0) continue;
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    if (inputType === 'password') continue;
    const ref = 'e' + (++index);
    el.setAttribute('data-kestrel-ref', ref);
    let role = 'button';
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') role = 'textbox';
    else if (tag === 'SELECT') role = 'combobox';
    else if (tag === 'A') role = 'link';
    const name = String(
      el.getAttribute('aria-label') || el.innerText || el.value ||
      el.getAttribute('name') || el.id || tag).slice(0, 200);
    interactive.push({ ref, role, name, tag, inputType });
    children.push({ role, name, ref });
  }
  return JSON.stringify({
    interactive,
    accessibilityTree: {
      role: 'RootWebArea',
      name: String(document.title || '').slice(0, 500),
      children
    },
    truncated
  });
})()
)JS";

constexpr char kAutomationScreenshotGuardScript[] = R"JS(
(() => {
  const sensitiveName =
    /(?:\b(?:new|current|old|confirm(?:ation)?|repeat)?\s*password\b|\b(?:one\s*time|recovery|verification|security)\s*(?:code|passcode|pin)\b|\botp\b|\b(?:cvv|cvc)\b|\bapi\s*(?:key|token)\b|\baccess\s*token\b|\bprivate\s*key\b)/i;
  const nodes = Array.from(document.querySelectorAll(
    'input:not([type="hidden"]), textarea'));
  for (const el of nodes) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || Number(style.opacity) <= 0 ||
        el.getClientRects().length === 0) continue;
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    if (inputType === 'password') return JSON.stringify({ sensitive: true });
    const name = String(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('name') || el.id || '').slice(0, 200);
    if (sensitiveName.test(name)) return JSON.stringify({ sensitive: true });
  }
  return JSON.stringify({ sensitive: false });
})()
)JS";

// Mirrors Electron pageContextWhilePinned: readable untrusted page summary with
// sensitive-field redaction. Returns JSON.stringify(...) for Runtime.evaluate.
constexpr char kVisiblePageContextScript[] = R"JS(
(() => {
  const limit = (value, maximum) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 &&
      rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth &&
      style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity) > 0;
  };
  const sensitiveField = (node) => {
    if (!(node instanceof HTMLInputElement)) return false;
    const hint = [node.type, node.autocomplete, node.name, node.id,
      node.getAttribute('aria-label'), node.placeholder]
      .filter(Boolean).join(' ').toLowerCase();
    return node.type === 'password' ||
      /(?:current|new)[-_ ]password|one[-_ ]time[-_ ]code|\botp\b|recovery[-_ ]code|verification[-_ ]code|security[-_ ]code|\b(?:cvv|cvc)\b|api[-_ ]key|access[-_ ]token|private[-_ ]key/.test(hint);
  };
  const nodes = Array.from(document.querySelectorAll(
    'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,article,main')).filter(visible);
  const visibleText = nodes.map((node) => limit(node.innerText || node.textContent, 4000))
    .filter(Boolean).join('\n').slice(0, 40000);
  const links = Array.from(document.querySelectorAll('a[href]')).filter(visible)
    .slice(0, 100).map((node) => ({
      text: limit(node.innerText || node.textContent, 500),
      url: String(node.href || '').slice(0, 8192)
    })).filter((link) => /^https?:\/\//i.test(link.url));
  const forms = Array.from(document.querySelectorAll(
    'input,textarea,select,button')).filter(visible).slice(0, 60).map((node) =>
    sensitiveField(node)
      ? { label: 'Sensitive field', type: 'sensitive', name: '' }
      : {
          label: limit(node.labels?.[0]?.innerText ||
            node.getAttribute('aria-label') || node.placeholder ||
            node.innerText, 500),
          type: limit(node.type || node.tagName.toLowerCase(), 100),
          name: limit(node.name || node.id, 500)
        });
  const active = document.activeElement;
  return JSON.stringify({
    description: limit(document.querySelector('meta[name="description"]')?.content, 2000),
    selectedText: active instanceof Element && sensitiveField(active)
      ? ''
      : limit(getSelection()?.toString(), 20000),
    visibleText: visibleText || limit(document.body?.innerText, 40000),
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .filter(visible).slice(0, 60)
      .map((node) => limit(node.innerText || node.textContent, 500))
      .filter(Boolean),
    links,
    forms,
    viewport: {
      width: Math.max(1, Math.round(innerWidth)),
      height: Math.max(1, Math.round(innerHeight)),
      scrollX,
      scrollY
    }
  });
})()
)JS";

class KestrelAutomationDevToolsObserver final
    : public CefDevToolsMessageObserver {
 public:
  using ResultHandler =
      std::function<void(int message_id, bool success, std::string result_json)>;
  using AttachHandler = std::function<void()>;

  KestrelAutomationDevToolsObserver(ResultHandler on_result,
                                    AttachHandler on_attached)
      : on_result_(std::move(on_result)),
        on_attached_(std::move(on_attached)) {}

  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    (void)browser;
    if (!on_result_) return;
    std::string json;
    if (result && result_size > 0) {
      json.assign(static_cast<const char*>(result), result_size);
    }
    on_result_(message_id, success, std::move(json));
  }

  void OnDevToolsAgentAttached(CefRefPtr<CefBrowser> browser) override {
    (void)browser;
    if (on_attached_) on_attached_();
  }

 private:
  ResultHandler on_result_;
  AttachHandler on_attached_;
  IMPLEMENT_REFCOUNTING(KestrelAutomationDevToolsObserver);
};

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
// and captures downloads into the host's durable browser library.
class KestrelUserBrowserClient final : public CefClient,
                                       public CefLifeSpanHandler,
                                       public CefLoadHandler,
                                       public CefDisplayHandler,
                                       public CefRequestHandler,
                                       public CefDownloadHandler {
 public:
  using BrowserCreated = std::function<void(const std::string&,
                                            CefRefPtr<CefBrowser>)>;
  using LoadingChanged = std::function<void(const std::string&, bool, bool,
                                            bool)>;
  using StringChanged =
      std::function<void(const std::string&, const std::string&)>;
  using NavigationBlocked = std::function<void(const std::string&)>;
  using BrowserClosed = std::function<void(const std::string&, int)>;
  using PopupRequested =
      std::function<void(const std::string& opener_tab_id, const std::string& url)>;
  using DownloadPathResolver =
      std::function<std::string(const std::string& suggested_name)>;
  using DownloadUpdated = std::function<void(
      const std::string& tab_id, uint32_t cef_download_id,
      const std::string& source_url, const std::string& filename,
      const std::string& full_path, int64_t received_bytes, int64_t total_bytes,
      const std::string& status, CefRefPtr<CefDownloadItemCallback> callback)>;

  KestrelUserBrowserClient(std::string tab_id, BrowserCreated on_created,
                           LoadingChanged on_loading,
                           StringChanged on_address,
                           StringChanged on_title,
                           StringChanged on_load_end,
                           NavigationBlocked on_navigation_blocked,
                           BrowserClosed on_closed,
                           PopupRequested on_popup,
                           DownloadPathResolver resolve_download_path,
                           DownloadUpdated on_download_updated,
                           bool automation_mode = false,
                           std::set<std::string> allowed_origins = {})
      : tab_id_(std::move(tab_id)),
        on_created_(std::move(on_created)),
        on_loading_(std::move(on_loading)),
        on_address_(std::move(on_address)),
        on_title_(std::move(on_title)),
        on_load_end_(std::move(on_load_end)),
        on_navigation_blocked_(std::move(on_navigation_blocked)),
        on_closed_(std::move(on_closed)),
        on_popup_(std::move(on_popup)),
        resolve_download_path_(std::move(resolve_download_path)),
        on_download_updated_(std::move(on_download_updated)),
        automation_mode_(automation_mode),
        allowed_origins_(std::move(allowed_origins)) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }

  bool CanDownload(CefRefPtr<CefBrowser> browser,
                   const CefString& url,
                   const CefString& request_method) override {
    const std::string method = request_method.ToString();
    if (method != "GET" && method != "POST") return false;
    const auto safe = safe_user_browser_url(url.ToString());
    if (!safe) return false;
    if (!automation_mode_ || allowed_origins_.empty()) return true;
    return allowed_origins_.count(http_origin_from_url(*safe)) > 0;
  }

  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefDownloadItem> download_item,
                        const CefString& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback) override {
    if (!download_item || !download_item->IsValid() || !callback) return false;
    const auto source = safe_user_browser_url(download_item->GetURL().ToString());
    if (!source || !resolve_download_path_) return false;
    const std::string path = resolve_download_path_(suggested_name.ToString());
    if (path.empty()) return false;
    callback->Continue(path, false);
    return true;
  }

  void OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefDownloadItem> download_item,
                         CefRefPtr<CefDownloadItemCallback> callback) override {
    if (!download_item || !download_item->IsValid() || !on_download_updated_) {
      return;
    }
    std::string status = "progressing";
    if (download_item->IsComplete()) status = "completed";
    else if (download_item->IsCanceled()) status = "cancelled";
    else if (download_item->IsInterrupted()) status = "failed";
    else if (download_item->IsInProgress()) status = "progressing";
    std::string filename = download_item->GetSuggestedFileName().ToString();
    if (filename.empty()) {
      const std::string full_path = download_item->GetFullPath().ToString();
      const auto slash = full_path.find_last_of('/');
      filename = slash == std::string::npos ? full_path
                                            : full_path.substr(slash + 1);
    }
    on_download_updated_(
        tab_id_, download_item->GetId(), download_item->GetURL().ToString(),
        filename, download_item->GetFullPath().ToString(),
        download_item->GetReceivedBytes(), download_item->GetTotalBytes(),
        status, callback);
  }

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
    // Adopt HTTP(S) popups as sibling user tabs in the Alloy window. Cancel the
    // default CEF popup window so opener/context stays inside Kestrel's host.
    const auto safe_url = safe_user_browser_url(target_url.ToString());
    if (safe_url && on_popup_) {
      on_popup_(tab_id_, *safe_url);
      std::cout << "KESTREL_NATIVE_CHROMIUM_USER_BROWSER_POPUP_ADOPTED url="
                << *safe_url << std::endl;
    }
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
    const std::string url = request->GetURL().ToString();
    if (automation_mode_ && is_about_blank_url(url)) return false;
    const auto safe = safe_user_browser_url(url);
    if (safe) {
      if (automation_mode_ && !allowed_origins_.empty() &&
          allowed_origins_.count(http_origin_from_url(*safe)) == 0) {
        if (on_navigation_blocked_) on_navigation_blocked_(tab_id_);
        return true;
      }
      return false;
    }
    if (on_navigation_blocked_) on_navigation_blocked_(tab_id_);
    return true;
  }

  bool DoClose(CefRefPtr<CefBrowser> browser) override {
    (void)browser;
    return false;
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
  PopupRequested on_popup_;
  DownloadPathResolver resolve_download_path_;
  DownloadUpdated on_download_updated_;
  bool automation_mode_ = false;
  std::set<std::string> allowed_origins_;

  IMPLEMENT_REFCOUNTING(KestrelUserBrowserClient);
};

struct NativeAutomationElementRef {
  std::string role;
  std::string tag;
  std::string input_type;
};

struct NativeAutomationSession {
  std::string id;
  std::set<std::string> allowed_origins;
  std::string url = "about:blank";
  std::string title = "New Tab";
  bool loading = false;
  bool closing = false;
  bool browser_ready = false;
  bool context_ready = false;
  bool devtools_attached = false;
  std::string pending_navigate_request_id;
  std::string pending_navigate_target_url;
  std::string pending_navigate_url;
  std::string pending_snapshot_request_id;
  std::string pending_act_request_id;
  std::string pending_screenshot_request_id;
  std::string pending_viewport_request_id;
  std::string pending_upload_request_id;
  std::string pending_upload_selector;
  std::vector<std::string> pending_upload_paths;
  int viewport_width = 1280;
  int viewport_height = 720;
  double viewport_device_scale_factor = 1.0;
  std::map<std::string, NativeAutomationElementRef> element_refs;
  std::map<int, std::string> pending_devtools_kinds;
  CefRefPtr<KestrelUserBrowserClient> client;
  CefRefPtr<CefBrowserView> view;
  CefRefPtr<CefRequestContext> context;
  CefRefPtr<CefRegistration> devtools_registration;
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
  bool devtools_attached = false;
  int browser_id = 0;
  int viewport_width = 1280;
  int viewport_height = 720;
  std::string pending_screenshot_request_id;
  std::string pending_snapshot_request_id;
  std::string pending_context_request_id;
  std::string pending_act_request_id;
  std::map<std::string, NativeAutomationElementRef> element_refs;
  std::map<int, std::string> pending_devtools_kinds;
  CefRefPtr<KestrelUserBrowserClient> client;
  CefRefPtr<CefBrowserView> view;
  CefRefPtr<CefRegistration> devtools_registration;
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
      const std::string status = std::string("{\"ok\":true,\"host\":\"chromium-cef\",\"profile\":\"") +
          (durable_profile_enabled ? "durable-isolated" : "isolated") +
          "\",\"credentialStorage\":\"disabled\",\"core\":\"ephemeral-or-unavailable\",\"browser\":\"" +
          (durable_profile_enabled
               ? "native-cef-durable-library"
               : "native-cef-in-memory-tabs") +
          "\",\"userExtensions\":\"" +
          (user_extensions_enabled ? "enabled-on-user-profile" : "disabled") +
          "\",\"durableProfile\":" +
          (durable_profile_enabled ? "true" : "false") +
          ",\"durableBrowserLibrary\":" +
          (durable_profile_enabled ? "true" : "false") + "}";
      callback->Success(status);
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
                bool enable_ephemeral_core,
                bool enable_user_extensions)
      : user_extensions_enabled_(enable_user_extensions),
        bridge_handler_(
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
      // When user extensions are enabled, Chromium's --load-extension path
      // lands in the default profile (isolated root). Keep the privileged
      // shell on a separate cache so extension storage never shares it.
      user_browser_cache_path_ =
          user_extensions_enabled_
              ? isolated_profile_root_
              : isolated_profile_root_ + "/user-browser";
      if (durable_profile_enabled) {
        browser_library_.Load(isolated_profile_root_);
        std::cout << "KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_LOADED"
                  << " bookmarks=" << browser_library_.bookmarks.size()
                  << " history=" << browser_library_.history.size()
                  << " downloads=" << browser_library_.downloads.size()
                  << " permissions="
                  << browser_library_.site_permissions.size() << std::endl;
      }
      std::string credential_error;
      const NativeCredentialStorageMode credential_mode =
          real_keychain_enabled ? NativeCredentialStorageMode::Keychain
                                : NativeCredentialStorageMode::ProfileSealed;
      if (!credential_store_.Open(isolated_profile_root_, credential_mode,
                                  &credential_error)) {
        credential_store_opened_ = false;
        std::cerr << "Kestrel credential bootstrap unavailable: "
                  << credential_error << std::endl;
      } else {
        credential_store_opened_ = true;
        std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_STORAGE mode="
                  << credential_store_.mode_name() << std::endl;
      }
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
              << (credential_store_ready()
                      ? credential_store_.mode_name()
                      : (command_line &&
                                 command_line->HasSwitch("use-mock-keychain")
                             ? "disabled"
                             : "unsafe"))
              << " chromium_keychain="
              << (command_line && command_line->HasSwitch("use-mock-keychain")
                      ? "mock"
                      : "real")
              << " background_networking="
              << (command_line &&
                          command_line->HasSwitch("disable-background-networking")
                      ? "disabled"
                      : "enabled")
              << " user_extensions="
              << (user_extensions_enabled ? "enabled" : "disabled")
              << " durable_profile="
              << (durable_profile_enabled ? "enabled" : "disabled")
              << std::endl;
    if (user_extensions_enabled) {
      std::cout << "KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED"
                << std::endl;
    }
    if (durable_profile_enabled) {
      std::cout << "KESTREL_NATIVE_CHROMIUM_DURABLE_PROFILE_ENABLED"
                << std::endl;
    }
    if (smoke_credentials) {
      RunCredentialBootstrapSmoke();
    }
    if (smoke_durable_library_verify) {
      VerifyDurableLibrarySmoke();
    } else if (smoke_durable_library_seed) {
      SeedDurableLibrarySmoke();
    }
    if (smoke_user_browser_url && !smoke_user_browser_via_bridge &&
        !smoke_user_browser_started_) {
      smoke_user_browser_started_ = true;
      std::string error;
      if (!CreateUserBrowserTab(*smoke_user_browser_url, true, &error)) {
        std::cerr << "Kestrel native user-browser smoke setup failed: "
                  << error << std::endl;
      }
    }
    if (smoke_download_url && !smoke_download_started_) {
      smoke_download_started_ = true;
      std::string error;
      if (!CreateUserBrowserTab(*smoke_download_url, true, &error)) {
        std::cerr << "Kestrel native download smoke setup failed: " << error
                  << std::endl;
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
    if (type == "browser-backend-request") {
      const std::string request_id = value->GetString("requestId").ToString();
      CefRefPtr<CefDictionaryValue> request = value->GetDictionary("request");
      if (request_id.empty() || !request) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser backend request was invalid.");
        return;
      }
      HandleBrowserBackendRequest(request_id, request);
      return;
    }
    if (type == "smoke-event") {
      const std::string name = value->GetString("name").ToString();
      if (name == "browser-backend-ok") {
        const int tab_count =
            value->GetType("tabCount") == VTYPE_INT ? value->GetInt("tabCount")
                                                     : 0;
        std::cout << "KESTREL_NATIVE_CHROMIUM_BROWSER_BACKEND_OK tabs="
                  << tab_count << std::endl;
      } else if (name == "browser-backend-failed") {
        std::cerr << "KESTREL_NATIVE_CHROMIUM_BROWSER_BACKEND_FAILED error="
                  << value->GetString("error").ToString() << std::endl;
      } else if (name == "isolated-automation-ok") {
        smoke_isolated_automation_done = true;
        std::cout << "KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_OK"
                  << std::endl;
        CloseBrowser();
      } else if (name == "isolated-automation-failed") {
        smoke_isolated_automation_done = true;
        std::cerr << "KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_FAILED error="
                  << value->GetString("error").ToString() << std::endl;
        CloseBrowser();
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

  NativeUserBrowserTab* ResolveVisibleTab(const std::string& tab_id,
                                          std::string* error) {
    NativeUserBrowserTab* tab = nullptr;
    if (!tab_id.empty()) {
      tab = FindUserBrowserTab(tab_id);
    } else if (!user_browser_active_tab_id_.empty()) {
      tab = FindUserBrowserTab(user_browser_active_tab_id_);
    }
    if (!tab || tab->closing) {
      if (error)
        *error = "The requested native browser tab no longer exists.";
      return nullptr;
    }
    return tab;
  }

  void EnsureUserBrowserDevTools(NativeUserBrowserTab& tab,
                                 CefRefPtr<CefBrowser> browser) {
    if (!browser || !browser->IsValid() || tab.devtools_registration) return;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    const std::string tab_id = tab.id;
    CefRefPtr<KestrelAutomationDevToolsObserver> observer =
        new KestrelAutomationDevToolsObserver(
            [this, owner_token, tab_id](int message_id, bool success,
                                       std::string result_json) {
              const std::shared_ptr<bool> alive = owner_token.lock();
              if (!alive || !*alive) return;
              OnUserBrowserDevToolsResult(tab_id, message_id, success,
                                          std::move(result_json));
            },
            [this, owner_token, tab_id]() {
              const std::shared_ptr<bool> alive = owner_token.lock();
              if (!alive || !*alive) return;
              NativeUserBrowserTab* found = FindUserBrowserTab(tab_id);
              if (found) found->devtools_attached = true;
            });
    tab.devtools_registration =
        browser->GetHost()->AddDevToolsMessageObserver(observer);
  }

  bool CallUserBrowserDevToolsMethod(NativeUserBrowserTab& tab,
                                     const std::string& method,
                                     CefRefPtr<CefDictionaryValue> params,
                                     const std::string& kind,
                                     std::string* error) {
    CefRefPtr<CefBrowser> browser = tab.view ? tab.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid()) {
      if (error) *error = "Native Chromium browser tab is unavailable.";
      return false;
    }
    EnsureUserBrowserDevTools(tab, browser);
    const int message_id = browser->GetHost()->ExecuteDevToolsMethod(
        0, method, params ? params : CefDictionaryValue::Create());
    if (message_id <= 0) {
      if (error)
        *error = "Kestrel could not call DevTools in the visible browser tab.";
      return false;
    }
    tab.pending_devtools_kinds[message_id] = kind;
    return true;
  }

  bool VisibleScreenshotDevToolsInFlight(const NativeUserBrowserTab& tab) const {
    for (const auto& entry : tab.pending_devtools_kinds) {
      if (entry.second.rfind("visible-screenshot", 0) == 0) return true;
    }
    return false;
  }

  bool StartPendingVisibleScreenshot(NativeUserBrowserTab& tab,
                                     std::string* error) {
    if (tab.pending_screenshot_request_id.empty() ||
        VisibleScreenshotDevToolsInFlight(tab)) {
      return true;
    }
    CefRefPtr<CefBrowser> browser = tab.view ? tab.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid() || tab.loading) {
      // Wait for a finished load so Runtime.evaluate sees a real document.
      return true;
    }
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("expression", kAutomationScreenshotGuardScript);
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", false);
    if (!CallUserBrowserDevToolsMethod(tab, "Runtime.evaluate", params,
                                       "visible-screenshot-guard", error)) {
      return false;
    }
    return true;
  }

  bool VisibleTabBusy(const NativeUserBrowserTab& tab) const {
    return !tab.pending_screenshot_request_id.empty() ||
           !tab.pending_snapshot_request_id.empty() ||
           !tab.pending_context_request_id.empty() ||
           !tab.pending_act_request_id.empty();
  }

  bool BeginVisibleScreenshot(const std::string& tab_id,
                              const std::string& request_id,
                              std::string* error) {
    NativeUserBrowserTab* tab = ResolveVisibleTab(tab_id, error);
    if (!tab) return false;
    if (VisibleTabBusy(*tab)) {
      if (error) *error = "Native Chromium browser tab is busy.";
      return false;
    }
    tab->pending_screenshot_request_id = request_id;
    if (!StartPendingVisibleScreenshot(*tab, error)) {
      tab->pending_screenshot_request_id.clear();
      return false;
    }
    return true;
  }

  bool StartPendingVisibleSnapshot(NativeUserBrowserTab& tab,
                                   std::string* error) {
    if (tab.pending_snapshot_request_id.empty()) return true;
    for (const auto& entry : tab.pending_devtools_kinds) {
      if (entry.second == "visible-snapshot") return true;
    }
    CefRefPtr<CefBrowser> browser = tab.view ? tab.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid() || tab.loading) return true;
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("expression", kAutomationSnapshotScript);
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", false);
    return CallUserBrowserDevToolsMethod(tab, "Runtime.evaluate", params,
                                         "visible-snapshot", error);
  }

  bool BeginVisibleSnapshot(const std::string& tab_id,
                            const std::string& request_id,
                            std::string* error) {
    NativeUserBrowserTab* tab = ResolveVisibleTab(tab_id, error);
    if (!tab) return false;
    if (VisibleTabBusy(*tab)) {
      if (error) *error = "Native Chromium browser tab is busy.";
      return false;
    }
    tab->pending_snapshot_request_id = request_id;
    if (!StartPendingVisibleSnapshot(*tab, error)) {
      tab->pending_snapshot_request_id.clear();
      return false;
    }
    return true;
  }

  bool StartPendingVisibleContext(NativeUserBrowserTab& tab,
                                  std::string* error) {
    if (tab.pending_context_request_id.empty()) return true;
    for (const auto& entry : tab.pending_devtools_kinds) {
      if (entry.second == "visible-context") return true;
    }
    CefRefPtr<CefBrowser> browser = tab.view ? tab.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid() || tab.loading) return true;
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("expression", kVisiblePageContextScript);
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", false);
    return CallUserBrowserDevToolsMethod(tab, "Runtime.evaluate", params,
                                         "visible-context", error);
  }

  bool BeginVisibleContext(const std::string& tab_id,
                           const std::string& request_id,
                           std::string* error) {
    NativeUserBrowserTab* tab = ResolveVisibleTab(tab_id, error);
    if (!tab) return false;
    if (tab->url.empty() || tab->url.rfind("kestrel:", 0) == 0 ||
        tab->url == "about:blank") {
      if (error)
        *error = "The selected tab does not have a readable web page.";
      return false;
    }
    if (VisibleTabBusy(*tab)) {
      if (error) *error = "Native Chromium browser tab is busy.";
      return false;
    }
    tab->pending_context_request_id = request_id;
    if (!StartPendingVisibleContext(*tab, error)) {
      tab->pending_context_request_id.clear();
      return false;
    }
    return true;
  }

  bool BeginVisibleAct(const std::string& tab_id,
                       CefRefPtr<CefDictionaryValue> action,
                       const std::string& request_id, std::string* error) {
    NativeUserBrowserTab* tab = ResolveVisibleTab(tab_id, error);
    if (!tab) return false;
    if (!action || action->GetType("type") != VTYPE_STRING) {
      if (error) *error = "Native visible-act was invalid.";
      return false;
    }
    if (VisibleTabBusy(*tab)) {
      if (error) *error = "Native Chromium browser tab is busy.";
      return false;
    }
    CefRefPtr<CefBrowser> browser = tab->view ? tab->view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid() || tab->loading) {
      if (error) *error = "Native Chromium browser tab is unavailable.";
      return false;
    }
    const std::string type = action->GetString("type").ToString();
    std::string expression;
    if (type == "click" || type == "type" || type == "select") {
      if (action->GetType("target") != VTYPE_STRING) {
        if (error) *error = "Native visible-act target was invalid.";
        return false;
      }
      const std::string target = action->GetString("target").ToString();
      if (target.size() > 2000 || target.find('"') != std::string::npos ||
          target.find('\\') != std::string::npos) {
        if (error) *error = "Native visible-act target was invalid.";
        return false;
      }
      const auto ref = tab->element_refs.find(target);
      if (ref == tab->element_refs.end()) {
        if (error) *error = "Browser target ref is stale. Take a new snapshot.";
        return false;
      }
      if (type == "click") {
        if (ref->second.tag != "BUTTON" && ref->second.tag != "A") {
          if (error) *error = "Only inspected buttons and links can be clicked.";
          return false;
        }
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!el || !el.isConnected) throw new Error('stale'); "
            "if (el.tagName !== 'BUTTON' && el.tagName !== 'A') throw new "
            "Error('role'); el.click(); return JSON.stringify({ok:true}); })()";
      } else if (type == "type") {
        if (action->GetType("text") != VTYPE_STRING) {
          if (error) *error = "Native visible type text was invalid.";
          return false;
        }
        if (ref->second.input_type == "password" ||
            ref->second.role != "textbox") {
          if (error) *error = "This target does not support typing.";
          return false;
        }
        const std::string text = action->GetString("text").ToString();
        if (text.size() > 20000) {
          if (error) *error = "Native visible type text was too long.";
          return false;
        }
        const std::string text_json = json_string_literal(text);
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!el || !el.isConnected) throw new Error('stale'); "
            "if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') throw new "
            "Error('role'); if ((el.getAttribute('type')||'').toLowerCase()==="
            "'password') throw new Error('sensitive'); "
            "const proto = el.tagName === 'TEXTAREA' ? "
            "HTMLTextAreaElement.prototype : HTMLInputElement.prototype; "
            "const setter = Object.getOwnPropertyDescriptor(proto,'value').set; "
            "setter.call(el, " +
            text_json +
            "); el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); "
            "return JSON.stringify({ok: el.value === " +
            text_json + "}); })()";
      } else {
        if (action->GetType("value") != VTYPE_STRING ||
            ref->second.tag != "SELECT") {
          if (error) *error = "Native visible select was invalid.";
          return false;
        }
        const std::string value = action->GetString("value").ToString();
        if (value.size() > 2000) {
          if (error) *error = "Native visible select value was too long.";
          return false;
        }
        const std::string value_json = json_string_literal(value);
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!(el instanceof HTMLSelectElement)) throw new "
            "Error('stale'); el.value = " +
            value_json +
            "; el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); "
            "return JSON.stringify({ok: el.value === " +
            value_json + "}); })()";
      }
    } else if (type == "key") {
      if (action->GetType("key") != VTYPE_STRING) {
        if (error) *error = "Native visible key was invalid.";
        return false;
      }
      const std::string key = action->GetString("key").ToString();
      if (key.size() > 20 || key.find('"') != std::string::npos) {
        if (error) *error = "Native visible key was invalid.";
        return false;
      }
      expression =
          std::string("(() => { const key = \"") + key +
          "\"; const el = document.activeElement || document.body; "
          "el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); "
          "el.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})); "
          "return JSON.stringify({ok:true}); })()";
    } else if (type == "scroll") {
      const int x = action->GetType("x") == VTYPE_INT ? action->GetInt("x")
                    : action->GetType("x") == VTYPE_DOUBLE
                        ? static_cast<int>(action->GetDouble("x"))
                        : 0;
      const int y = action->GetType("y") == VTYPE_INT ? action->GetInt("y")
                    : action->GetType("y") == VTYPE_DOUBLE
                        ? static_cast<int>(action->GetDouble("y"))
                        : 0;
      expression = "(() => { window.scrollBy(" + std::to_string(x) + ", " +
                   std::to_string(y) +
                   "); return JSON.stringify({ok:true}); })()";
    } else {
      if (error) *error = "Native visible-act type is unsupported.";
      return false;
    }
    tab->pending_act_request_id = request_id;
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("expression", expression);
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", false);
    if (!CallUserBrowserDevToolsMethod(*tab, "Runtime.evaluate", params,
                                       "visible-act", error)) {
      tab->pending_act_request_id.clear();
      return false;
    }
    return true;
  }

  bool CaptureVisibleScreenshot(NativeUserBrowserTab& tab, std::string* error) {
    if (tab.view) {
      tab.view->SetBounds(
          CefRect(0, 0, tab.viewport_width, tab.viewport_height));
      tab.view->SetVisible(true);
    }
    CefRefPtr<CefDictionaryValue> enable_params = CefDictionaryValue::Create();
    if (!CallUserBrowserDevToolsMethod(tab, "Page.enable", enable_params,
                                       "visible-screenshot-enable", error)) {
      return false;
    }
    return true;
  }

  bool CaptureVisibleScreenshotFrame(NativeUserBrowserTab& tab,
                                     std::string* error) {
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("format", "png");
    params->SetBool("fromSurface", true);
    params->SetBool("captureBeyondViewport", false);
    return CallUserBrowserDevToolsMethod(tab, "Page.captureScreenshot", params,
                                         "visible-screenshot", error);
  }

  void OnUserBrowserDevToolsResult(const std::string& tab_id, int message_id,
                                   bool success, std::string result_json) {
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    const auto kind_it = tab->pending_devtools_kinds.find(message_id);
    if (kind_it == tab->pending_devtools_kinds.end()) return;
    const std::string kind = kind_it->second;
    tab->pending_devtools_kinds.erase(kind_it);

    auto extract_evaluate_value = [&](std::string* value_json) -> bool {
      if (!success) return false;
      CefRefPtr<CefValue> parsed = CefParseJSON(result_json, JSON_PARSER_RFC);
      if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) return false;
      CefRefPtr<CefDictionaryValue> root = parsed->GetDictionary();
      if (root->HasKey("exceptionDetails")) return false;
      if (root->GetType("result") != VTYPE_DICTIONARY) return false;
      CefRefPtr<CefDictionaryValue> result = root->GetDictionary("result");
      if (result->GetType("value") != VTYPE_STRING) return false;
      *value_json = result->GetString("value").ToString();
      return !value_json->empty();
    };

    if (kind == "visible-snapshot") {
      const std::string request_id = tab->pending_snapshot_request_id;
      tab->pending_snapshot_request_id.clear();
      if (request_id.empty()) return;
      std::string value_json;
      if (!extract_evaluate_value(&value_json)) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible snapshot failed.");
        return;
      }
      CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
      if (!payload || payload->GetType() != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible snapshot was invalid.");
        return;
      }
      CefRefPtr<CefDictionaryValue> body = payload->GetDictionary();
      tab->element_refs.clear();
      if (body->GetType("interactive") == VTYPE_LIST) {
        CefRefPtr<CefListValue> interactive = body->GetList("interactive");
        for (size_t index = 0; index < interactive->GetSize(); ++index) {
          if (interactive->GetType(index) != VTYPE_DICTIONARY) continue;
          CefRefPtr<CefDictionaryValue> item = interactive->GetDictionary(index);
          if (item->GetType("ref") != VTYPE_STRING) continue;
          NativeAutomationElementRef entry;
          entry.role = item->GetType("role") == VTYPE_STRING
                           ? item->GetString("role").ToString()
                           : "";
          entry.tag = item->GetType("tag") == VTYPE_STRING
                          ? item->GetString("tag").ToString()
                          : "";
          entry.input_type = item->GetType("inputType") == VTYPE_STRING
                                 ? item->GetString("inputType").ToString()
                                 : "";
          tab->element_refs[item->GetString("ref").ToString()] = entry;
          item->Remove("tag");
          item->Remove("inputType");
        }
      }
      CefRefPtr<CefDictionaryValue> response = CefDictionaryValue::Create();
      response->SetString("url", tab->url);
      response->SetString("title", tab->title);
      if (body->HasKey("accessibilityTree")) {
        response->SetValue("accessibilityTree",
                           body->GetValue("accessibilityTree"));
      }
      if (body->HasKey("interactive")) {
        response->SetValue("interactive", body->GetValue("interactive"));
      }
      response->SetBool("truncated", body->GetBool("truncated"));
      response->SetString("trust", "untrusted_browser");
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetDictionary(response);
      std::cout << "KESTREL_NATIVE_CHROMIUM_VISIBLE_SNAPSHOT_OK id=" << tab_id
                << std::endl;
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }

    if (kind == "visible-context") {
      const std::string request_id = tab->pending_context_request_id;
      tab->pending_context_request_id.clear();
      if (request_id.empty()) return;
      std::string value_json;
      if (!extract_evaluate_value(&value_json)) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible context failed.");
        return;
      }
      CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
      if (!payload || payload->GetType() != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible context was invalid.");
        return;
      }
      CefRefPtr<CefDictionaryValue> body = payload->GetDictionary();
      if (tab->url.empty() ||
          (tab->url.rfind("http://", 0) != 0 &&
           tab->url.rfind("https://", 0) != 0)) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "The selected tab does not have a safe readable URL.");
        return;
      }
      CefRefPtr<CefDictionaryValue> response = CefDictionaryValue::Create();
      response->SetString("tabId", tab->id);
      response->SetString("url", tab->url);
      response->SetString(
          "title",
          renderer_safe_text(tab->title.empty() ? "Untitled" : tab->title, 500));
      if (body->GetType("description") == VTYPE_STRING) {
        response->SetString(
            "description",
            renderer_safe_text(body->GetString("description").ToString(), 2000,
                               ""));
      }
      response->SetString(
          "selectedText",
          body->GetType("selectedText") == VTYPE_STRING
              ? renderer_safe_text(body->GetString("selectedText").ToString(),
                                   20000, "")
              : "");
      response->SetString(
          "visibleText",
          body->GetType("visibleText") == VTYPE_STRING
              ? renderer_safe_text(body->GetString("visibleText").ToString(),
                                   40000, "")
              : "");
      if (body->HasKey("headings")) {
        response->SetValue("headings", body->GetValue("headings"));
      } else {
        response->SetList("headings", CefListValue::Create());
      }
      if (body->HasKey("links")) {
        response->SetValue("links", body->GetValue("links"));
      } else {
        response->SetList("links", CefListValue::Create());
      }
      if (body->HasKey("forms")) {
        response->SetValue("forms", body->GetValue("forms"));
      } else {
        response->SetList("forms", CefListValue::Create());
      }
      if (body->GetType("viewport") == VTYPE_DICTIONARY) {
        response->SetDictionary("viewport", body->GetDictionary("viewport"));
      } else {
        CefRefPtr<CefDictionaryValue> viewport = CefDictionaryValue::Create();
        viewport->SetInt("width", tab->viewport_width);
        viewport->SetInt("height", tab->viewport_height);
        viewport->SetDouble("scrollX", 0);
        viewport->SetDouble("scrollY", 0);
        response->SetDictionary("viewport", viewport);
      }
      response->SetString("capturedAt", iso8601_now());
      response->SetString("trust", "untrusted_browser");
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetDictionary(response);
      std::cout << "KESTREL_NATIVE_CHROMIUM_VISIBLE_CONTEXT_OK id=" << tab_id
                << std::endl;
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }

    if (kind == "visible-act") {
      const std::string request_id = tab->pending_act_request_id;
      tab->pending_act_request_id.clear();
      if (request_id.empty()) return;
      std::string value_json;
      bool ok = false;
      if (extract_evaluate_value(&value_json)) {
        CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
        if (payload && payload->GetType() == VTYPE_DICTIONARY) {
          ok = payload->GetDictionary()->GetBool("ok");
        }
      }
      if (!ok) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible action was refused or the target changed.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_VISIBLE_ACT_OK id=" << tab_id
                << std::endl;
      SendBrowserBackendResponse(request_id, true, "{\"performed\":true}", "");
      return;
    }

    if (kind == "visible-screenshot-guard") {
      const std::string request_id = tab->pending_screenshot_request_id;
      if (request_id.empty()) return;
      std::string value_json;
      if (!extract_evaluate_value(&value_json)) {
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible screenshot guard failed.");
        return;
      }
      CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
      if (payload && payload->GetType() == VTYPE_DICTIONARY &&
          payload->GetDictionary()->GetBool("sensitive")) {
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Kestrel does not share browser screenshots from pages with "
            "sensitive input fields.");
        return;
      }
      std::string error;
      if (!CaptureVisibleScreenshot(*tab, &error)) {
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium visible screenshot failed."
                          : error);
      }
      return;
    }

    if (kind == "visible-screenshot-enable") {
      const std::string request_id = tab->pending_screenshot_request_id;
      if (request_id.empty()) return;
      if (!success) {
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible screenshot could not enable Page domain.");
        return;
      }
      std::string error;
      if (!CaptureVisibleScreenshotFrame(*tab, &error)) {
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium visible screenshot failed."
                          : error);
      }
      return;
    }

    if (kind == "visible-screenshot") {
      const std::string request_id = tab->pending_screenshot_request_id;
      tab->pending_screenshot_request_id.clear();
      if (request_id.empty()) return;
      if (!success) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible screenshot failed.");
        return;
      }
      CefRefPtr<CefValue> parsed = CefParseJSON(result_json, JSON_PARSER_RFC);
      if (!parsed || parsed->GetType() != VTYPE_DICTIONARY ||
          parsed->GetDictionary()->GetType("data") != VTYPE_STRING) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible screenshot was invalid.");
        return;
      }
      const std::string png_b64 =
          parsed->GetDictionary()->GetString("data").ToString();
      std::vector<uint8_t> png = base64_decode_bytes(png_b64);
      int width = 0;
      int height = 0;
      std::vector<uint8_t> rgba;
      if (png.size() < 8 || png[0] != 0x89 || png[1] != 'P' || png[2] != 'N' ||
          png[3] != 'G' || !decode_png_to_rgba(png, &width, &height, &rgba) ||
          width <= 0 || height <= 0 ||
          static_cast<size_t>(width) * static_cast<size_t>(height) * 4 !=
              rgba.size() ||
          png.size() > 10'000'000) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium visible screenshot frame was invalid.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_VISIBLE_SCREENSHOT_OK id=" << tab_id
                << " width=" << width << " height=" << height << std::endl;
      SendBrowserBackendResponse(
          request_id, true,
          encode_screenshot_frame_json(width, height, rgba, png, true), "");
      return;
    }
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
    state->SetList("history", browser_library_.SerializeHistory());
    state->SetList("originFavicons", CefListValue::Create());
    state->SetList("downloads", browser_library_.SerializeDownloads());
    state->SetList("bookmarks", browser_library_.SerializeBookmarks());
    state->SetList("bookmarkFolders",
                   browser_library_.SerializeBookmarkFolders());
    state->SetList("recentlyClosedTabs", CefListValue::Create());
    state->SetList("sitePermissions",
                   browser_library_.SerializeSitePermissions());

    // Settings stay at honest new-profile defaults. Bookmarks/history/
    // downloads/permissions persist only under --kestrel-durable-profile into
    // the isolated native profile, never the Electron Application Support path.
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

  bool credential_store_ready() const { return credential_store_opened_; }

  std::string SerializeCredentialListJson() const {
    std::string json = "{\"ok\":true,\"credentials\":[";
    bool first = true;
    if (credential_store_opened_) {
      for (const NativeCredentialSummary& item : credential_store_.List()) {
        if (!first) json += ",";
        first = false;
        json += "{\"id\":\"" + json_escape(item.id) + "\",\"label\":\"" +
                json_escape(item.label) + "\",\"configured\":" +
                (item.configured ? "true" : "false") + "}";
      }
    }
    json += "]}";
    return json;
  }

  void RunCredentialBootstrapSmoke() {
    if (!credential_store_opened_) {
      std::cerr << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_FAILED error="
                   "Credential storage did not open."
                << std::endl;
      return;
    }
    if (credential_store_.mode() != NativeCredentialStorageMode::ProfileSealed) {
      std::cerr << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_FAILED error="
                   "Credential smoke requires profile-sealed storage."
                << std::endl;
      return;
    }
    std::string error;
    constexpr char kSmokeId[] = "openai";
    constexpr char kSmokeValue[] = "sk-kestrel-native-credential-smoke";
    if (!credential_store_.Set(kSmokeId, kSmokeValue, &error) ||
        !credential_store_.Has(kSmokeId) ||
        !credential_store_.Remove(kSmokeId, &error) ||
        credential_store_.Has(kSmokeId)) {
      std::cerr << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_FAILED error="
                << (error.empty() ? "Credential smoke round-trip failed."
                                  : error)
                << std::endl;
      return;
    }
    std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_OK mode="
              << credential_store_.mode_name() << std::endl;
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
    if (!tab.pending_screenshot_request_id.empty()) {
      SendBrowserBackendResponse(tab.pending_screenshot_request_id, false, "",
                                 "Native Chromium browser tab closed.");
      tab.pending_screenshot_request_id.clear();
    }
    if (!tab.pending_snapshot_request_id.empty()) {
      SendBrowserBackendResponse(tab.pending_snapshot_request_id, false, "",
                                 "Native Chromium browser tab closed.");
      tab.pending_snapshot_request_id.clear();
    }
    if (!tab.pending_context_request_id.empty()) {
      SendBrowserBackendResponse(tab.pending_context_request_id, false, "",
                                 "Native Chromium browser tab closed.");
      tab.pending_context_request_id.clear();
    }
    if (!tab.pending_act_request_id.empty()) {
      SendBrowserBackendResponse(tab.pending_act_request_id, false, "",
                                 "Native Chromium browser tab closed.");
      tab.pending_act_request_id.clear();
    }
    tab.pending_devtools_kinds.clear();
    tab.element_refs.clear();
    tab.devtools_registration = nullptr;
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

    // Extension-capable user browsing shares the default Chromium profile so
    // --load-extension and chrome.storage survive with the same storage that
    // Chromium owns. The privileged shell uses a separate cache path.
    if (user_extensions_enabled_) {
      user_browser_context_ = CefRequestContext::GetGlobalContext();
      if (!user_browser_context_) {
        if (error) {
          *error = "The native Chromium user-browser profile is unavailable.";
        }
        return false;
      }
      OnUserBrowserContextInitialized(user_browser_context_);
      return true;
    }

    CefRequestContextSettings user_browser_settings;
    CefString(&user_browser_settings.cache_path) = user_browser_cache_path_;
    // Durable profiles keep session cookies on disk. Ephemeral profiles stay
    // transient until an explicit migration/credential path exists.
    user_browser_settings.persist_session_cookies = durable_profile_enabled;
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
    for (auto& [session_id, session] : automation_sessions_) {
      (void)session_id;
      if (session.closing || session.view) continue;
      session.context = user_browser_context_;
      session.context_ready = true;
      std::string error;
      if (!AttachAutomationBrowserView(session, &error)) {
        if (!session.pending_navigate_request_id.empty()) {
          SendBrowserBackendResponse(
              session.pending_navigate_request_id, false, "",
              error.empty()
                  ? "Kestrel could not create the isolated browser view."
                  : error);
          session.pending_navigate_request_id.clear();
          session.pending_navigate_target_url.clear();
        }
        session.closing = true;
      }
    }
    for (auto it = automation_sessions_.begin();
         it != automation_sessions_.end();) {
      if (it->second.closing && !it->second.view) {
        it = automation_sessions_.erase(it);
      } else {
        ++it;
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
        },
        [this, owner_token](const std::string& /*opener_tab_id*/,
                            const std::string& url) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          std::string create_error;
          if (!CreateUserBrowserTab(url, true, &create_error)) {
            std::cerr << "Kestrel could not adopt a native browser popup: "
                      << create_error << std::endl;
          }
        },
        [this, owner_token](const std::string& suggested_name) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return std::string();
          return ResolveDownloadPath(suggested_name);
        },
        [this, owner_token](const std::string& tab_id, uint32_t cef_download_id,
                            const std::string& source_url,
                            const std::string& filename,
                            const std::string& full_path,
                            int64_t received_bytes, int64_t total_bytes,
                            const std::string& status,
                            CefRefPtr<CefDownloadItemCallback> callback) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserDownload(tab_id, cef_download_id, source_url,
                                      filename, full_path, received_bytes,
                                      total_bytes, status, callback);
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
    auto automation = automation_sessions_.find(tab_id);
    if (automation != automation_sessions_.end()) {
      automation->second.url = url;
      return;
    }
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->url = url;
    tab->error.clear();
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserTitleChanged(const std::string& tab_id,
                                       const std::string& title) {
    auto automation = automation_sessions_.find(tab_id);
    if (automation != automation_sessions_.end()) {
      automation->second.title = title;
      return;
    }
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (!tab) return;
    tab->title = title;
    PublishUserBrowserState();
  }

  void OnNativeUserBrowserLoadEnd(const std::string& tab_id,
                                  const std::string& url) {
    auto automation = automation_sessions_.find(tab_id);
    if (automation != automation_sessions_.end()) {
      automation->second.url = url;
      automation->second.loading = false;
      // Ignore about:blank (and other non-target loads) while a navigate is
      // outstanding so the create→navigate smoke does not complete early.
      if (!automation->second.pending_navigate_request_id.empty() &&
          !automation->second.pending_navigate_target_url.empty()) {
        const auto loaded = safe_user_browser_url(url);
        const std::string target =
            automation->second.pending_navigate_target_url;
        if (loaded &&
            (url == target ||
             http_origin_from_url(*loaded) == http_origin_from_url(target))) {
          SendBrowserBackendResponse(
              automation->second.pending_navigate_request_id, true, "null", "");
          automation->second.pending_navigate_request_id.clear();
          automation->second.pending_navigate_target_url.clear();
        }
      }
      return;
    }
    if (smoke_user_browser_url && url == *smoke_user_browser_url) {
      std::cout << "KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK url=" << url
                << std::endl;
    }
    RecordHistoryVisit(tab_id, url);
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    if (tab) {
      // LoadEnd can race ahead of LoadingStateChange(false). Treat the document
      // as ready here so a queued visible-screenshot can start.
      tab->loading = false;
      tab->url = url;
    }
    PublishUserBrowserState();
    if (tab && !tab->pending_snapshot_request_id.empty()) {
      std::string error;
      if (!StartPendingVisibleSnapshot(*tab, &error)) {
        const std::string request_id = tab->pending_snapshot_request_id;
        tab->pending_snapshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium visible snapshot failed." : error);
      }
    }
    if (tab && !tab->pending_context_request_id.empty()) {
      std::string error;
      if (!StartPendingVisibleContext(*tab, &error)) {
        const std::string request_id = tab->pending_context_request_id;
        tab->pending_context_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium visible context failed." : error);
      }
    }
    if (tab && !tab->pending_screenshot_request_id.empty()) {
      std::string error;
      if (!StartPendingVisibleScreenshot(*tab, &error)) {
        const std::string request_id = tab->pending_screenshot_request_id;
        tab->pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium visible screenshot failed."
                          : error);
      }
    }
  }

  std::string SanitizeDownloadFilename(std::string requested) const {
    for (char& character : requested) {
      const unsigned char value = static_cast<unsigned char>(character);
      if (!(std::isalnum(value) || character == '.' || character == '_' ||
            character == '-')) {
        character = '-';
      }
    }
    if (requested.size() > 120) requested.resize(120);
    while (!requested.empty() &&
           (requested.front() == '.' || requested.front() == '-')) {
      requested.erase(requested.begin());
    }
    return requested.empty() ? "download.bin" : requested;
  }

  std::string ResolveDownloadPath(const std::string& suggested_name) {
    if (isolated_profile_root_.empty()) return {};
    const std::string directory = isolated_profile_root_ + "/downloads";
    NSFileManager* files = [NSFileManager defaultManager];
    NSString* directory_ns =
        [NSString stringWithUTF8String:directory.c_str()];
    if (![files fileExistsAtPath:directory_ns]) {
      NSError* error = nil;
      if (![files createDirectoryAtPath:directory_ns
            withIntermediateDirectories:YES
                             attributes:@{NSFilePosixPermissions : @0700}
                                  error:&error]) {
        return {};
      }
    }
    std::string filename = SanitizeDownloadFilename(suggested_name);
    std::string path = directory + "/" + filename;
    NSString* path_ns = [NSString stringWithUTF8String:path.c_str()];
    if (![files fileExistsAtPath:path_ns]) return path;
    const auto dot = filename.find_last_of('.');
    const std::string stem =
        dot == std::string::npos ? filename : filename.substr(0, dot);
    const std::string extension =
        dot == std::string::npos ? "" : filename.substr(dot);
    for (int index = 2; index < 10'000; ++index) {
      path = directory + "/" + stem + "-" + std::to_string(index) + extension;
      path_ns = [NSString stringWithUTF8String:path.c_str()];
      if (![files fileExistsAtPath:path_ns]) return path;
    }
    return directory + "/download-" + native_uuid() + ".bin";
  }

  void OnNativeUserBrowserDownload(
      const std::string& tab_id, uint32_t cef_download_id,
      const std::string& source_url, const std::string& filename,
      const std::string& full_path, int64_t received_bytes, int64_t total_bytes,
      const std::string& status,
      CefRefPtr<CefDownloadItemCallback> callback) {
    if (!is_http_url(source_url)) return;
    std::string download_id;
    const auto existing_id = cef_download_ids_.find(cef_download_id);
    if (existing_id != cef_download_ids_.end()) {
      download_id = existing_id->second;
    } else {
      download_id = "download-" + native_uuid();
      cef_download_ids_[cef_download_id] = download_id;
      DurableDownload download;
      download.id = download_id;
      download.tab_id = tab_id;
      download.filename = SanitizeDownloadFilename(filename);
      download.source_url = source_url;
      download.received_bytes = std::max<int64_t>(0, received_bytes);
      download.total_bytes = std::max<int64_t>(0, total_bytes);
      download.status = status;
      download.started_at = iso8601_now();
      download.can_reveal = false;
      browser_library_.downloads.insert(browser_library_.downloads.begin(),
                                        std::move(download));
      if (browser_library_.downloads.size() >
          DurableBrowserLibrary::kMaxDownloads) {
        browser_library_.downloads.resize(
            DurableBrowserLibrary::kMaxDownloads);
      }
    }
    if (callback) download_cancel_callbacks_[download_id] = callback;
    if (!full_path.empty()) download_paths_[download_id] = full_path;

    DurableDownload* record = nullptr;
    for (DurableDownload& item : browser_library_.downloads) {
      if (item.id == download_id) {
        record = &item;
        break;
      }
    }
    if (!record) return;
    record->filename = SanitizeDownloadFilename(
        filename.empty() ? record->filename : filename);
    record->source_url = source_url;
    record->received_bytes = std::max<int64_t>(0, received_bytes);
    record->total_bytes = std::max<int64_t>(0, total_bytes);
    record->status = status;
    if (status == "completed") {
      record->completed_at = iso8601_now();
      record->can_reveal = !full_path.empty();
      download_cancel_callbacks_.erase(download_id);
      if (smoke_download_url && source_url == *smoke_download_url) {
        std::cout << "KESTREL_NATIVE_CHROMIUM_DOWNLOAD_CAPTURE_OK"
                  << " filename=" << record->filename
                  << " bytes=" << record->received_bytes << std::endl;
      }
    } else if (status == "cancelled" || status == "failed") {
      record->completed_at = iso8601_now();
      record->can_reveal = false;
      download_cancel_callbacks_.erase(download_id);
    }
    PersistBrowserLibrary();
    PublishUserBrowserState();
  }

  bool PersistBrowserLibrary() {
    if (!durable_profile_enabled || isolated_profile_root_.empty()) {
      return true;
    }
    if (!browser_library_.Save(isolated_profile_root_)) {
      std::cerr << "Kestrel could not persist the durable browser library."
                << std::endl;
      return false;
    }
    return true;
  }

  void RecordHistoryVisit(const std::string& tab_id, const std::string& url) {
    if (!is_http_url(url) || tab_id.empty()) return;
    NativeUserBrowserTab* tab = FindUserBrowserTab(tab_id);
    DurableHistoryEntry entry;
    entry.id = "visit-" + native_uuid();
    entry.tab_id = tab_id;
    entry.url = url;
    entry.title =
        renderer_safe_text(tab ? tab->title : "", 500, "Untitled");
    entry.visited_at = iso8601_now();
    browser_library_.history.insert(browser_library_.history.begin(),
                                    std::move(entry));
    if (browser_library_.history.size() >
        DurableBrowserLibrary::kMaxHistory) {
      browser_library_.history.resize(DurableBrowserLibrary::kMaxHistory);
    }
    PersistBrowserLibrary();
  }

  bool is_http_url(const std::string& url) const {
    return url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0;
  }

  std::string OriginFromUrl(const std::string& url) const {
    const auto scheme_end = url.find("://");
    if (scheme_end == std::string::npos) return {};
    const size_t host_start = scheme_end + 3;
    const size_t host_end = url.find_first_of("/?#", host_start);
    if (host_end == std::string::npos) return url;
    return url.substr(0, host_end);
  }

  void SeedDurableLibrarySmoke() {
    DurableBookmark bookmark;
    bookmark.id = "bookmark-" + native_uuid();
    bookmark.url = "https://example.com/kestrel-durable-bookmark";
    bookmark.title = "Kestrel durable bookmark";
    bookmark.display_mode = "full";
    bookmark.created_at = iso8601_now();
    browser_library_.bookmarks.insert(browser_library_.bookmarks.begin(),
                                      std::move(bookmark));

    DurableHistoryEntry visit;
    visit.id = "visit-" + native_uuid();
    visit.tab_id = user_browser_active_tab_id_.empty()
                       ? "tab-" + native_uuid()
                       : user_browser_active_tab_id_;
    visit.url = "https://example.com/kestrel-durable-history";
    visit.title = "Kestrel durable history";
    visit.visited_at = iso8601_now();
    browser_library_.history.insert(browser_library_.history.begin(),
                                    std::move(visit));

    DurableDownload download;
    download.id = "download-" + native_uuid();
    download.filename = "kestrel-durable.txt";
    download.source_url = "https://example.com/kestrel-durable.txt";
    download.received_bytes = 12;
    download.total_bytes = 12;
    download.status = "completed";
    download.started_at = iso8601_now();
    download.completed_at = download.started_at;
    download.can_reveal = false;
    browser_library_.downloads.insert(browser_library_.downloads.begin(),
                                      std::move(download));

    DurableSitePermission permission;
    permission.origin = "https://example.com";
    permission.permission = "notifications";
    permission.decision = "deny";
    permission.updated_at = iso8601_now();
    browser_library_.site_permissions = {std::move(permission)};

    if (!PersistBrowserLibrary()) {
      std::cerr << "KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_WRITE_FAILED"
                << std::endl;
      return;
    }
    std::cout << "KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_WRITE_OK"
              << " bookmarks=" << browser_library_.bookmarks.size()
              << " history=" << browser_library_.history.size()
              << " downloads=" << browser_library_.downloads.size()
              << " permissions="
              << browser_library_.site_permissions.size() << std::endl;
  }

  void VerifyDurableLibrarySmoke() {
    const bool bookmarks_ok = std::any_of(
        browser_library_.bookmarks.begin(), browser_library_.bookmarks.end(),
        [](const DurableBookmark& bookmark) {
          return bookmark.url ==
                 "https://example.com/kestrel-durable-bookmark";
        });
    const bool history_ok = std::any_of(
        browser_library_.history.begin(), browser_library_.history.end(),
        [](const DurableHistoryEntry& entry) {
          return entry.url == "https://example.com/kestrel-durable-history";
        });
    const bool downloads_ok = std::any_of(
        browser_library_.downloads.begin(), browser_library_.downloads.end(),
        [](const DurableDownload& download) {
          return download.filename == "kestrel-durable.txt";
        });
    const bool permissions_ok = std::any_of(
        browser_library_.site_permissions.begin(),
        browser_library_.site_permissions.end(),
        [](const DurableSitePermission& permission) {
          return permission.origin == "https://example.com" &&
                 permission.permission == "notifications" &&
                 permission.decision == "deny";
        });
    if (bookmarks_ok && history_ok && downloads_ok && permissions_ok) {
      std::cout << "KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_RESTORE_OK"
                << std::endl;
    } else {
      std::cerr << "KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_RESTORE_FAILED"
                << " bookmarks=" << bookmarks_ok << " history=" << history_ok
                << " downloads=" << downloads_ok
                << " permissions=" << permissions_ok << std::endl;
    }
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
    auto automation = automation_sessions_.find(tab_id);
    if (automation != automation_sessions_.end()) {
      automation->second.loading = false;
      if (!automation->second.pending_navigate_request_id.empty()) {
        SendBrowserBackendResponse(
            automation->second.pending_navigate_request_id, false, "",
            "Native Chromium browser navigation is outside the origin allowlist.");
        automation->second.pending_navigate_request_id.clear();
        automation->second.pending_navigate_target_url.clear();
      }
      return;
    }
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

    if (type == "credential-list") {
      callback->Success(SerializeCredentialListJson());
      std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_LIST_OK mode="
                << (credential_store_ready() ? credential_store_.mode_name()
                                             : "unavailable")
                << std::endl;
      return true;
    }
    if (type == "credential-set") {
      if (request->GetType("credentialId") != VTYPE_STRING ||
          request->GetType("value") != VTYPE_STRING) {
        RespondNativeError(callback, "Native credential-set was invalid.");
        return true;
      }
      if (!credential_store_ready()) {
        RespondNativeError(callback,
                           "Native credential storage is unavailable.");
        return true;
      }
      std::string error;
      if (!credential_store_.Set(request->GetString("credentialId").ToString(),
                                 request->GetString("value").ToString(),
                                 &error)) {
        RespondNativeError(callback, error);
        return true;
      }
      callback->Success(SerializeCredentialListJson());
      std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_SET_OK id="
                << request->GetString("credentialId").ToString() << std::endl;
      return true;
    }
    if (type == "credential-remove") {
      if (request->GetType("credentialId") != VTYPE_STRING) {
        RespondNativeError(callback, "Native credential-remove was invalid.");
        return true;
      }
      if (!credential_store_ready()) {
        RespondNativeError(callback,
                           "Native credential storage is unavailable.");
        return true;
      }
      std::string error;
      if (!credential_store_.Remove(
              request->GetString("credentialId").ToString(), &error)) {
        RespondNativeError(callback, error);
        return true;
      }
      callback->Success(SerializeCredentialListJson());
      std::cout << "KESTREL_NATIVE_CHROMIUM_CREDENTIAL_REMOVE_OK id="
                << request->GetString("credentialId").ToString() << std::endl;
      return true;
    }
    // Subscription CLI and local-model probes stay deferred/empty until those
    // ownership paths are migrated. Keep them prompt-free.
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
    if (type == "browser-toggle-bookmark") {
      std::string url =
          request->HasKey("url") && request->GetType("url") == VTYPE_STRING
              ? request->GetString("url").ToString()
              : "";
      std::string title =
          request->HasKey("title") && request->GetType("title") == VTYPE_STRING
              ? request->GetString("title").ToString()
              : "";
      if (url.empty()) {
        NativeUserBrowserTab* active =
            FindUserBrowserTab(user_browser_active_tab_id_);
        if (active) {
          url = active->url;
          if (title.empty()) title = active->title;
        }
      }
      if (!is_http_url(url)) {
        RespondNativeError(callback,
                           "Only HTTP and HTTPS pages can be bookmarked.");
        return true;
      }
      const auto existing = std::find_if(
          browser_library_.bookmarks.begin(), browser_library_.bookmarks.end(),
          [&url](const DurableBookmark& bookmark) {
            return bookmark.url == url;
          });
      if (existing != browser_library_.bookmarks.end()) {
        browser_library_.bookmarks.erase(existing);
      } else {
        if (browser_library_.bookmarks.size() >=
            DurableBrowserLibrary::kMaxBookmarks) {
          RespondNativeError(callback,
                             "Kestrel supports up to 2,000 bookmarks.");
          return true;
        }
        DurableBookmark bookmark;
        bookmark.id = "bookmark-" + native_uuid();
        bookmark.url = url;
        bookmark.title = renderer_safe_text(title, 500, "Untitled");
        bookmark.display_mode = "full";
        bookmark.created_at = iso8601_now();
        browser_library_.bookmarks.insert(browser_library_.bookmarks.begin(),
                                          std::move(bookmark));
      }
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-remove-bookmark") {
      if (request->GetType("bookmarkId") != VTYPE_STRING) {
        RespondNativeError(callback, "The bookmark was invalid.");
        return true;
      }
      const std::string bookmark_id =
          request->GetString("bookmarkId").ToString();
      const auto before = browser_library_.bookmarks.size();
      browser_library_.bookmarks.erase(
          std::remove_if(browser_library_.bookmarks.begin(),
                         browser_library_.bookmarks.end(),
                         [&bookmark_id](const DurableBookmark& bookmark) {
                           return bookmark.id == bookmark_id;
                         }),
          browser_library_.bookmarks.end());
      if (browser_library_.bookmarks.size() == before) {
        RespondNativeError(callback, "This bookmark no longer exists.");
        return true;
      }
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-clear-history") {
      browser_library_.history.clear();
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-cancel-download") {
      if (request->GetType("downloadId") != VTYPE_STRING) {
        RespondNativeError(callback, "The download was invalid.");
        return true;
      }
      const std::string download_id =
          request->GetString("downloadId").ToString();
      const auto cancel = download_cancel_callbacks_.find(download_id);
      if (cancel != download_cancel_callbacks_.end() && cancel->second) {
        cancel->second->Cancel();
        download_cancel_callbacks_.erase(cancel);
      }
      for (DurableDownload& item : browser_library_.downloads) {
        if (item.id == download_id && item.status == "progressing") {
          item.status = "cancelled";
          item.completed_at = iso8601_now();
          item.can_reveal = false;
          break;
        }
      }
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-set-site-permission") {
      if (request->GetType("origin") != VTYPE_STRING ||
          request->GetType("permission") != VTYPE_STRING ||
          request->GetType("decision") != VTYPE_STRING) {
        RespondNativeError(callback, "The site permission was invalid.");
        return true;
      }
      const std::string origin = request->GetString("origin").ToString();
      const std::string permission =
          request->GetString("permission").ToString();
      const std::string decision = request->GetString("decision").ToString();
      if (origin.empty() || permission.empty() ||
          (decision != "allow" && decision != "deny")) {
        RespondNativeError(callback, "The site permission was invalid.");
        return true;
      }
      const std::string normalized_origin = OriginFromUrl(origin).empty()
                                                ? origin
                                                : OriginFromUrl(origin);
      auto existing = std::find_if(
          browser_library_.site_permissions.begin(),
          browser_library_.site_permissions.end(),
          [&](const DurableSitePermission& item) {
            return item.origin == normalized_origin &&
                   item.permission == permission;
          });
      if (existing != browser_library_.site_permissions.end()) {
        existing->decision = decision;
        existing->updated_at = iso8601_now();
      } else {
        if (browser_library_.site_permissions.size() >=
            DurableBrowserLibrary::kMaxSitePermissions) {
          RespondNativeError(
              callback, "Kestrel supports up to 500 site permissions.");
          return true;
        }
        DurableSitePermission item;
        item.origin = normalized_origin;
        item.permission = permission;
        item.decision = decision;
        item.updated_at = iso8601_now();
        browser_library_.site_permissions.push_back(std::move(item));
      }
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-clear-site-permission") {
      if (request->GetType("origin") != VTYPE_STRING ||
          request->GetType("permission") != VTYPE_STRING) {
        RespondNativeError(callback, "The site permission was invalid.");
        return true;
      }
      const std::string origin = request->GetString("origin").ToString();
      const std::string permission =
          request->GetString("permission").ToString();
      const std::string normalized_origin = OriginFromUrl(origin).empty()
                                                ? origin
                                                : OriginFromUrl(origin);
      browser_library_.site_permissions.erase(
          std::remove_if(
              browser_library_.site_permissions.begin(),
              browser_library_.site_permissions.end(),
              [&](const DurableSitePermission& item) {
                return item.origin == normalized_origin &&
                       item.permission == permission;
              }),
          browser_library_.site_permissions.end());
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
      return true;
    }
    if (type == "browser-clear-data") {
      const bool clear_history =
          request->HasKey("history") && request->GetType("history") == VTYPE_BOOL
              ? request->GetBool("history")
              : false;
      const bool clear_cookies =
          request->HasKey("cookies") && request->GetType("cookies") == VTYPE_BOOL
              ? request->GetBool("cookies")
              : false;
      if (clear_history) {
        browser_library_.history.clear();
      }
      if (clear_cookies) {
        browser_library_.site_permissions.clear();
      }
      PersistBrowserLibrary();
      RespondWithBrowserState(callback);
      PublishUserBrowserState();
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

  void SendBrowserBackendResponse(const std::string& request_id, bool ok,
                                  const std::string& result_json,
                                  const std::string& error) {
    if (!core_relay_ || request_id.empty()) return;
    std::string line = "{\"type\":\"browser-backend-response\",\"requestId\":\"" +
                       json_escape(request_id) + "\",\"ok\":" +
                       (ok ? "true" : "false");
    if (ok) {
      line += ",\"result\":" + (result_json.empty() ? "null" : result_json);
    } else {
      line += ",\"error\":\"" + json_escape(error) + "\"";
    }
    line += "}";
    if (![core_relay_ sendLine:[NSString stringWithUTF8String:line.c_str()]]) {
      std::cerr << "Kestrel could not return a native browser backend response."
                << std::endl;
    }
  }

  void HandleBrowserBackendRequest(const std::string& request_id,
                                   CefRefPtr<CefDictionaryValue> request) {
    if (!request || request->GetType("operation") != VTYPE_STRING) {
      SendBrowserBackendResponse(request_id, false, "",
                                 "Native browser backend request was invalid.");
      return;
    }
    const std::string operation = request->GetString("operation").ToString();
    if (operation == "visible-tabs") {
      CefRefPtr<CefListValue> tabs = CefListValue::Create();
      size_t count = 0;
      for (const NativeUserBrowserTab& tab : user_browser_tabs_) {
        if (tab.closing) continue;
        ++count;
      }
      tabs->SetSize(count);
      size_t index = 0;
      for (const NativeUserBrowserTab& tab : user_browser_tabs_) {
        if (tab.closing) continue;
        CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
        item->SetString("id", tab.id);
        item->SetString("title", tab.title);
        item->SetString("url", tab.url);
        item->SetBool("active", tab.id == user_browser_active_tab_id_);
        item->SetBool("loading", tab.loading);
        item->SetBool("discarded", tab.discarded);
        item->SetString("trust", "untrusted_browser");
        tabs->SetDictionary(index++, item);
      }
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetList(tabs);
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }
    if (operation == "visible-create") {
      const std::string input =
          request->HasKey("input") && request->GetType("input") == VTYPE_STRING
              ? request->GetString("input").ToString()
              : "";
      std::string error;
      if (!CreateUserBrowserTab(input, true, &error)) {
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Kestrel could not create a native browser tab."
                          : error);
        return;
      }
      SyncUserBrowserViewVisibility();
      PublishUserBrowserState();
      SendBrowserBackendResponse(
          request_id, true,
          "{\"tabId\":\"" + json_escape(user_browser_active_tab_id_) + "\"}",
          "");
      return;
    }
    if (operation == "visible-navigate") {
      if (request->GetType("tabId") != VTYPE_STRING ||
          request->GetType("input") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native visible-navigate was invalid.");
        return;
      }
      NativeUserBrowserTab* tab =
          FindUserBrowserTab(request->GetString("tabId").ToString());
      if (!tab) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "The requested native browser tab no longer exists.");
        return;
      }
      std::string error;
      if (!NavigateUserBrowserTab(*tab, request->GetString("input").ToString(),
                                  &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
        return;
      }
      SyncUserBrowserViewVisibility();
      PublishUserBrowserState();
      SendBrowserBackendResponse(request_id, true, "{\"navigated\":true}", "");
      return;
    }
    if (operation == "visible-select") {
      if (request->GetType("tabId") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native visible-select was invalid.");
        return;
      }
      NativeUserBrowserTab* tab =
          FindUserBrowserTab(request->GetString("tabId").ToString());
      if (!tab) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "The requested native browser tab no longer exists.");
        return;
      }
      user_browser_active_tab_id_ = tab->id;
      tab->last_active_at = iso8601_now();
      SyncUserBrowserViewVisibility();
      PublishUserBrowserState();
      SendBrowserBackendResponse(request_id, true, "{\"selected\":true}", "");
      return;
    }
    if (operation == "visible-close") {
      if (request->GetType("tabId") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native visible-close was invalid.");
        return;
      }
      const std::string tab_id = request->GetString("tabId").ToString();
      const auto found = std::find_if(
          user_browser_tabs_.begin(), user_browser_tabs_.end(),
          [&tab_id](const NativeUserBrowserTab& tab) {
            return tab.id == tab_id;
          });
      if (found == user_browser_tabs_.end()) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "The requested native browser tab no longer exists.");
        return;
      }
      CloseUserBrowserView(*found);
      const auto next_active = std::find_if(
          user_browser_tabs_.begin(), user_browser_tabs_.end(),
          [&tab_id](const NativeUserBrowserTab& tab) {
            return tab.id != tab_id && !tab.closing;
          });
      if (next_active != user_browser_tabs_.end()) {
        user_browser_active_tab_id_ = next_active->id;
      } else {
        CreateBlankUserBrowserTab(true);
      }
      SyncUserBrowserViewVisibility();
      PublishUserBrowserState();
      SendBrowserBackendResponse(request_id, true, "{\"closed\":true}", "");
      return;
    }
    if (operation == "visible-history") {
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetList(browser_library_.SerializeHistory());
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }
    if (operation == "visible-downloads") {
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetList(browser_library_.SerializeDownloads());
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }
    if (operation == "visible-screenshot") {
      std::string tab_id;
      if (request->HasKey("tabId") && request->GetType("tabId") == VTYPE_STRING) {
        tab_id = request->GetString("tabId").ToString();
      }
      std::string error;
      if (!BeginVisibleScreenshot(tab_id, request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "visible-snapshot") {
      std::string tab_id;
      if (request->HasKey("tabId") && request->GetType("tabId") == VTYPE_STRING) {
        tab_id = request->GetString("tabId").ToString();
      }
      std::string error;
      if (!BeginVisibleSnapshot(tab_id, request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "visible-context") {
      std::string tab_id;
      if (request->HasKey("tabId") && request->GetType("tabId") == VTYPE_STRING) {
        tab_id = request->GetString("tabId").ToString();
      }
      std::string error;
      if (!BeginVisibleContext(tab_id, request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "visible-autofill") {
      // Website password-vault autofill is not migrated yet. Return the same
      // structured unavailable envelope Electron uses so agent flows keep
      // working instead of treating the operation as a hard backend failure.
      SendBrowserBackendResponse(
          request_id, true,
          "{\"credentialAvailable\":false,\"autofillResult\":\"unavailable\","
          "\"trust\":\"untrusted_browser\"}",
          "");
      std::cout << "KESTREL_NATIVE_CHROMIUM_VISIBLE_AUTOFILL_UNAVAILABLE"
                << std::endl;
      return;
    }
    if (operation == "visible-act") {
      if (request->GetType("action") != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native visible-act was invalid.");
        return;
      }
      std::string tab_id;
      if (request->HasKey("tabId") && request->GetType("tabId") == VTYPE_STRING) {
        tab_id = request->GetString("tabId").ToString();
      }
      std::string error;
      if (!BeginVisibleAct(tab_id, request->GetDictionary("action"), request_id,
                           &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "create") {
      if (request->GetType("allowedOrigins") != VTYPE_LIST) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native isolated browser create requires allowedOrigins.");
        return;
      }
      std::string error;
      const std::string session_id =
          CreateAutomationSession(request->GetList("allowedOrigins"), &error);
      if (session_id.empty()) {
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty()
                ? "Kestrel could not create an isolated native browser session."
                : error);
        return;
      }
      SendBrowserBackendResponse(
          request_id, true, "\"" + json_escape(session_id) + "\"", "");
      return;
    }
    if (operation == "navigate") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          request->GetType("url") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated navigate was invalid.");
        return;
      }
      std::string error;
      if (!NavigateAutomationSession(request->GetString("sessionId").ToString(),
                                     request->GetString("url").ToString(),
                                     request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      // Successful navigate answers asynchronously after load end.
      return;
    }
    if (operation == "snapshot") {
      if (request->GetType("sessionId") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated snapshot was invalid.");
        return;
      }
      std::string error;
      if (!BeginAutomationSnapshot(request->GetString("sessionId").ToString(),
                                   request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "act") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          request->GetType("action") != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated act was invalid.");
        return;
      }
      std::string error;
      if (!BeginAutomationAct(request->GetString("sessionId").ToString(),
                              request->GetDictionary("action"), request_id,
                              &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "screenshot") {
      if (request->GetType("sessionId") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated screenshot was invalid.");
        return;
      }
      std::string error;
      if (!BeginAutomationScreenshot(
              request->GetString("sessionId").ToString(), request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "viewport") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          request->GetType("viewport") != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated viewport was invalid.");
        return;
      }
      std::string error;
      if (!BeginAutomationViewport(request->GetString("sessionId").ToString(),
                                   request->GetDictionary("viewport"),
                                   request_id, &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "upload") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          request->GetType("selector") != VTYPE_STRING ||
          request->GetType("paths") != VTYPE_LIST) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated upload was invalid.");
        return;
      }
      std::string error;
      if (!BeginAutomationUpload(request->GetString("sessionId").ToString(),
                                 request->GetString("selector").ToString(),
                                 request->GetList("paths"), request_id,
                                 &error)) {
        SendBrowserBackendResponse(request_id, false, "", error);
      }
      return;
    }
    if (operation == "close") {
      if (request->GetType("sessionId") != VTYPE_STRING) {
        SendBrowserBackendResponse(request_id, false, "",
                                   "Native isolated close was invalid.");
        return;
      }
      // Answer the relay before tearing down the BrowserView. CloseBrowser on a
      // still-attached Alloy child can synchronously cascade into window close
      // and stop the Core relay before this response is written.
      SendBrowserBackendResponse(request_id, true, "null", "");
      std::string error;
      if (!CloseAutomationSession(request->GetString("sessionId").ToString(),
                                  &error)) {
        std::cerr << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_CLOSE_FAILED error="
                  << error << std::endl;
      }
      return;
    }
    if (operation == "diagnostics") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          !automation_sessions_.count(
              request->GetString("sessionId").ToString())) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser session is unavailable.");
        return;
      }
      SendBrowserBackendResponse(request_id, true, "[]", "");
      return;
    }
    if (operation == "downloads") {
      if (request->GetType("sessionId") != VTYPE_STRING ||
          !automation_sessions_.count(
              request->GetString("sessionId").ToString())) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser session is unavailable.");
        return;
      }
      SendBrowserBackendResponse(request_id, true, "[]", "");
      return;
    }
    SendBrowserBackendResponse(
        request_id, false, "",
        "Native Chromium browser backend operation is not migrated yet: " +
            operation);
  }

  std::string CreateAutomationSession(CefRefPtr<CefListValue> allowed_origins,
                                      std::string* error) {
    if (!allowed_origins || allowed_origins->GetSize() == 0) {
      if (error) *error = "Isolated browser sessions require allowed origins.";
      return {};
    }
    if (automation_sessions_.size() >= 8) {
      if (error) *error = "Kestrel supports up to 8 isolated browser sessions.";
      return {};
    }
    if (!kestrel_window || kestrel_window->IsClosed()) {
      if (error) *error = "The native Kestrel window is unavailable.";
      return {};
    }
    if (isolated_profile_root_.empty()) {
      if (error) *error = "The isolated native browser profile is unavailable.";
      return {};
    }
    std::set<std::string> origins;
    for (size_t index = 0; index < allowed_origins->GetSize(); ++index) {
      if (allowed_origins->GetType(index) != VTYPE_STRING) continue;
      const auto safe =
          safe_user_browser_url(allowed_origins->GetString(index).ToString());
      if (!safe) continue;
      const std::string origin = http_origin_from_url(*safe);
      if (!origin.empty()) origins.insert(origin);
    }
    if (origins.empty()) {
      if (error)
        *error = "Isolated browser sessions require valid HTTP(S) origins.";
      return {};
    }
    // Separate CefRequestContext::CreateContext profiles currently trip CEF
    // 152 observer / profile init failures and tear down the Alloy window.
    // Isolated sessions share the user-browser request context, stay hidden,
    // and enforce origin allowlists per BrowserView until a durable
    // multi-profile path is proven.
    if (!EnsureUserBrowserContext(error)) return {};
    NativeAutomationSession session;
    session.id = "native-browser-" + native_uuid();
    session.allowed_origins = origins;
    session.context = user_browser_context_;
    session.context_ready = user_browser_context_ready_;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    const std::string session_id = session.id;
    session.client = new KestrelUserBrowserClient(
        session.id,
        [this, owner_token](const std::string& id, CefRefPtr<CefBrowser> browser) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          auto found = automation_sessions_.find(id);
          if (found == automation_sessions_.end()) return;
          found->second.browser_ready = true;
          found->second.loading = false;
          EnsureAutomationDevTools(found->second, browser);
          if (!found->second.pending_navigate_url.empty() && browser &&
              browser->IsValid()) {
            const std::string pending_url = found->second.pending_navigate_url;
            found->second.pending_navigate_url.clear();
            found->second.loading = true;
            found->second.url = pending_url;
            browser->GetMainFrame()->LoadURL(pending_url);
          }
        },
        [this, owner_token](const std::string& id, bool loading, bool, bool) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          auto found = automation_sessions_.find(id);
          if (found != automation_sessions_.end()) found->second.loading = loading;
        },
        [this, owner_token](const std::string& id, const std::string& url) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserAddressChanged(id, url);
        },
        [this, owner_token](const std::string& id, const std::string& title) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserTitleChanged(id, title);
        },
        [this, owner_token](const std::string& id, const std::string& url) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserLoadEnd(id, url);
        },
        [this, owner_token](const std::string& id) {
          const std::shared_ptr<bool> alive = owner_token.lock();
          if (!alive || !*alive) return;
          OnNativeUserBrowserNavigationBlocked(id);
        },
        [this, owner_token](const std::string& id, int) {
          if (!owner_token.lock()) return;
          auto found = automation_sessions_.find(id);
          if (found == automation_sessions_.end()) return;
          found->second.closing = true;
          found->second.devtools_registration = nullptr;
          found->second.view = nullptr;
          found->second.client = nullptr;
          found->second.context = nullptr;
          if (!found->second.pending_navigate_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_navigate_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_navigate_request_id.clear();
            found->second.pending_navigate_target_url.clear();
          }
          if (!found->second.pending_snapshot_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_snapshot_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_snapshot_request_id.clear();
          }
          if (!found->second.pending_act_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_act_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_act_request_id.clear();
          }
          if (!found->second.pending_screenshot_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_screenshot_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_screenshot_request_id.clear();
          }
          if (!found->second.pending_viewport_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_viewport_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_viewport_request_id.clear();
          }
          if (!found->second.pending_upload_request_id.empty()) {
            SendBrowserBackendResponse(
                found->second.pending_upload_request_id, false, "",
                "Native Chromium browser session closed.");
            found->second.pending_upload_request_id.clear();
            found->second.pending_upload_selector.clear();
            found->second.pending_upload_paths.clear();
          }
          automation_sessions_.erase(found);
        },
        [](const std::string&, const std::string&) {},
        [](const std::string&) { return std::string(); },
        [](const std::string&, uint32_t, const std::string&, const std::string&,
           const std::string&, int64_t, int64_t, const std::string&,
           CefRefPtr<CefDownloadItemCallback>) {},
        true, origins);
    // Emplace before attaching so an in-flight request-context init callback
    // can see this session. Re-read readiness after emplace to close the race
    // where init runs between EnsureUserBrowserContext and insert.
    automation_sessions_.emplace(session_id, std::move(session));
    auto stored = automation_sessions_.find(session_id);
    if (stored == automation_sessions_.end()) {
      if (error) *error = "Kestrel could not register the isolated session.";
      return {};
    }
    stored->second.context = user_browser_context_;
    stored->second.context_ready = user_browser_context_ready_;
    if (stored->second.context_ready) {
      if (!AttachAutomationBrowserView(stored->second, error)) {
        automation_sessions_.erase(stored);
        return {};
      }
    }
    std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_SESSION_CREATED id="
              << session_id << std::endl;
    return session_id;
  }

  bool AttachAutomationBrowserView(NativeAutomationSession& session,
                                   std::string* error) {
    if (session.view) return true;
    if (!session.context_ready || !session.context || !session.client) {
      if (error) *error = "The isolated automation profile is unavailable.";
      return false;
    }
    if (!kestrel_window || kestrel_window->IsClosed()) {
      if (error) *error = "The native Kestrel window is unavailable.";
      return false;
    }
    CefBrowserSettings browser_settings;
    session.view = CefBrowserView::CreateBrowserView(
        session.client, "about:blank", browser_settings, nullptr,
        session.context, new KestrelAlloyBrowserViewDelegate());
    if (!session.view) {
      if (error) *error = "Kestrel could not create the isolated browser view.";
      return false;
    }
    // Keep the isolated view hidden, but give the compositor a real viewport so
    // Page.captureScreenshot and layout-based automation stay usable.
    session.view->SetBounds(CefRect(0, 0, 1280, 720));
    session.view->SetVisible(false);
    kestrel_window->AddChildView(session.view);
    return true;
  }

  bool NavigateAutomationSession(const std::string& session_id,
                                 const std::string& url,
                                 const std::string& request_id,
                                 std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    const auto safe = safe_user_browser_url(url);
    if (!safe) {
      if (error)
        *error = "Native Chromium browser navigation is outside the origin allowlist.";
      return false;
    }
    if (found->second.allowed_origins.count(http_origin_from_url(*safe)) == 0) {
      if (error)
        *error = "Native Chromium browser navigation is outside the origin allowlist.";
      return false;
    }
    if (!found->second.pending_navigate_request_id.empty()) {
      if (error) *error = "Native Chromium browser session is already navigating.";
      return false;
    }
    found->second.pending_navigate_request_id = request_id;
    found->second.pending_navigate_target_url = *safe;
    found->second.element_refs.clear();
    found->second.loading = true;
    found->second.url = *safe;
    CefRefPtr<CefBrowser> browser =
        found->second.view ? found->second.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid() || !found->second.browser_ready) {
      found->second.pending_navigate_url = *safe;
      return true;
    }
    browser->GetMainFrame()->LoadURL(*safe);
    return true;
  }

  void EnsureAutomationDevTools(NativeAutomationSession& session,
                                CefRefPtr<CefBrowser> browser) {
    if (!browser || !browser->IsValid() || session.devtools_registration) return;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    const std::string session_id = session.id;
    CefRefPtr<KestrelAutomationDevToolsObserver> observer =
        new KestrelAutomationDevToolsObserver(
            [this, owner_token, session_id](int message_id, bool success,
                                           std::string result_json) {
              const std::shared_ptr<bool> alive = owner_token.lock();
              if (!alive || !*alive) return;
              OnAutomationDevToolsResult(session_id, message_id, success,
                                         std::move(result_json));
            },
            [this, owner_token, session_id]() {
              const std::shared_ptr<bool> alive = owner_token.lock();
              if (!alive || !*alive) return;
              auto found = automation_sessions_.find(session_id);
              if (found != automation_sessions_.end()) {
                found->second.devtools_attached = true;
              }
            });
    session.devtools_registration =
        browser->GetHost()->AddDevToolsMessageObserver(observer);
  }

  bool CallAutomationDevToolsMethod(NativeAutomationSession& session,
                                    const std::string& method,
                                    CefRefPtr<CefDictionaryValue> params,
                                    const std::string& kind,
                                    std::string* error) {
    CefRefPtr<CefBrowser> browser =
        session.view ? session.view->GetBrowser() : nullptr;
    if (!browser || !browser->IsValid()) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    EnsureAutomationDevTools(session, browser);
    const int message_id = browser->GetHost()->ExecuteDevToolsMethod(
        0, method, params ? params : CefDictionaryValue::Create());
    if (message_id <= 0) {
      if (error)
        *error = "Kestrel could not call DevTools in the isolated browser.";
      return false;
    }
    session.pending_devtools_kinds[message_id] = kind;
    return true;
  }

  bool EvaluateAutomationScript(NativeAutomationSession& session,
                                const std::string& expression,
                                const std::string& kind,
                                std::string* error) {
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("expression", expression);
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", false);
    return CallAutomationDevToolsMethod(session, "Runtime.evaluate", params,
                                        kind, error);
  }

  bool CaptureAutomationScreenshot(NativeAutomationSession& session,
                                   std::string* error) {
    // Hidden Alloy views often never produce a compositor surface. Briefly show
    // the session (still behind the shell) so Page.captureScreenshot can paint.
    if (session.view) {
      session.view->SetBounds(CefRect(0, 0, session.viewport_width,
                                      session.viewport_height));
      session.view->SetVisible(true);
    }
    CefRefPtr<CefDictionaryValue> enable_params = CefDictionaryValue::Create();
    if (!CallAutomationDevToolsMethod(session, "Page.enable", enable_params,
                                      "screenshot-enable", error)) {
      if (session.view) session.view->SetVisible(false);
      return false;
    }
    return true;
  }

  bool CaptureAutomationScreenshotFrame(NativeAutomationSession& session,
                                        std::string* error) {
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetString("format", "png");
    params->SetBool("fromSurface", true);
    params->SetBool("captureBeyondViewport", false);
    if (!CallAutomationDevToolsMethod(session, "Page.captureScreenshot", params,
                                      "screenshot", error)) {
      if (session.view) session.view->SetVisible(false);
      return false;
    }
    return true;
  }

  bool AutomationSessionBusy(const NativeAutomationSession& session) const {
    return !session.pending_snapshot_request_id.empty() ||
           !session.pending_act_request_id.empty() ||
           !session.pending_screenshot_request_id.empty() ||
           !session.pending_viewport_request_id.empty() ||
           !session.pending_upload_request_id.empty();
  }

  void FailAutomationUpload(NativeAutomationSession& session,
                            const std::string& error) {
    const std::string request_id = session.pending_upload_request_id;
    session.pending_upload_request_id.clear();
    session.pending_upload_selector.clear();
    session.pending_upload_paths.clear();
    if (!request_id.empty()) {
      SendBrowserBackendResponse(request_id, false, "", error);
    }
  }

  bool ContinueAutomationUploadQuery(NativeAutomationSession& session,
                                     int root_node_id, std::string* error) {
    if (root_node_id <= 0) {
      if (error) *error = "Browser upload document root was invalid.";
      return false;
    }
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetInt("nodeId", root_node_id);
    params->SetString("selector", session.pending_upload_selector);
    return CallAutomationDevToolsMethod(session, "DOM.querySelector", params,
                                        "upload-query", error);
  }

  bool ContinueAutomationUploadSet(NativeAutomationSession& session,
                                   int node_id, std::string* error) {
    if (node_id <= 0) {
      if (error) *error = "Browser upload target was not found.";
      return false;
    }
    CefRefPtr<CefListValue> files = CefListValue::Create();
    for (size_t index = 0; index < session.pending_upload_paths.size();
         ++index) {
      files->SetString(index, session.pending_upload_paths[index]);
    }
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetInt("nodeId", node_id);
    params->SetList("files", files);
    return CallAutomationDevToolsMethod(session, "DOM.setFileInputFiles",
                                        params, "upload-set", error);
  }

  void OnAutomationDevToolsResult(const std::string& session_id,
                                  int message_id,
                                  bool success,
                                  std::string result_json) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end()) return;
    const auto kind_it = found->second.pending_devtools_kinds.find(message_id);
    if (kind_it == found->second.pending_devtools_kinds.end()) return;
    const std::string kind = kind_it->second;
    found->second.pending_devtools_kinds.erase(kind_it);

    if (kind == "viewport") {
      const std::string request_id = found->second.pending_viewport_request_id;
      found->second.pending_viewport_request_id.clear();
      if (request_id.empty()) return;
      if (!success) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser viewport update failed.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_VIEWPORT_OK id="
                << session_id << " width=" << found->second.viewport_width
                << " height=" << found->second.viewport_height << std::endl;
      SendBrowserBackendResponse(request_id, true, "null", "");
      return;
    }

    if (kind == "upload-document") {
      if (found->second.pending_upload_request_id.empty()) return;
      if (!success) {
        FailAutomationUpload(found->second,
                             "Native Chromium browser upload could not read the "
                             "document.");
        return;
      }
      int root_node_id = 0;
      CefRefPtr<CefValue> parsed = CefParseJSON(result_json, JSON_PARSER_RFC);
      if (parsed && parsed->GetType() == VTYPE_DICTIONARY) {
        CefRefPtr<CefDictionaryValue> root = parsed->GetDictionary();
        if (root->GetType("root") == VTYPE_DICTIONARY) {
          CefRefPtr<CefDictionaryValue> document = root->GetDictionary("root");
          if (document->GetType("nodeId") == VTYPE_INT) {
            root_node_id = document->GetInt("nodeId");
          } else if (document->GetType("nodeId") == VTYPE_DOUBLE) {
            root_node_id = static_cast<int>(document->GetDouble("nodeId"));
          }
        }
      }
      std::string error;
      if (!ContinueAutomationUploadQuery(found->second, root_node_id, &error)) {
        FailAutomationUpload(
            found->second,
            error.empty() ? "Browser upload target was not found." : error);
      }
      return;
    }

    if (kind == "upload-query") {
      if (found->second.pending_upload_request_id.empty()) return;
      if (!success) {
        FailAutomationUpload(found->second,
                             "Browser upload target was not found.");
        return;
      }
      int node_id = 0;
      CefRefPtr<CefValue> parsed = CefParseJSON(result_json, JSON_PARSER_RFC);
      if (parsed && parsed->GetType() == VTYPE_DICTIONARY) {
        CefRefPtr<CefDictionaryValue> root = parsed->GetDictionary();
        if (root->GetType("nodeId") == VTYPE_INT) {
          node_id = root->GetInt("nodeId");
        } else if (root->GetType("nodeId") == VTYPE_DOUBLE) {
          node_id = static_cast<int>(root->GetDouble("nodeId"));
        }
      }
      std::string error;
      if (!ContinueAutomationUploadSet(found->second, node_id, &error)) {
        FailAutomationUpload(
            found->second,
            error.empty() ? "Browser upload target was not found." : error);
      }
      return;
    }

    if (kind == "upload-set") {
      const std::string request_id = found->second.pending_upload_request_id;
      found->second.pending_upload_request_id.clear();
      found->second.pending_upload_selector.clear();
      found->second.pending_upload_paths.clear();
      if (request_id.empty()) return;
      if (!success) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser upload failed.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_UPLOAD_OK id="
                << session_id << std::endl;
      SendBrowserBackendResponse(request_id, true, "null", "");
      return;
    }

    if (kind == "screenshot-enable") {
      const std::string request_id = found->second.pending_screenshot_request_id;
      if (request_id.empty()) return;
      if (!success) {
        if (found->second.view) found->second.view->SetVisible(false);
        found->second.pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser screenshot could not enable Page domain.");
        return;
      }
      std::string error;
      if (!CaptureAutomationScreenshotFrame(found->second, &error)) {
        if (found->second.view) found->second.view->SetVisible(false);
        found->second.pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium browser screenshot failed."
                          : error);
      }
      return;
    }

    if (kind == "screenshot") {
      const std::string request_id = found->second.pending_screenshot_request_id;
      found->second.pending_screenshot_request_id.clear();
      if (found->second.view) found->second.view->SetVisible(false);
      if (request_id.empty()) return;
      if (!success) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser screenshot failed.");
        return;
      }
      CefRefPtr<CefValue> parsed = CefParseJSON(result_json, JSON_PARSER_RFC);
      if (!parsed || parsed->GetType() != VTYPE_DICTIONARY ||
          parsed->GetDictionary()->GetType("data") != VTYPE_STRING) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser screenshot was invalid.");
        return;
      }
      const std::string png_b64 =
          parsed->GetDictionary()->GetString("data").ToString();
      std::vector<uint8_t> png = base64_decode_bytes(png_b64);
      int width = 0;
      int height = 0;
      std::vector<uint8_t> rgba;
      if (png.size() < 8 || png[0] != 0x89 || png[1] != 'P' || png[2] != 'N' ||
          png[3] != 'G' || !decode_png_to_rgba(png, &width, &height, &rgba) ||
          width <= 0 || height <= 0 ||
          static_cast<size_t>(width) * static_cast<size_t>(height) * 4 !=
              rgba.size() ||
          png.size() > 10'000'000) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser screenshot frame was invalid.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_SCREENSHOT_OK id="
                << session_id << " width=" << width << " height=" << height
                << std::endl;
      SendBrowserBackendResponse(
          request_id, true,
          encode_screenshot_frame_json(width, height, rgba, png), "");
      return;
    }

    std::string value_json;
    bool evaluate_ok = success;
    if (success) {
      CefRefPtr<CefValue> parsed =
          CefParseJSON(result_json, JSON_PARSER_RFC);
      if (parsed && parsed->GetType() == VTYPE_DICTIONARY) {
        CefRefPtr<CefDictionaryValue> root = parsed->GetDictionary();
        if (root->HasKey("exceptionDetails")) {
          evaluate_ok = false;
        } else {
          CefRefPtr<CefValue> result_value = root->GetValue("result");
          if (result_value && result_value->GetType() == VTYPE_DICTIONARY) {
            CefRefPtr<CefDictionaryValue> result = result_value->GetDictionary();
            if (result->GetType("value") == VTYPE_STRING) {
              value_json = result->GetString("value").ToString();
            } else if (result->HasKey("value")) {
              value_json =
                  CefWriteJSON(result->GetValue("value"), JSON_WRITER_DEFAULT)
                      .ToString();
            }
          }
        }
      } else {
        evaluate_ok = false;
      }
    }
    success = evaluate_ok;

    if (kind == "screenshot-guard") {
      const std::string request_id = found->second.pending_screenshot_request_id;
      if (request_id.empty()) return;
      if (!success || value_json.empty()) {
        found->second.pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser screenshot guard failed.");
        return;
      }
      CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
      if (payload && payload->GetType() == VTYPE_DICTIONARY &&
          payload->GetDictionary()->GetBool("sensitive")) {
        found->second.pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            "Kestrel does not share browser screenshots from pages with "
            "sensitive input fields.");
        return;
      }
      std::string error;
      if (!CaptureAutomationScreenshot(found->second, &error)) {
        found->second.pending_screenshot_request_id.clear();
        SendBrowserBackendResponse(
            request_id, false, "",
            error.empty() ? "Native Chromium browser screenshot failed."
                          : error);
      }
      return;
    }

    if (kind == "snapshot") {
      const std::string request_id = found->second.pending_snapshot_request_id;
      found->second.pending_snapshot_request_id.clear();
      if (request_id.empty()) return;
      if (!success || value_json.empty()) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser snapshot failed.");
        return;
      }
      CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
      if (!payload || payload->GetType() != VTYPE_DICTIONARY) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser snapshot was invalid.");
        return;
      }
      CefRefPtr<CefDictionaryValue> body = payload->GetDictionary();
      found->second.element_refs.clear();
      if (body->GetType("interactive") == VTYPE_LIST) {
        CefRefPtr<CefListValue> interactive = body->GetList("interactive");
        for (size_t index = 0; index < interactive->GetSize(); ++index) {
          if (interactive->GetType(index) != VTYPE_DICTIONARY) continue;
          CefRefPtr<CefDictionaryValue> item = interactive->GetDictionary(index);
          if (item->GetType("ref") != VTYPE_STRING) continue;
          NativeAutomationElementRef entry;
          entry.role = item->GetType("role") == VTYPE_STRING
                           ? item->GetString("role").ToString()
                           : "";
          entry.tag = item->GetType("tag") == VTYPE_STRING
                          ? item->GetString("tag").ToString()
                          : "";
          entry.input_type = item->GetType("inputType") == VTYPE_STRING
                                 ? item->GetString("inputType").ToString()
                                 : "";
          found->second.element_refs[item->GetString("ref").ToString()] = entry;
          // Wire-facing interactive entries omit host-only tag metadata.
          item->Remove("tag");
          item->Remove("inputType");
        }
      }
      CefRefPtr<CefDictionaryValue> response = CefDictionaryValue::Create();
      response->SetString("url", found->second.url);
      response->SetString("title", found->second.title);
      if (body->HasKey("accessibilityTree")) {
        response->SetValue("accessibilityTree",
                           body->GetValue("accessibilityTree"));
      }
      if (body->HasKey("interactive")) {
        response->SetValue("interactive", body->GetValue("interactive"));
      }
      response->SetBool("truncated", body->GetBool("truncated"));
      CefRefPtr<CefValue> root = CefValue::Create();
      root->SetDictionary(response);
      SendBrowserBackendResponse(
          request_id, true,
          CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString(), "");
      return;
    }

    if (kind == "act") {
      const std::string request_id = found->second.pending_act_request_id;
      found->second.pending_act_request_id.clear();
      if (request_id.empty()) return;
      if (!success) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser action failed.");
        return;
      }
      bool ok = false;
      if (!value_json.empty()) {
        CefRefPtr<CefValue> payload = CefParseJSON(value_json, JSON_PARSER_RFC);
        if (payload && payload->GetType() == VTYPE_DICTIONARY) {
          ok = payload->GetDictionary()->GetBool("ok");
        }
      }
      if (!ok) {
        SendBrowserBackendResponse(
            request_id, false, "",
            "Native Chromium browser action was refused or the target changed.");
        return;
      }
      std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_ACT_OK id=" << session_id
                << std::endl;
      SendBrowserBackendResponse(request_id, true, "null", "");
    }
  }

  bool BeginAutomationSnapshot(const std::string& session_id,
                               const std::string& request_id,
                               std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    if (AutomationSessionBusy(found->second)) {
      if (error) *error = "Native Chromium browser session is busy.";
      return false;
    }
    found->second.pending_snapshot_request_id = request_id;
    if (!EvaluateAutomationScript(found->second, kAutomationSnapshotScript,
                                  "snapshot", error)) {
      found->second.pending_snapshot_request_id.clear();
      return false;
    }
    return true;
  }

  bool BeginAutomationScreenshot(const std::string& session_id,
                                 const std::string& request_id,
                                 std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    if (AutomationSessionBusy(found->second)) {
      if (error) *error = "Native Chromium browser session is busy.";
      return false;
    }
    found->second.pending_screenshot_request_id = request_id;
    if (!EvaluateAutomationScript(found->second,
                                  kAutomationScreenshotGuardScript,
                                  "screenshot-guard", error)) {
      found->second.pending_screenshot_request_id.clear();
      return false;
    }
    return true;
  }

  bool BeginAutomationViewport(const std::string& session_id,
                               CefRefPtr<CefDictionaryValue> viewport,
                               const std::string& request_id,
                               std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    if (!viewport || viewport->GetType("name") != VTYPE_STRING) {
      if (error) *error = "Native isolated viewport was invalid.";
      return false;
    }
    const auto read_dimension = [&](const char* key, int* out) -> bool {
      if (viewport->GetType(key) == VTYPE_INT) {
        *out = viewport->GetInt(key);
        return true;
      }
      if (viewport->GetType(key) == VTYPE_DOUBLE) {
        *out = static_cast<int>(viewport->GetDouble(key));
        return true;
      }
      return false;
    };
    int width = 0;
    int height = 0;
    if (!read_dimension("width", &width) || !read_dimension("height", &height)) {
      if (error) *error = "Native isolated viewport was invalid.";
      return false;
    }
    if (width < 240 || width > 3840 || height < 240 || height > 2160) {
      if (error) *error = "Native isolated viewport size is out of range.";
      return false;
    }
    double device_scale = 1.0;
    if (viewport->HasKey("deviceScaleFactor")) {
      if (viewport->GetType("deviceScaleFactor") != VTYPE_DOUBLE &&
          viewport->GetType("deviceScaleFactor") != VTYPE_INT) {
        if (error) *error = "Native isolated viewport was invalid.";
        return false;
      }
      device_scale = viewport->GetType("deviceScaleFactor") == VTYPE_DOUBLE
                         ? viewport->GetDouble("deviceScaleFactor")
                         : static_cast<double>(viewport->GetInt("deviceScaleFactor"));
      if (device_scale < 0.5 || device_scale > 4.0) {
        if (error) *error = "Native isolated viewport scale is out of range.";
        return false;
      }
    }
    if (AutomationSessionBusy(found->second)) {
      if (error) *error = "Native Chromium browser session is busy.";
      return false;
    }
    found->second.viewport_width = width;
    found->second.viewport_height = height;
    found->second.viewport_device_scale_factor = device_scale;
    if (found->second.view) {
      found->second.view->SetBounds(CefRect(0, 0, width, height));
    }
    found->second.pending_viewport_request_id = request_id;
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetInt("width", width);
    params->SetInt("height", height);
    params->SetDouble("deviceScaleFactor", device_scale);
    params->SetBool("mobile", width < 768);
    if (!CallAutomationDevToolsMethod(found->second,
                                      "Emulation.setDeviceMetricsOverride",
                                      params, "viewport", error)) {
      found->second.pending_viewport_request_id.clear();
      return false;
    }
    return true;
  }

  bool BeginAutomationUpload(const std::string& session_id,
                             const std::string& selector,
                             CefRefPtr<CefListValue> paths,
                             const std::string& request_id,
                             std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    if (selector.empty() || selector.size() > 2000 ||
        selector.find('\0') != std::string::npos) {
      if (error) *error = "Native isolated upload selector was invalid.";
      return false;
    }
    if (!paths || paths->GetSize() == 0 || paths->GetSize() > 20) {
      if (error) *error = "Native isolated upload paths were invalid.";
      return false;
    }
    std::vector<std::string> resolved_paths;
    resolved_paths.reserve(paths->GetSize());
    for (size_t index = 0; index < paths->GetSize(); ++index) {
      if (paths->GetType(index) != VTYPE_STRING) {
        if (error) *error = "Native isolated upload paths were invalid.";
        return false;
      }
      const std::string path = paths->GetString(index).ToString();
      if (path.empty() || path.size() > 4096 || path.front() != '/' ||
          path.find('\0') != std::string::npos) {
        if (error) *error = "Native isolated upload paths were invalid.";
        return false;
      }
      BOOL is_directory = NO;
      if (![[NSFileManager defaultManager] fileExistsAtPath:@(path.c_str())
                                               isDirectory:&is_directory] ||
          is_directory) {
        if (error) *error = "Native isolated upload file was not found.";
        return false;
      }
      resolved_paths.push_back(path);
    }
    if (AutomationSessionBusy(found->second)) {
      if (error) *error = "Native Chromium browser session is busy.";
      return false;
    }
    found->second.pending_upload_request_id = request_id;
    found->second.pending_upload_selector = selector;
    found->second.pending_upload_paths = std::move(resolved_paths);
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    params->SetInt("depth", 0);
    if (!CallAutomationDevToolsMethod(found->second, "DOM.getDocument", params,
                                      "upload-document", error)) {
      found->second.pending_upload_request_id.clear();
      found->second.pending_upload_selector.clear();
      found->second.pending_upload_paths.clear();
      return false;
    }
    return true;
  }

  bool BeginAutomationAct(const std::string& session_id,
                          CefRefPtr<CefDictionaryValue> action,
                          const std::string& request_id,
                          std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end() || found->second.closing) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    if (!action || action->GetType("type") != VTYPE_STRING) {
      if (error) *error = "Native isolated act was invalid.";
      return false;
    }
    if (AutomationSessionBusy(found->second)) {
      if (error) *error = "Native Chromium browser session is busy.";
      return false;
    }
    const std::string type = action->GetString("type").ToString();
    std::string expression;
    if (type == "click" || type == "type" || type == "select") {
      if (action->GetType("target") != VTYPE_STRING) {
        if (error) *error = "Native isolated act target was invalid.";
        return false;
      }
      const std::string target = action->GetString("target").ToString();
      if (target.size() > 2000 || target.find('"') != std::string::npos ||
          target.find('\\') != std::string::npos) {
        if (error) *error = "Native isolated act target was invalid.";
        return false;
      }
      const auto ref = found->second.element_refs.find(target);
      if (ref == found->second.element_refs.end()) {
        if (error)
          *error = "Browser target ref is stale. Take a new snapshot.";
        return false;
      }
      if (type == "click") {
        if (ref->second.tag != "BUTTON" && ref->second.tag != "A") {
          if (error) *error = "Only inspected buttons and links can be clicked.";
          return false;
        }
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!el || !el.isConnected) throw new Error('stale'); "
            "if (el.tagName !== 'BUTTON' && el.tagName !== 'A') throw new "
            "Error('role'); el.click(); return JSON.stringify({ok:true}); })()";
      } else if (type == "type") {
        if (action->GetType("text") != VTYPE_STRING) {
          if (error) *error = "Native isolated type text was invalid.";
          return false;
        }
        if (ref->second.input_type == "password" ||
            ref->second.role != "textbox") {
          if (error)
            *error = "This target does not support typing.";
          return false;
        }
        const std::string text = action->GetString("text").ToString();
        if (text.size() > 20000) {
          if (error) *error = "Native isolated type text was too long.";
          return false;
        }
        const std::string text_json = json_string_literal(text);
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!el || !el.isConnected) throw new Error('stale'); "
            "if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') throw new "
            "Error('role'); if ((el.getAttribute('type')||'').toLowerCase()==="
            "'password') throw new Error('sensitive'); "
            "const proto = el.tagName === 'TEXTAREA' ? "
            "HTMLTextAreaElement.prototype : HTMLInputElement.prototype; "
            "const setter = Object.getOwnPropertyDescriptor(proto,'value').set; "
            "setter.call(el, " +
            text_json +
            "); el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); "
            "return JSON.stringify({ok: el.value === " +
            text_json + "}); })()";
      } else {
        if (action->GetType("value") != VTYPE_STRING ||
            ref->second.tag != "SELECT") {
          if (error) *error = "Native isolated select was invalid.";
          return false;
        }
        const std::string value = action->GetString("value").ToString();
        if (value.size() > 2000) {
          if (error) *error = "Native isolated select value was too long.";
          return false;
        }
        const std::string value_json = json_string_literal(value);
        expression =
            std::string("(() => { const el = document.querySelector('[data-"
                        "kestrel-ref=\"") +
            target +
            "\"]'); if (!(el instanceof HTMLSelectElement)) throw new "
            "Error('stale'); el.value = " +
            value_json +
            "; el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); "
            "return JSON.stringify({ok: el.value === " +
            value_json + "}); })()";
      }
    } else if (type == "key") {
      if (action->GetType("key") != VTYPE_STRING) {
        if (error) *error = "Native isolated key was invalid.";
        return false;
      }
      const std::string key = action->GetString("key").ToString();
      if (key.size() > 20 || key.find('"') != std::string::npos) {
        if (error) *error = "Native isolated key was invalid.";
        return false;
      }
      expression =
          std::string("(() => { const key = \"") + key +
          "\"; const el = document.activeElement || document.body; "
          "el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); "
          "el.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})); "
          "return JSON.stringify({ok:true}); })()";
    } else if (type == "scroll") {
      const int x = action->GetType("x") == VTYPE_INT ? action->GetInt("x")
                    : action->GetType("x") == VTYPE_DOUBLE
                        ? static_cast<int>(action->GetDouble("x"))
                        : 0;
      const int y = action->GetType("y") == VTYPE_INT ? action->GetInt("y")
                    : action->GetType("y") == VTYPE_DOUBLE
                        ? static_cast<int>(action->GetDouble("y"))
                        : 0;
      expression = "(() => { window.scrollBy(" + std::to_string(x) + ", " +
                   std::to_string(y) +
                   "); return JSON.stringify({ok:true}); })()";
    } else {
      if (error) *error = "Native isolated act type is unsupported.";
      return false;
    }

    found->second.pending_act_request_id = request_id;
    if (!EvaluateAutomationScript(found->second, expression, "act", error)) {
      found->second.pending_act_request_id.clear();
      return false;
    }
    return true;
  }

  bool CloseAutomationSession(const std::string& session_id, std::string* error) {
    auto found = automation_sessions_.find(session_id);
    if (found == automation_sessions_.end()) {
      if (error) *error = "Native Chromium browser session is unavailable.";
      return false;
    }
    std::cout << "KESTREL_NATIVE_CHROMIUM_AUTOMATION_CLOSE id=" << session_id
              << std::endl;
    found->second.closing = true;
    if (found->second.view) {
      found->second.view->SetVisible(false);
      // Detach before CloseBrowser so Alloy does not treat the child teardown
      // as a top-level window close (same ordering as CloseUserBrowserView).
      if (kestrel_window && !kestrel_window->IsClosed()) {
        kestrel_window->RemoveChildView(found->second.view);
      }
    }
    CefRefPtr<CefBrowser> browser =
        found->second.view ? found->second.view->GetBrowser() : nullptr;
    if (browser && browser->IsValid()) {
      browser->GetHost()->CloseBrowser(true);
    } else {
      found->second.view = nullptr;
      found->second.client = nullptr;
      found->second.context = nullptr;
      automation_sessions_.erase(found);
    }
    return true;
  }

  void StartEphemeralCore(NSString* isolated_profile_root) {
    if (!isolated_profile_root) return;
    KestrelClient* const relay_client = this;
    const std::weak_ptr<bool> owner_token = native_owner_alive_;
    NSMutableDictionary<NSString*, NSString*>* environment =
        [NSMutableDictionary dictionary];
    if (smoke_browser_backend) {
      environment[@"KESTREL_SMOKE_BROWSER_BACKEND"] = @"1";
      if (smoke_browser_backend_url) {
        environment[@"KESTREL_SMOKE_BROWSER_BACKEND_URL"] =
            [NSString stringWithUTF8String:smoke_browser_backend_url->c_str()];
      }
    }
    if (smoke_isolated_automation) {
      environment[@"KESTREL_SMOKE_ISOLATED_AUTOMATION"] = @"1";
      if (smoke_isolated_automation_url) {
        environment[@"KESTREL_SMOKE_ISOLATED_AUTOMATION_URL"] = [NSString
            stringWithUTF8String:smoke_isolated_automation_url->c_str()];
      }
      if (smoke_isolated_upload_path) {
        environment[@"KESTREL_SMOKE_UPLOAD_PATH"] = [NSString
            stringWithUTF8String:smoke_isolated_upload_path->c_str()];
      }
    }
    core_relay_ = [[KestrelNativeCoreRelay alloc]
        initWithProfileRoot:isolated_profile_root
                environment:environment
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
  bool user_extensions_enabled_ = false;
  std::string isolated_profile_root_;
  std::string user_browser_cache_path_;
  DurableBrowserLibrary browser_library_;
  NativeCredentialStore credential_store_;
  bool credential_store_opened_ = false;
  std::map<std::string, NativeAutomationSession> automation_sessions_;
  std::map<uint32_t, std::string> cef_download_ids_;
  std::map<std::string, std::string> download_paths_;
  std::map<std::string, CefRefPtr<CefDownloadItemCallback>>
      download_cancel_callbacks_;
  std::shared_ptr<bool> native_owner_alive_ = std::make_shared<bool>(true);
  std::deque<NativeUserBrowserTab> user_browser_tabs_;
  std::set<std::string> pending_user_browser_closures_;
  std::string user_browser_active_tab_id_;
  CefRect user_browser_bounds_;
  bool user_browser_view_visible_ = false;
  bool user_browser_context_initializing_ = false;
  bool user_browser_context_ready_ = false;
  bool smoke_download_started_ = false;
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
  explicit CloseWhenReadyTask(int remaining_grace_ms = 60'000)
      : remaining_grace_ms_(remaining_grace_ms) {}

  void Execute() override {
    if (!client_instance || client_instance->IsClosing()) return;
    // Isolated automation smoke can still be mid create→navigate→snapshot→close
    // when the ready timer fires. Keep waiting until the relay reports done.
    if (smoke_isolated_automation && !smoke_isolated_automation_done) {
      if (remaining_grace_ms_ <= 0) {
        std::cerr << "KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_FAILED error="
                     "Timed out waiting for isolated automation smoke."
                  << std::endl;
        client_instance->CloseBrowser();
        return;
      }
      const int slice = 1'000;
      CefPostDelayedTask(TID_UI,
                         new CloseWhenReadyTask(remaining_grace_ms_ - slice),
                         slice);
      return;
    }
    client_instance->CloseBrowser();
  }

 private:
  int remaining_grace_ms_ = 60'000;
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
    user_extensions_enabled =
        has_argument(argc, argv, "--kestrel-user-extensions");
    durable_profile_enabled =
        has_argument(argc, argv, "--kestrel-durable-profile");
    real_keychain_enabled =
        has_argument(argc, argv, "--kestrel-real-keychain") ||
        (std::getenv("KESTREL_USE_REAL_KEYCHAIN") != nullptr &&
         std::string(std::getenv("KESTREL_USE_REAL_KEYCHAIN")) == "1");
    if (std::getenv("KESTREL_USE_MOCK_KEYCHAIN") != nullptr &&
        std::string(std::getenv("KESTREL_USE_MOCK_KEYCHAIN")) == "1") {
      real_keychain_enabled = false;
    }
    smoke_credentials =
        has_argument(argc, argv, "--kestrel-smoke-credentials");
    if (smoke_credentials && real_keychain_enabled) {
      std::cerr << "Credential smoke requires profile-sealed storage "
                   "(omit --kestrel-real-keychain)."
                << std::endl;
      return 1;
    }
    smoke_durable_library_seed =
        has_argument(argc, argv, "--kestrel-smoke-durable-library");
    smoke_durable_library_verify =
        has_argument(argc, argv, "--kestrel-smoke-durable-library-verify");
    if ((smoke_durable_library_seed || smoke_durable_library_verify) &&
        !durable_profile_enabled) {
      std::cerr << "Durable library smoke requires --kestrel-durable-profile."
                << std::endl;
      return 1;
    }
    if (smoke_durable_library_seed && smoke_durable_library_verify) {
      std::cerr << "Durable library smoke seed and verify cannot run together."
                << std::endl;
      return 1;
    }
    if (extension_workbench && user_extensions_enabled) {
      std::cerr << "Extension workbench and user-browser extensions cannot run "
                   "together."
                << std::endl;
      return 1;
    }
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
    if (const auto download_url =
            argument_value(argc, argv, "--kestrel-smoke-download-url")) {
      const std::optional<std::string> normalized =
          safe_user_browser_url(*download_url);
      if (!normalized) {
        std::cerr << "Kestrel received an invalid native download smoke URL."
                  << std::endl;
        return 1;
      }
      if (!durable_profile_enabled) {
        std::cerr << "Download smoke requires --kestrel-durable-profile."
                  << std::endl;
        return 1;
      }
      smoke_download_url = *normalized;
    }
    smoke_browser_backend =
        has_argument(argc, argv, "--kestrel-smoke-browser-backend");
    if (const auto backend_url =
            argument_value(argc, argv, "--kestrel-smoke-browser-backend-url")) {
      const std::optional<std::string> normalized =
          safe_user_browser_url(*backend_url);
      if (!normalized) {
        std::cerr
            << "Kestrel received an invalid native browser-backend smoke URL."
            << std::endl;
        return 1;
      }
      smoke_browser_backend_url = *normalized;
      smoke_browser_backend = true;
    }
    smoke_isolated_automation =
        has_argument(argc, argv, "--kestrel-smoke-isolated-automation");
    if (const auto isolated_url = argument_value(
            argc, argv, "--kestrel-smoke-isolated-automation-url")) {
      const std::optional<std::string> normalized =
          safe_user_browser_url(*isolated_url);
      if (!normalized) {
        std::cerr << "Kestrel received an invalid isolated automation smoke URL."
                  << std::endl;
        return 1;
      }
      smoke_isolated_automation_url = *normalized;
      smoke_isolated_automation = true;
    }
    if (const auto upload_path =
            argument_value(argc, argv, "--kestrel-smoke-upload-path")) {
      NSString* path = [NSString stringWithUTF8String:upload_path->c_str()];
      BOOL is_directory = NO;
      if (!path || ![path isAbsolutePath] ||
          ![[NSFileManager defaultManager] fileExistsAtPath:path
                                               isDirectory:&is_directory] ||
          is_directory) {
        std::cerr
            << "Kestrel received an invalid isolated automation upload path."
            << std::endl;
        return 1;
      }
      smoke_isolated_upload_path = *upload_path;
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
    if ((smoke_browser_backend || smoke_isolated_automation) &&
        !ephemeral_core_enabled) {
      std::cerr << "Browser backend smoke requires --kestrel-ephemeral-core."
                << std::endl;
      return 1;
    }
    if (smoke_isolated_automation && !smoke_isolated_automation_url) {
      std::cerr << "Isolated automation smoke requires "
                   "--kestrel-smoke-isolated-automation-url."
                << std::endl;
      return 1;
    }

    CefRefPtr<KestrelChromiumApp> app(new KestrelChromiumApp(
        [extension_workbench] {
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
          ephemeral_core_enabled,
          user_extensions_enabled));
      main_client_owner = client;
      const auto open_shell =
          [client, browser_settings](
              CefRefPtr<CefRequestContext> shell_context) {
            CefRefPtr<CefBrowserView> browser_view =
                CefBrowserView::CreateBrowserView(
                    client, shell_url, browser_settings, nullptr, shell_context,
                    new KestrelAlloyBrowserViewDelegate());
            if (!browser_view) {
              std::cerr << "Kestrel could not create its privileged shell view."
                        << std::endl;
              CefQuitMessageLoop();
              return;
            }
            CefWindow::CreateTopLevelWindow(
                new KestrelWindowDelegate(browser_view));
          };
      if (!user_extensions_enabled) {
        open_shell(nullptr);
        return;
      }
      // Privileged shell storage stays extension-free. User tabs and
      // --load-extension share the default profile instead. CEF returns the
      // context object before it can host a BrowserView, so wait for init.
      CefRequestContextSettings shell_settings;
      const std::string shell_cache =
          isolated_profile_path + "/shell-privileged";
      CefString(&shell_settings.cache_path) = shell_cache;
      shell_settings.persist_session_cookies = false;
      CefRefPtr<KestrelUserBrowserContextHandler> shell_handler =
          new KestrelUserBrowserContextHandler(open_shell);
      CefRefPtr<CefRequestContext> shell_context =
          CefRequestContext::CreateContext(shell_settings, shell_handler);
      if (!shell_context) {
        std::cerr << "Kestrel could not create its privileged shell profile."
                  << std::endl;
        CefQuitMessageLoop();
      }
        },
        extension_workbench, user_extensions_enabled));
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
