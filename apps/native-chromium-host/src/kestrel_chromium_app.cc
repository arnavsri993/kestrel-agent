#include "kestrel_chromium_app.h"

#include <fstream>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

#include "include/cef_command_line.h"
#include "include/cef_scheme.h"
#include "include/cef_v8.h"

namespace {

bool readable_manifest(const std::string& extension_path) {
  std::ifstream manifest(extension_path + "/manifest.json");
  return manifest.good();
}

// Controlled store written by ChromiumExtensionRuntime's file port. Keep this
// parser intentionally narrow so the C++ CEF app stays free of Objective-C.
std::vector<std::string> persisted_user_extension_paths(
    const std::string& profile_root) {
  if (profile_root.empty()) return {};
  const std::string store_path =
      profile_root + "/browser-extensions/chromium-load-paths.json";
  std::ifstream input(store_path);
  if (!input) return {};
  std::string contents((std::istreambuf_iterator<char>(input)),
                       std::istreambuf_iterator<char>());
  std::vector<std::string> paths;
  constexpr char key[] = "\"path\"";
  size_t cursor = 0;
  while ((cursor = contents.find(key, cursor)) != std::string::npos) {
    cursor += sizeof(key) - 1;
    const size_t colon = contents.find(':', cursor);
    if (colon == std::string::npos) break;
    const size_t open = contents.find('"', colon + 1);
    if (open == std::string::npos) break;
    const size_t close = contents.find('"', open + 1);
    if (close == std::string::npos) break;
    const std::string path = contents.substr(open + 1, close - open - 1);
    cursor = close + 1;
    if (path.empty() || path.find("..") != std::string::npos) continue;
    if (!readable_manifest(path)) continue;
    paths.push_back(path);
  }
  return paths;
}

}  // namespace

namespace {

// The native bridge is a privileged capability, not a general-purpose web
// preload. Keep it confined to Kestrel's bundled UI document. A user browser
// tab gets a distinct CEF request context and must never receive this object
// (or the message-router query functions it depends on).
bool is_trusted_kestrel_document(CefRefPtr<CefFrame> frame) {
  if (!frame || !frame->IsMain()) return false;
  const std::string url = frame->GetURL().ToString();
  return url == "kestrel://app/index.html" ||
         (url.starts_with("file://") &&
          url.find("/kestrel-shell/index.html") != std::string::npos);
}

constexpr char kKestrelBridgeSource[] = R"JS(
(() => {
  const nativeQuery = globalThis.__kestrelNativeQuery;
  const nativeCancel = globalThis.__kestrelNativeCancel;
  if (typeof nativeQuery !== "function" || typeof nativeCancel !== "function") {
    throw new Error("Kestrel native Chromium bridge was unavailable.");
  }

  const request = (value) =>
    new Promise((resolve, reject) => {
      let settled = false;
      try {
        nativeQuery({
          request: JSON.stringify({ kind: "request", request: value }),
          persistent: false,
          onSuccess: (response) => {
            if (settled) return;
            settled = true;
            try {
              resolve(JSON.parse(response));
            } catch {
              reject(new Error("Kestrel native Chromium bridge returned invalid JSON."));
            }
          },
          onFailure: (_code, message) => {
            if (settled) return;
            settled = true;
            reject(new Error(message || "Kestrel native Chromium bridge failed."));
          },
        });
      } catch {
        reject(new Error("Kestrel native Chromium bridge could not send a request."));
      }
    });

  const subscribe = (channel, callback) => {
    let closed = false;
    let queryId;
    try {
      queryId = nativeQuery({
        request: JSON.stringify({ kind: "subscribe", channel }),
        persistent: true,
        onSuccess: (response) => {
          if (closed) return;
          try {
            callback(JSON.parse(response));
          } catch {
            // An invalid event is ignored at this narrow transport boundary.
          }
        },
        onFailure: () => {
          closed = true;
        },
      });
    } catch {
      closed = true;
    }
    return () => {
      if (closed || queryId === undefined) return;
      closed = true;
      nativeCancel(queryId);
    };
  };

  const bridge = Object.freeze({
    request,
    onBrowserEvent: (callback) => subscribe("browser-event", callback),
    onWindowFocus: (callback) => subscribe("window-focus", callback),
    onPasswordPrompt: (callback) => subscribe("password-prompt", callback),
    onPaymentPrompt: (callback) => subscribe("payment-prompt", callback),
    onBrowserCommand: (callback) => subscribe("browser-command", callback),
    onDeepLink: (callback) => subscribe("deep-link", callback),
    onExternalIntake: (callback) => subscribe("external-intake", callback),
    onSnapshot: (callback) => subscribe("snapshot", callback),
    onPetStatus: (callback) => subscribe("pet-status", callback),
    onPetActivity: (callback) => subscribe("pet-activity", callback),
    onRuntimeEvent: (callback) => subscribe("runtime-event", callback),
    onAgentStream: (callback) => subscribe("agent-stream", callback),
    onLocalRuntimeProgress: (callback) =>
      subscribe("local-runtime-progress", callback),
  });

  Object.defineProperty(globalThis, "kestrel", {
    configurable: false,
    enumerable: false,
    value: bridge,
    writable: false,
  });
  delete globalThis.__kestrelNativeQuery;
  delete globalThis.__kestrelNativeCancel;
})();
)JS";

}  // namespace

CefMessageRouterConfig KestrelBridgeRouterConfig() {
  CefMessageRouterConfig config;
  config.js_query_function = "__kestrelNativeQuery";
  config.js_cancel_function = "__kestrelNativeCancel";
  return config;
}

KestrelChromiumApp::KestrelChromiumApp(
    BrowserContextInitialized on_context_initialized,
    bool extension_workbench,
    bool user_extensions_enabled)
    : on_context_initialized_(std::move(on_context_initialized)),
      extension_workbench_(extension_workbench),
      user_extensions_enabled_(user_extensions_enabled) {}

void KestrelChromiumApp::OnBeforeCommandLineProcessing(
    const CefString& process_type,
    CefRefPtr<CefCommandLine> command_line) {
  // Default to Chromium's mock Keychain so ad-hoc development builds never
  // spam unlock prompts. Opt into the real Chromium Keychain only when the
  // host is launched with --kestrel-real-keychain (Developer ID / durable
  // cutover). Chromium propagates browser-process switches to its helpers;
  // limiting this change to the browser process follows CEF's safety guidance
  // for child process command lines.
  if (process_type.empty()) {
    if (!command_line->HasSwitch("kestrel-real-keychain")) {
      command_line->AppendSwitch("use-mock-keychain");
    }
    // Kestrel starts local-first. The Chromium embed must not create a
    // background account, telemetry, component-updater, or reliability
    // network channel before a person explicitly chooses a provider route.
    command_line->AppendSwitch("disable-background-networking");
    command_line->AppendSwitch("disable-component-update");
    command_line->AppendSwitch("disable-component-extensions-with-background-pages");
    // Extensions stay disabled unless the isolated Chrome-style workbench or
    // the opt-in user-browser extension lane is active. The privileged shell
    // still runs on a separate request context when user extensions are on.
    if (!extension_workbench_ && !user_extensions_enabled_)
      command_line->AppendSwitch("disable-extensions");
    if (user_extensions_enabled_) {
      // BrowserExtensionManager persists verified unpack paths through the
      // ChromiumExtensionRuntime file port. Apply them with Chromium's startup
      // --load-extension switch because CEF 152 has no LoadExtension API.
      const std::string profile_root =
          command_line->GetSwitchValue("kestrel-cache-path").ToString();
      const std::vector<std::string> persisted =
          persisted_user_extension_paths(profile_root);
      if (!persisted.empty()) {
        std::string joined;
        for (const auto& path : persisted) {
          if (!joined.empty()) joined.append(",");
          joined.append(path);
        }
        // Chromium accepts repeated --load-extension switches, so this remains
        // compatible with an explicit CLI fixture path used by smokes.
        command_line->AppendSwitchWithValue("load-extension", joined);
        std::cout << "KESTREL_NATIVE_CHROMIUM_USER_EXTENSION_PATHS count="
                  << persisted.size() << std::endl;
      }
    }
    command_line->AppendSwitch("disable-default-apps");
    command_line->AppendSwitch("disable-domain-reliability");
    command_line->AppendSwitch("disable-sync");
    command_line->AppendSwitch("metrics-recording-only");
    command_line->AppendSwitch("no-default-browser-check");
    command_line->AppendSwitch("no-first-run");
  }
}

void KestrelChromiumApp::OnRegisterCustomSchemes(
    CefRawPtr<CefSchemeRegistrar> registrar) {
  if (extension_workbench_) return;
  registrar->AddCustomScheme(
      "kestrel",
      CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
          CEF_SCHEME_OPTION_DISPLAY_ISOLATED |
          CEF_SCHEME_OPTION_FETCH_ENABLED);
}

CefRefPtr<CefBrowserProcessHandler>
KestrelChromiumApp::GetBrowserProcessHandler() {
  return this;
}

CefRefPtr<CefRenderProcessHandler>
KestrelChromiumApp::GetRenderProcessHandler() {
  return this;
}

void KestrelChromiumApp::OnContextInitialized() {
  if (on_context_initialized_) {
    on_context_initialized_();
  }
}

void KestrelChromiumApp::OnBeforeChildProcessLaunch(
    CefRefPtr<CefCommandLine> command_line) {
  if (extension_workbench_)
    command_line->AppendSwitch("kestrel-extension-workbench");
  if (user_extensions_enabled_)
    command_line->AppendSwitch("kestrel-user-extensions");
}

void KestrelChromiumApp::OnWebKitInitialized() {
  if (extension_workbench_) return;
  renderer_router_ = CefMessageRouterRendererSide::Create(
      KestrelBridgeRouterConfig());
}

void KestrelChromiumApp::OnContextCreated(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefV8Context> context) {
  if (!is_trusted_kestrel_document(frame) || !renderer_router_) {
    return;
  }
  renderer_router_->OnContextCreated(browser, frame, context);
  CefRefPtr<CefV8Value> result;
  CefRefPtr<CefV8Exception> exception;
  if (!context->Eval(
          kKestrelBridgeSource,
          "kestrel-native-chromium-bridge.js",
          1,
          result,
          exception)) {
    std::cerr << "Kestrel could not install its native Chromium renderer bridge."
              << std::endl;
  } else {
    std::cout << "KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY"
              << std::endl;
  }
}

void KestrelChromiumApp::OnContextReleased(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefV8Context> context) {
  if (is_trusted_kestrel_document(frame) && renderer_router_) {
    renderer_router_->OnContextReleased(browser, frame, context);
  }
}

bool KestrelChromiumApp::OnProcessMessageReceived(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefProcessId source_process,
    CefRefPtr<CefProcessMessage> message) {
  return renderer_router_ &&
         renderer_router_->OnProcessMessageReceived(
             browser, frame, source_process, message);
}
