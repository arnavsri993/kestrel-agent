#include "native_isolated_automation.h"
#import <Foundation/Foundation.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <chrono>
#include <map>
#include <set>
#include <utility>
#include <vector>
#include <regex>
#include <sys/stat.h>
#include "include/cef_client.h"
#include "include/cef_parser.h"
#include "include/cef_request_context.h"
#include "include/cef_request_context_handler.h"
#include "include/cef_resource_request_handler.h"
#include "include/cef_render_handler.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_jsdialog_handler.h"
#include "include/cef_permission_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_helpers.h"

namespace {
using Dict = CefRefPtr<CefDictionaryValue>;
using List = CefRefPtr<CefListValue>;
using Value = CefRefPtr<CefValue>;
constexpr size_t kMaxWire = 700000;
constexpr size_t kMaxCommand = 8000000;
constexpr int kRequestTimeoutMs = 15000;

std::string String(Dict value, const char* key) {
  return value && value->GetType(key) == VTYPE_STRING ? value->GetString(key).ToString() : "";
}
int Number(Dict value, const char* key) {
  if (!value) return 0;
  if (value->GetType(key) == VTYPE_INT) return value->GetInt(key);
  if (value->GetType(key) == VTYPE_DOUBLE) {
    double number = value->GetDouble(key);
    if (std::isfinite(number) && number >= 0 && number <= INT32_MAX && std::floor(number) == number) return static_cast<int>(number);
  }
  return 0;
}
double Decimal(Dict value, const char* key) {
  if (!value) return NAN;
  return value->GetType(key) == VTYPE_DOUBLE ? value->GetDouble(key) : value->GetType(key) == VTYPE_INT ? value->GetInt(key) : NAN;
}
std::string JSON(Value value) { return value ? CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString() : "null"; }
std::string JSON(Dict value) { auto root = CefValue::Create(); root->SetDictionary(value); return JSON(root); }
std::string Literal(const std::string& text) { auto value = CefValue::Create(); value->SetString(text); return JSON(value); }
Dict Parse(const std::string& text) {
  if (text.size() > kMaxCommand) return nullptr;
  auto value = CefParseJSON(text, JSON_PARSER_RFC);
  // Detach from the parsed CefValue: child CefRefPtr handles alone do not
  // preserve parent-owned underlying data across asynchronous callbacks.
  return value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary()->Copy(false) : nullptr;
}
bool Sensitive(const std::string& text) {
  static const std::regex pattern("password|one[-_ ]?time|\\botp\\b|recovery|verification|security[-_ ]?code|cvv|cvc|cc-|credit[-_ ]?card|api[-_ ]?(key|token)|access[-_ ]?token|private[-_ ]?key", std::regex::icase);
  return std::regex_search(text, pattern);
}
std::string PublicText(std::string text, size_t limit = 500) {
  static const std::regex credential("(sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}|(gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,})");
  static const std::regex assignment("(api[_ -]?key|access[_ -]?token|authorization|client[_ -]?secret|password|secret|private[_ -]?key|credential)([[:space:]]*[:=][[:space:]]*)[^[:space:]\"'`,;&}]{8,}", std::regex::icase);
  static const std::regex url("(https?|file|ftp|data|javascript|blob):[^[:space:]<>\"'{}]+", std::regex::icase);
  text = std::regex_replace(text, credential, "[redacted credential]");
  text = std::regex_replace(text, assignment, "$1$2[redacted credential]");
  text = std::regex_replace(text, url, "[URL]");
  if (text.size() > limit) { text.resize(limit); while (!text.empty() && (static_cast<unsigned char>(text.back()) & 0xc0) == 0x80) text.pop_back(); }
  return text;
}
std::string Origin(const std::string& url) {
  if (url.empty() || url.size() > 8192 || url.find_first_of("\r\n\t") != std::string::npos) return "";
  CefURLParts parts;
  if (!CefParseURL(url, parts)) return "";
  const std::string scheme = CefString(&parts.scheme).ToString();
  const std::string host = CefString(&parts.host).ToString();
  if ((scheme != "http" && scheme != "https") || host.empty() || parts.username.length || parts.password.length) return "";
  std::string port = CefString(&parts.port).ToString();
  if ((scheme == "http" && port == "80") || (scheme == "https" && port == "443")) port.clear();
  return scheme + "://" + host + (port.empty() ? "" : ":" + port);
}
std::string ObservationURL(std::string url) { auto end = url.find_first_of("?#"); if (end != std::string::npos) url.resize(end); return url; }
bool Allowed(const std::set<std::string>& origins, const std::string& url) { const auto origin = Origin(url); return !origin.empty() && origins.count(origin); }
std::string Ref(std::string ref) {
  ref.erase(0, ref.find_first_not_of(" \t\r\n"));
  auto end = ref.find_last_not_of(" \t\r\n"); if (end != std::string::npos) ref.resize(end + 1);
  if (ref.starts_with("@")) ref.erase(0, 1); else if (ref.starts_with("ref=")) ref.erase(0, 4);
  static const std::regex valid("e[1-9][0-9]{0,8}"); return std::regex_match(ref, valid) ? ref : "";
}

class FunctionTask final : public CefTask {
 public:
  explicit FunctionTask(std::function<void()> fn) : fn_(std::move(fn)) {}
  void Execute() override { if (fn_) fn_(); }
 private:
  std::function<void()> fn_;
  IMPLEMENT_REFCOUNTING(FunctionTask);
};

// Immutable IO-thread policy also installed at RequestContext level, so worker
// and service-worker requests cannot bypass a browser/frame-only filter.
class OriginPolicy final : public CefResourceRequestHandler {
 public:
  explicit OriginPolicy(std::set<std::string> origins) : origins_(std::move(origins)) {}
  ReturnValue OnBeforeResourceLoad(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest> request, CefRefPtr<CefCallback>) override {
    return request && Allowed(origins_, request->GetURL()) ? RV_CONTINUE : RV_CANCEL;
  }
  void OnResourceRedirect(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest>, CefRefPtr<CefResponse>, CefString& new_url) override {
    if (!Allowed(origins_, new_url.ToString())) new_url = "about:blank#kestrel-blocked-redirect";
  }
 private:
  const std::set<std::string> origins_;
  IMPLEMENT_REFCOUNTING(OriginPolicy);
};
class ContextHandler final : public CefRequestContextHandler {
 public:
  ContextHandler(CefRefPtr<OriginPolicy> policy, std::function<void(CefRefPtr<CefRequestContext>)> ready) : policy_(policy), ready_(std::move(ready)) {}
  void OnRequestContextInitialized(CefRefPtr<CefRequestContext> context) override { if (ready_) ready_(context); }
  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest>, bool, bool, const CefString&, bool&) override { return policy_; }
 private:
  CefRefPtr<OriginPolicy> policy_;
  std::function<void(CefRefPtr<CefRequestContext>)> ready_;
  IMPLEMENT_REFCOUNTING(ContextHandler);
};
class Observer final : public CefDevToolsMessageObserver {
 public:
  explicit Observer(std::function<void(int, bool, std::string)> result) : result_(std::move(result)) {}
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int id, bool success, const void* result, size_t size) override {
    if (result_) result_(id, success && size <= kMaxCommand, result && size <= kMaxCommand ? std::string(static_cast<const char*>(result), size) : "");
  }
 private:
  std::function<void(int, bool, std::string)> result_;
  IMPLEMENT_REFCOUNTING(Observer);
};

class BackgroundClient final : public CefClient, public CefLifeSpanHandler,
    public CefLoadHandler, public CefRequestHandler, public CefRenderHandler,
    public CefJSDialogHandler, public CefPermissionHandler, public CefDownloadHandler {
 public:
  std::function<void(CefRefPtr<CefBrowser>)> created;
  std::function<void()> closed, navigating;
  std::function<void(bool)> loaded;
  std::function<void(const std::string&)> failed;
  int width = 1280, height = 720;
  explicit BackgroundClient(std::set<std::string> origins, CefRefPtr<OriginPolicy> policy) : origins_(std::move(origins)), policy_(policy) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefJSDialogHandler> GetJSDialogHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override { rect = CefRect(0, 0, width, height); }
  bool GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo& info) override { info.device_scale_factor = 1; info.depth = 32; info.depth_per_component = 8; info.is_monochrome = false; info.rect = info.available_rect = CefRect(0, 0, width, height); return true; }
  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType, const RectList&, const void*, int, int) override {}
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override { if (created) created(browser); else browser->GetHost()->CloseBrowser(true); }
  void OnBeforeClose(CefRefPtr<CefBrowser>) override { if (closed) closed(); }
  bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int, const CefString&, const CefString&, WindowOpenDisposition, bool, const CefPopupFeatures&, CefWindowInfo&, CefRefPtr<CefClient>&, CefBrowserSettings&, Dict&, bool*) override { return true; }
  bool OnBeforeBrowse(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, CefRefPtr<CefRequest> request, bool, bool) override {
    const std::string url = request ? request->GetURL().ToString() : "";
    if (url != "about:blank" && !Allowed(origins_, url)) { if (frame && frame->IsMain() && failed) failed("Navigation outside the isolated origin allowlist was blocked."); return true; }
    if (frame && frame->IsMain() && navigating) navigating();
    return false;
  }
  bool OnOpenURLFromTab(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, const CefString&, WindowOpenDisposition, bool) override { return true; }
  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int status) override { if (frame && frame->IsMain() && loaded) loaded(status >= 200 && status < 400 || frame->GetURL() == "about:blank"); }
  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, ErrorCode code, const CefString&, const CefString&) override { if (frame && frame->IsMain() && code != ERR_ABORTED && failed) failed("The isolated browser document failed to load."); }
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser>, TerminationStatus, int, const CefString&) override { if (failed) failed("The isolated browser renderer stopped."); }
  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest>, bool, bool, const CefString&, bool&) override { return policy_; }
  bool OnJSDialog(CefRefPtr<CefBrowser>, const CefString&, JSDialogType, const CefString&, const CefString&, CefRefPtr<CefJSDialogCallback> callback, bool&) override { callback->Continue(false, ""); return true; }
  bool OnBeforeUnloadDialog(CefRefPtr<CefBrowser>, const CefString&, bool, CefRefPtr<CefJSDialogCallback> callback) override { callback->Continue(true, ""); return true; }
  bool CanDownload(CefRefPtr<CefBrowser>, const CefString&, const CefString&) override { return false; }
  bool OnRequestMediaAccessPermission(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, const CefString&, uint32_t, CefRefPtr<CefMediaAccessCallback> callback) override { callback->Cancel(); return true; }
  bool OnShowPermissionPrompt(CefRefPtr<CefBrowser>, uint64_t, const CefString&, uint32_t, CefRefPtr<CefPermissionPromptCallback> callback) override { callback->Continue(CEF_PERMISSION_RESULT_DENY); return true; }
 private:
  const std::set<std::string> origins_;
  CefRefPtr<OriginPolicy> policy_;
  IMPLEMENT_REFCOUNTING(BackgroundClient);
};

struct NodeInfo { bool blocked = false, sensitive = false, editable = false, unsafe_name = false; int parent = 0; std::string tag; };
struct DOMMetadata {
  std::map<int, NodeInfo> nodes;
  size_t visited = 0;
  bool truncated = false, sensitive = false;
  bool Walk(Dict node, bool private_parent = false, bool editable_parent = false, int parent = 0) {
    if (!node || ++visited > 10000) { truncated = true; return true; }
    const int backend = Number(node, "backendNodeId"); if (backend <= 0) { truncated = true; return true; }
    // Validate the complete bounded attribute vector before trusting any
    // privacy classification. An omitted marker beyond our scan budget must
    // never turn an unknown subtree into public AX names.
    std::map<std::string, std::string> attrs;
    static const std::set<std::string> relevant = {"type", "name", "id", "autocomplete", "aria-label", "placeholder", "contenteditable", "data-private", "data-sensitive", "hidden", "aria-hidden", "inert"};
    auto attributes = node->GetType("attributes") == VTYPE_LIST ? node->GetList("attributes") : nullptr;
    bool ambiguous = node->HasKey("attributes") && !attributes;
    if (attributes && (attributes->GetSize() > 200 || attributes->GetSize() % 2)) ambiguous = true;
    std::set<std::string> seen;
    for (size_t i = 0; !ambiguous && attributes && i < attributes->GetSize(); i += 2) {
      if (attributes->GetType(i) != VTYPE_STRING || attributes->GetType(i + 1) != VTYPE_STRING) { ambiguous = true; break; }
      const auto raw_name = attributes->GetString(i), raw_value = attributes->GetString(i + 1);
      // Check UTF-16 lengths before allocating UTF-8 strings or map entries.
      if (raw_name.empty() || raw_name.length() > 128 || raw_value.length() > 4096) { ambiguous = true; break; }
      std::string name = raw_name.ToString();
      std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; });
      if (!seen.insert(name).second) { ambiguous = true; break; }
      if (relevant.count(name)) attrs.emplace(name, raw_value.ToString());
    }
    if (ambiguous) { truncated = true; sensitive = true; }
    NodeInfo info; info.parent = parent; info.tag = String(node, "nodeName");
    const auto& type = attrs["type"];
    info.editable = info.tag == "TEXTAREA" || info.tag == "INPUT" && type != "button" && type != "submit" && type != "reset" && type != "checkbox" && type != "radio" && type != "range" || attrs.count("contenteditable") && attrs["contenteditable"] != "false";
    info.sensitive = ambiguous || Sensitive(type + " " + attrs["name"] + " " + attrs["id"] + " " + attrs["autocomplete"] + " " + attrs["aria-label"] + " " + attrs["placeholder"]);
    const bool private_node = private_parent || ambiguous || attrs.count("data-private") || attrs.count("data-sensitive") || attrs.count("hidden") || attrs["aria-hidden"] == "true" || attrs.count("inert");
    const bool executable = info.tag == "SCRIPT" || info.tag == "STYLE" || info.tag == "NOSCRIPT" || info.tag == "TEMPLATE";
    info.blocked = private_node || editable_parent || executable;
    sensitive |= info.sensitive || attrs.count("data-private") || attrs.count("data-sensitive");
    if (node->HasKey("shadowRoots") || node->HasKey("contentDocument") || info.tag == "IFRAME" || info.tag == "FRAME" || info.tag == "FENCEDFRAME") truncated = true;
    auto children = node->GetType("children") == VTYPE_LIST ? node->GetList("children") : nullptr;
    if (Number(node, "childNodeCount") > (children ? children->GetSize() : 0)) truncated = true;
    bool tainted_children = false;
    for (size_t i = 0; children && i < children->GetSize() && visited <= 10000; ++i) tainted_children |= Walk(children->GetDictionary(i), private_node || executable || info.sensitive, editable_parent || info.editable, backend);
    info.unsafe_name = tainted_children;
    nodes[backend] = info;
    return private_node || info.editable || info.sensitive || tainted_children;
  }
  void ApplyAXSensitivity(List raw) {
    if (!raw) return;
    if (raw->GetSize() > 10000) {
      truncated = true; sensitive = true;
      for (auto& [id, info] : nodes) info.blocked = true;
      return;
    }
    for (size_t i = 0; i < raw->GetSize(); ++i) {
      if (raw->GetType(i) != VTYPE_DICTIONARY) continue;
      auto ax = raw->GetDictionary(i); auto info = nodes.find(Number(ax, "backendDOMNodeId"));
      if (info == nodes.end() || ax->GetType("name") != VTYPE_DICTIONARY) continue;
      auto name = ax->GetDictionary("name"); if (name->GetType("value") != VTYPE_STRING) continue;
      const auto value = name->GetString("value");
      if (value.length() > 4096) { info->second.blocked = true; info->second.sensitive = true; truncated = true; sensitive = true; }
      else if (Sensitive(value.ToString())) { info->second.sensitive = true; sensitive = true; }
    }
    for (auto& [id, info] : nodes) {
      int ancestor = info.parent;
      for (size_t depth = 0; ancestor && depth <= 32; ++depth) {
        const auto parent = nodes.find(ancestor);
        if (parent == nodes.end() || parent->second.blocked || parent->second.sensitive) { info.blocked = true; break; }
        ancestor = parent->second.parent;
      }
    }
  }
  bool ScreenshotSafe() const {
    if (truncated || sensitive) return false;
    for (const auto& [id, info] : nodes) {
      if (info.editable || info.tag == "OBJECT" || info.tag == "EMBED" || info.tag == "CANVAS" || info.tag == "VIDEO") return false;
      if (info.blocked && info.tag != "SCRIPT" && info.tag != "STYLE" && info.tag != "NOSCRIPT" && info.tag != "TEMPLATE" && info.tag != "#text" && info.tag != "#comment") return false;
    }
    return true;
  }
};
const std::set<std::string> kInteractive = {"button","link","textbox","searchbox","combobox","checkbox","radio","switch","tab","menuitem","slider","spinbutton","option","listbox","treeitem","cell","gridcell","row","textfield","textarea"};

constexpr char kInspect[] = R"KESTREL(function inspectTarget(mode, value) {
	const node = this;
	const doc = node.ownerDocument;
	if (!doc || !node.isConnected || !(node instanceof Element) || node.getRootNode() !== doc) return { ok: false, code: "detached_or_wrong_document" };
	for (let current = node; current; current = current.parentElement) {
		const style = getComputedStyle(current);
		if (current.matches("[data-private], [data-sensitive], [hidden], [inert], [aria-hidden='true']")) return { ok: false, code: "private_or_inert" };
		if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return { ok: false, code: "not_visible" };
		const hint = ["type", "name", "id", "autocomplete", "aria-label", "placeholder"].map(key => current.getAttribute(key) || "").join(" ");
		if (/password|one[-_ ]?time|\botp\b|recovery|verification|security[-_ ]?code|cvv|cvc|cc-|credit[-_ ]?card|api[-_ ]?(?:key|token)|access[-_ ]?token|private[-_ ]?key/i.test(hint)) return { ok: false, code: "sensitive" };
	}
	if (node.matches(":disabled, [aria-disabled='true']")) return { ok: false, code: "disabled" };
	const label = Array.from(node.labels || []).map(label => label.textContent || "").join(" ");
	if (/password|one[-_ ]?time|\botp\b|verification|recovery|security[-_ ]?code|cvv|cvc|credit[-_ ]?card|api[-_ ]?(?:key|token)|access[-_ ]?token|private[-_ ]?key/i.test(label)) return { ok: false, code: "sensitive" };
	const box = node.getBoundingClientRect();
	const left = Math.max(0, box.left), top = Math.max(0, box.top);
	const right = Math.min(doc.documentElement.clientWidth, box.right), bottom = Math.min(doc.documentElement.clientHeight, box.bottom);
	if (!(right > left && bottom > top)) return { ok: false, code: "outside_viewport" };
	const x = (left + right) / 2, y = (top + bottom) / 2;
	const hit = doc.elementFromPoint(x, y);
	if (!hit || (hit !== node && !node.contains(hit))) return { ok: false, code: "obscured" };
	if (mode === "focused" && doc.activeElement !== node) return { ok: false, code: "focus_changed" };
	if (mode === "focused" && !doc.hasFocus()) return { ok: false, code: "document_not_focused" };
	if (mode === "type" || mode === "focused") {
		if (node.readOnly) return { ok: false, code: "read_only" };
		if (!(node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ["text", "search", "email", "url", "tel"].includes(node.type) || node.isContentEditable)) return { ok: false, code: "not_editable" };
	}
	if (mode === "select") {
		if (!(node instanceof HTMLSelectElement) || node.multiple || !Array.from(node.options).some(option => option.value === value && !option.disabled && !option.parentElement?.disabled)) return { ok: false, code: "selection_unavailable" };
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
		setter.call(node, value);
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
		return node.isConnected && node.value === value ? { ok: true } : { ok: false, code: "selection_changed" };
	}
	return { ok: true, x, y };
})KESTREL";
}

struct NativeIsolatedAutomation::Impl : std::enable_shared_from_this<Impl> {
  using CommandReply = std::function<void(Dict)>;
  struct ElementRef { int backend = 0; std::string role, name; };
  struct Session {
    std::string id, request, operation, url, loader, frame, navigate_url;
    uint64_t request_token = 0, generation = 0, refs_generation = 0;
    int world = 0;
    bool loaded = false, closing = false, initial_document = true, input_started = false;
    std::chrono::steady_clock::time_point refs_created;
    CefRefPtr<CefBrowser> browser;
    CefRefPtr<BackgroundClient> client;
    CefRefPtr<CefRequestContext> context;
    CefRefPtr<ContextHandler> context_handler;
    CefRefPtr<CefRegistration> registration;
    std::set<std::string> origins;
    std::map<std::string, ElementRef> refs;
    std::map<int, std::function<void(bool, const std::string&)>> commands;
    std::vector<std::string> diagnostics;
  };
  Reply reply;
  bool stopping = false;
  uint64_t next_ref = 1;
  std::map<std::string, std::shared_ptr<Session>> sessions;
  std::set<std::string> requests;
  std::set<std::string> closed_requests;
  std::vector<std::function<void()>> shutdown_callbacks;
  // Retain the implementation until OSR OnBeforeClose completes, even if the
  // desktop releases its manager immediately after requesting shutdown.
  std::shared_ptr<Impl> shutdown_hold;

  explicit Impl(Reply callback) : reply(std::move(callback)) {}
  bool Current(const std::shared_ptr<Session>& s) const {
    auto it = sessions.find(s->id); return it != sessions.end() && it->second == s && !s->closing;
  }
  void ReplyNow(const std::string& request, bool ok, std::string result = "null", std::string error = "") {
    if (request.empty()) return;
    if (result.size() > kMaxWire) { ok = false; result.clear(); error = "The isolated browser result exceeded the bounded bridge limit."; }
    requests.erase(request);
    closed_requests.insert(request);
    if (closed_requests.size() > 2048) closed_requests.erase(closed_requests.begin());
    if (reply) reply(request, ok, result, error);
  }
  void Finish(const std::shared_ptr<Session>& s, bool ok, std::string result = "null", const std::string& error = "") {
    const auto request = std::exchange(s->request, "");
    const bool uncertain_input = !ok && s->input_started;
    s->input_started = false;
    if (s->browser && s->browser->IsValid()) { auto release = CefDictionaryValue::Create(); release->SetString("objectGroup", "kestrel-automation-" + std::to_string(s->request_token)); s->browser->GetHost()->ExecuteDevToolsMethod(0, "Runtime.releaseObjectGroup", release); }
    s->operation.clear(); s->commands.clear(); ++s->request_token;
    // Destroy the renderer after any uncertain input acknowledgement, so a
    // stranded press cannot leak into a later document or be replayed.
    if (uncertain_input) Close(s);
    if (!ok && !error.empty()) { s->diagnostics.push_back(error); if (s->diagnostics.size() > 20) s->diagnostics.erase(s->diagnostics.begin()); }
    ReplyNow(request, ok, std::move(result), error);
  }
  void CheckShutdown() {
    if (!stopping || !sessions.empty()) return;
    auto callbacks = std::move(shutdown_callbacks);
    auto keep_alive = shared_from_this(); shutdown_hold.reset();
    for (auto& callback : callbacks) if (callback) callback();
  }
  void Closed(const std::shared_ptr<Session>& s) {
    if (!s->request.empty()) Finish(s, false, "", "The isolated browser session closed.");
    s->registration = nullptr; s->browser = nullptr; s->client = nullptr;
    s->context_handler = nullptr; s->context = nullptr; sessions.erase(s->id);
    CheckShutdown();
  }
  void Close(const std::shared_ptr<Session>& s) {
    if (s->closing) return;
    s->closing = true; s->refs.clear(); s->commands.clear();
    if (s->browser && s->browser->IsValid()) s->browser->GetHost()->CloseBrowser(true);
    else if (!s->client) Closed(s);
    // Browser creation may still be asynchronous. Its callback closes it and
    // OnBeforeClose remains the only terminal signal once creation was sent.
  }
  void Start(const std::shared_ptr<Session>& s, const std::string& request, const std::string& operation) {
    s->request = request; s->operation = operation; const auto token = ++s->request_token;
    requests.insert(request);
    std::weak_ptr<Impl> weak = weak_from_this(); std::weak_ptr<Session> weak_session = s;
    CefPostDelayedTask(TID_UI, new FunctionTask([weak, weak_session, token] {
      auto self = weak.lock(); auto session = weak_session.lock();
      if (!self || !session || !self->Current(session) || session->request_token != token || session->request.empty()) return;
      self->Finish(session, false, "", "The isolated browser request timed out. Its effect may have started; do not replay it.");
      self->Close(session);
    }), kRequestTimeoutMs);
  }
  void NavigateStarted(const std::shared_ptr<Session>& s) {
    if (!Current(s)) return;
    ++s->generation; s->loaded = false; s->world = 0; s->refs.clear(); s->loader.clear(); s->frame.clear();
    if (!s->request.empty() && s->operation != "navigate" && s->operation != "create") Finish(s, false, "", "The isolated browser document changed. Read it again; do not replay an action.");
  }
  void LoadFinished(const std::shared_ptr<Session>& s, bool success) {
    if (!Current(s) || !s->browser || !s->browser->IsValid()) return;
    const auto url = s->browser->GetMainFrame()->GetURL().ToString();
    if (url == "about:blank" && s->initial_document) { s->initial_document = false; s->loaded = true; return; }
    if (!success || !Allowed(s->origins, url)) { if (!s->request.empty()) Finish(s, false, "", "The isolated browser navigation failed or left its origin allowlist."); return; }
    s->loaded = true; s->url = url;
    if (s->operation == "navigate") Finish(s, true);
  }
  void Command(const std::shared_ptr<Session>& s, const std::string& method, Dict params, CommandReply callback) {
    if (!Current(s) || s->request.empty() || !s->browser || !s->browser->IsValid()) return;
    const auto token = s->request_token, generation = s->generation;
    const int id = s->browser->GetHost()->ExecuteDevToolsMethod(0, method, params ? params : CefDictionaryValue::Create());
    if (id <= 0) { Finish(s, false, "", "The isolated Chromium command could not be submitted."); return; }
    std::weak_ptr<Impl> weak = weak_from_this(); std::weak_ptr<Session> weak_session = s;
    s->commands[id] = [weak, weak_session, token, generation, callback = std::move(callback)](bool success, const std::string& json) {
      auto self = weak.lock(); auto session = weak_session.lock();
      if (!self || !session || !self->Current(session) || session->request_token != token || session->request.empty()) return;
      if (session->generation != generation) { self->Finish(session, false, "", "The isolated browser document changed; do not replay the action."); return; }
      const auto result = success ? Parse(json) : nullptr;
      if (!result || result->HasKey("exceptionDetails")) { self->Finish(session, false, "", "The isolated Chromium operation failed. Take a fresh observation before continuing."); return; }
      callback(result);
    };
  }
  void Document(const std::shared_ptr<Session>& s, std::function<void()> callback, bool pin = false) {
    Command(s, "Page.getFrameTree", nullptr, [this, s, callback = std::move(callback), pin](Dict result) {
      auto tree = result->GetType("frameTree") == VTYPE_DICTIONARY ? result->GetDictionary("frameTree") : nullptr;
      auto frame = tree && tree->GetType("frame") == VTYPE_DICTIONARY ? tree->GetDictionary("frame") : nullptr;
      const auto url = String(frame, "url"), id = String(frame, "id"), loader = String(frame, "loaderId");
      if (!frame || id.empty() || loader.empty() || !Allowed(s->origins, url) || !s->loaded || s->browser->IsLoading() || s->browser->GetMainFrame()->GetURL() != url || !pin && (s->frame != id || s->loader != loader || s->url != url)) {
        Finish(s, false, "", "The isolated browser document is changing or unavailable. Read it again before acting."); return;
      }
      if (pin) { s->frame = id; s->loader = loader; s->url = url; }
      callback();
    });
  }
  void Prepare(const std::shared_ptr<Session>& s, std::function<void()> callback) {
    Document(s, [this, s, callback = std::move(callback)] {
      auto params = CefDictionaryValue::Create(); params->SetString("frameId", s->frame); params->SetString("worldName", "kestrel-isolated-automation"); params->SetBool("grantUniveralAccess", false);
      Command(s, "Page.createIsolatedWorld", params, [this, s, callback](Dict result) {
        s->world = Number(result, "executionContextId");
        if (!s->world) { Finish(s, false, "", "The isolated browser document context is unavailable."); return; }
        callback();
      });
    }, true);
  }
  void DOM(const std::shared_ptr<Session>& s, std::function<void(Dict, std::shared_ptr<DOMMetadata>)> callback) {
    auto params = CefDictionaryValue::Create(); params->SetInt("depth", 32); params->SetBool("pierce", false);
    Command(s, "DOM.getDocument", params, [this, s, callback](Dict result) {
      auto root = result->GetType("root") == VTYPE_DICTIONARY ? result->GetDictionary("root") : nullptr;
      auto metadata = std::make_shared<DOMMetadata>(); metadata->Walk(root);
      if (!root || metadata->nodes.empty()) { Finish(s, false, "", "The isolated browser DOM is unavailable."); return; }
      callback(root, metadata);
    });
  }
  void Resolve(const std::shared_ptr<Session>& s, int backend, std::function<void(const std::string&)> callback) {
    auto params = CefDictionaryValue::Create(); params->SetInt("backendNodeId", backend); params->SetInt("executionContextId", s->world); params->SetString("objectGroup", "kestrel-automation-" + std::to_string(s->request_token));
    Command(s, "DOM.resolveNode", params, [this, s, callback](Dict result) {
      const auto object = result->GetType("object") == VTYPE_DICTIONARY ? result->GetDictionary("object") : nullptr;
      const auto id = String(object, "objectId");
      if (id.empty()) { Finish(s, false, "", "The observed isolated browser node is no longer available."); return; }
      callback(id);
    });
  }
  void Inspect(const std::shared_ptr<Session>& s, const std::string& object, const std::string& mode, const std::string& value, std::function<void(Dict)> callback) {
    auto args = CefListValue::Create(); auto arg = CefDictionaryValue::Create(); arg->SetString("value", mode); args->SetDictionary(0, arg); arg = CefDictionaryValue::Create(); arg->SetString("value", value); args->SetDictionary(1, arg);
    auto params = CefDictionaryValue::Create(); params->SetString("objectId", object); params->SetString("functionDeclaration", kInspect); params->SetList("arguments", args); params->SetBool("returnByValue", true);
    Command(s, "Runtime.callFunctionOn", params, [this, s, mode, callback](Dict result) {
      auto remote = result->GetType("result") == VTYPE_DICTIONARY ? result->GetDictionary("result") : nullptr;
      auto value = remote && remote->GetType("value") == VTYPE_DICTIONARY ? remote->GetDictionary("value") : nullptr;
      if (!value || !value->GetBool("ok")) {
        static const std::set<std::string> reasons = {"detached_or_wrong_document", "private_or_inert", "not_visible", "sensitive", "disabled", "outside_viewport", "obscured", "focus_changed", "document_not_focused", "read_only", "not_editable", "selection_unavailable", "selection_changed"};
        static const std::set<std::string> modes = {"click", "type", "focused", "select"};
        const auto raw_code = String(value, "code");
        const auto code = reasons.count(raw_code) ? raw_code : "invalid_guard_result";
        const auto phase = modes.count(mode) ? mode : "target";
        // Only fixed diagnostic enum values cross the bridge. Never include
        // labels, attributes, DOM values, coordinates, or exception messages.
        Finish(s, false, "", "The isolated browser target check failed (" + phase + ":" + code + ")."); return;
      }
      callback(value);
    });
  }
  std::string AXName(Dict node, int backend, const DOMMetadata& metadata) {
    const auto it = metadata.nodes.find(backend); if (it == metadata.nodes.end()) return "";
    if (it->second.sensitive) return "Sensitive field";
    auto name = node->GetType("name") == VTYPE_DICTIONARY ? node->GetDictionary("name") : nullptr;
    if (!name) return "";
    auto role = node->GetType("role") == VTYPE_DICTIONARY ? node->GetDictionary("role") : nullptr;
    if (it->second.unsafe_name && String(role, "value") != "RootWebArea") return "";
    auto sources = name->GetType("sources") == VTYPE_LIST ? name->GetList("sources") : nullptr;
    for (size_t i = 0; sources && i < sources->GetSize(); ++i) {
      auto source = sources->GetType(i) == VTYPE_DICTIONARY ? sources->GetDictionary(i) : nullptr;
      if (!source || source->GetBool("superseded")) continue;
      for (const char* key : {"value", "attributeValue"}) {
        auto value = source->GetType(key) == VTYPE_DICTIONARY ? source->GetDictionary(key) : nullptr;
        auto related = value && value->GetType("relatedNodes") == VTYPE_LIST ? value->GetList("relatedNodes") : nullptr;
        for (size_t j = 0; related && j < related->GetSize(); ++j) {
          auto item = related->GetDictionary(j); auto info = metadata.nodes.find(Number(item, "backendDOMNodeId"));
          if (info == metadata.nodes.end() || info->second.blocked || info->second.editable || info->second.sensitive || info->second.unsafe_name) return "";
        }
      }
    }
    const auto raw = String(name, "value"); return Sensitive(raw) ? "Sensitive field" : PublicText(raw);
  }
  void Snapshot(const std::shared_ptr<Session>& s) {
    s->refs.clear();
    Prepare(s, [this, s] { DOM(s, [this, s](Dict, std::shared_ptr<DOMMetadata> metadata) {
      auto params = CefDictionaryValue::Create(); params->SetString("frameId", s->frame); params->SetInt("depth", 20);
      Command(s, "Accessibility.getFullAXTree", params, [this, s, metadata](Dict result) {
        auto raw = result->GetType("nodes") == VTYPE_LIST ? result->GetList("nodes") : nullptr;
        if (!raw) { Finish(s, false, "", "The isolated browser accessibility tree is unavailable."); return; }
        metadata->ApplyAXSensitivity(raw);
        auto nodes = CefListValue::Create(), interactive = CefListValue::Create(); bool truncated = metadata->truncated;
        for (size_t i = 0; i < raw->GetSize(); ++i) {
          if (nodes->GetSize() >= 1500) { truncated = true; break; }
          if (raw->GetType(i) != VTYPE_DICTIONARY) continue;
          auto source = raw->GetDictionary(i); const int backend = Number(source, "backendDOMNodeId");
          auto info = metadata->nodes.find(backend);
          if (info == metadata->nodes.end() || info->second.blocked || source->GetBool("ignored")) continue;
          auto role = source->GetType("role") == VTYPE_DICTIONARY ? source->GetDictionary("role") : nullptr;
          const auto role_text = PublicText(String(role, "value"), 60); if (role_text.empty()) continue;
          const auto name = AXName(source, backend, *metadata);
          auto node = CefDictionaryValue::Create(); node->SetString("nodeId", PublicText(String(source, "nodeId"), 100));
          auto field = CefDictionaryValue::Create(); field->SetString("value", role_text); node->SetDictionary("role", field);
          field = CefDictionaryValue::Create(); field->SetString("value", name); node->SetDictionary("name", field); node->SetInt("backendDOMNodeId", backend);
          if (kInteractive.count(role_text)) {
            if (interactive->GetSize() < 200 && next_ref < 999999999) {
              const auto ref = "e" + std::to_string(next_ref++); node->SetString("ref", ref);
              auto item = CefDictionaryValue::Create(); item->SetString("ref", ref); item->SetString("role", role_text); item->SetString("name", name); item->SetInt("backendDOMNodeId", backend); interactive->SetDictionary(interactive->GetSize(), item);
              s->refs[ref] = {backend, role_text, name};
            } else truncated = true;
          }
          nodes->SetDictionary(nodes->GetSize(), node);
        }
        auto response = CefDictionaryValue::Create(), tree = CefDictionaryValue::Create(); tree->SetList("nodes", nodes);
        response->SetDictionary("accessibilityTree", tree); response->SetList("interactive", interactive); response->SetString("url", ObservationURL(s->url)); response->SetString("title", PublicText(s->browser->GetMainFrame()->GetName().ToString()));
        // AX RootWebArea supplies the public document title without reading DOM
        // content or carrying input values over the authenticated pipe.
        for (size_t i = 0; i < nodes->GetSize(); ++i) { auto node = nodes->GetDictionary(i); if (String(node->GetDictionary("role"), "value") == "RootWebArea") { response->SetString("title", String(node->GetDictionary("name"), "value")); break; } }
        response->SetBool("truncated", truncated); response->SetString("trust", "untrusted_browser");
        Document(s, [this, s, response] { s->refs_generation = s->generation; s->refs_created = std::chrono::steady_clock::now(); Finish(s, true, JSON(response)); });
      });
    }); });
  }
  void Input(const std::shared_ptr<Session>& s, const std::string& method, Dict params, std::function<void()> next) {
    Document(s, [this, s, method, params, next] {
      // Windowless CEF has no platform view to forward focus automatically.
      // Set the OSR browser's focus before DOM.focus/native input; this never
      // creates, activates, shows, or reparents a native window.
      if (method == "DOM.focus" || method.starts_with("Input.")) s->browser->GetHost()->SetFocus(true);
      if (method.starts_with("Input.")) s->input_started = true;
      Command(s, method, params, [next](Dict) { next(); });
    });
  }
  void Target(const std::shared_ptr<Session>& s, const ElementRef& ref, const std::string& mode, std::function<void(const std::string&, Dict)> next) {
    DOM(s, [this, s, ref, mode, next](Dict, std::shared_ptr<DOMMetadata> metadata) {
      auto info = metadata->nodes.find(ref.backend);
      if (info == metadata->nodes.end() || info->second.blocked || info->second.sensitive) { Finish(s, false, "", "The browser target became private, sensitive, or stale."); return; }
      auto params = CefDictionaryValue::Create(); params->SetInt("backendNodeId", ref.backend); params->SetBool("fetchRelatives", false);
      Command(s, "Accessibility.getPartialAXTree", params, [this, s, ref, mode, next, metadata](Dict result) {
        auto raw = result->GetType("nodes") == VTYPE_LIST ? result->GetList("nodes") : nullptr; metadata->ApplyAXSensitivity(raw); bool matched = false;
        for (size_t i = 0; raw && i < raw->GetSize(); ++i) {
          auto node = raw->GetDictionary(i); if (!node || Number(node, "backendDOMNodeId") != ref.backend || node->GetBool("ignored")) continue;
          auto role = node->GetType("role") == VTYPE_DICTIONARY ? node->GetDictionary("role") : nullptr;
          auto fresh = metadata->nodes.find(ref.backend);
          matched = fresh != metadata->nodes.end() && !fresh->second.blocked && !fresh->second.sensitive && PublicText(String(role, "value"), 60) == ref.role && AXName(node, ref.backend, *metadata) == ref.name; break;
        }
        if (!matched) { Finish(s, false, "", "The observed browser control changed. Take a fresh snapshot."); return; }
        Resolve(s, ref.backend, [this, s, mode, next](const std::string& object) { Inspect(s, object, mode, "", [next, object](Dict point) { next(object, point); }); });
      });
    });
  }
  void ActTarget(const std::shared_ptr<Session>& s, const ElementRef& ref, const std::string& type, Dict action) {
    if (!action || !action->IsValid() || String(action, "type") != type || (type != "click" && type != "type" && type != "select")) {
      Finish(s, false, "", "The isolated browser action data became invalid before dispatch."); return;
    }
    Target(s, ref, type == "type" ? "type" : "click", [this, s, ref, action, type](const std::string& object, Dict point) {
      if (type == "click") {
        const auto x = Decimal(point, "x"), y = Decimal(point, "y");
        if (!std::isfinite(x) || !std::isfinite(y)) { Finish(s, false, "", "The observed browser target has invalid bounds."); return; }
        auto down = CefDictionaryValue::Create(); down->SetString("type", "mousePressed"); down->SetString("button", "left"); down->SetInt("buttons", 1); down->SetInt("clickCount", 1); down->SetDouble("x", x); down->SetDouble("y", y);
        auto up = down->Copy(false); up->SetString("type", "mouseReleased"); up->SetInt("buttons", 0);
        Input(s, "Input.dispatchMouseEvent", down, [this, s, up] { Input(s, "Input.dispatchMouseEvent", up, [this, s] { Finish(s, true); }); });
      } else if (type == "type") {
        auto focus = CefDictionaryValue::Create(); focus->SetInt("backendNodeId", ref.backend);
        Input(s, "DOM.focus", focus, [this, s, object, action] { Inspect(s, object, "focused", "", [this, s, action](Dict) {
          auto input = CefDictionaryValue::Create(); input->SetString("text", String(action, "text")); Input(s, "Input.insertText", input, [this, s] { Finish(s, true); });
        }); });
      } else if (type == "select") {
        Document(s, [this, s, object, action] { Inspect(s, object, "select", String(action, "value"), [this, s](Dict) { Finish(s, true); }); });
      } else {
        Finish(s, false, "", "The isolated browser action type is invalid.");
      }
    });
  }
  void Key(const std::shared_ptr<Session>& s, const std::string& key, const std::map<std::string, ElementRef>& refs) {
    static const std::map<std::string, int> keys = {{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34},{" ",32}};
    if (!keys.count(key)) { Finish(s, false, "", "Only one unmodified supported browser key may be sent."); return; }
    auto params = CefDictionaryValue::Create(); params->SetString("expression", "document.activeElement"); params->SetString("objectGroup", "kestrel-automation-" + std::to_string(s->request_token)); params->SetInt("contextId", s->world); params->SetBool("returnByValue", false);
    Command(s, "Runtime.evaluate", params, [this, s, key, refs](Dict result) {
      auto remote = result->GetType("result") == VTYPE_DICTIONARY ? result->GetDictionary("result") : nullptr;
      const auto object = String(remote, "objectId"); if (object.empty()) { Finish(s, false, "", "The focused browser control is unavailable."); return; }
      auto params = CefDictionaryValue::Create(); params->SetString("objectId", object); params->SetInt("depth", 0);
      Command(s, "DOM.describeNode", params, [this, s, key, refs, object](Dict result) {
        auto node = result->GetType("node") == VTYPE_DICTIONARY ? result->GetDictionary("node") : nullptr;
        const int backend = Number(node, "backendNodeId"); auto ref = std::find_if(refs.begin(), refs.end(), [backend](const auto& item) { return item.second.backend == backend; });
        if (ref == refs.end()) { Finish(s, false, "", "The focused control requires a fresh snapshot ref."); return; }
        Target(s, ref->second, "click", [this, s, key, object](const std::string&, Dict) {
          auto check = CefDictionaryValue::Create(); check->SetString("objectId", object); check->SetString("functionDeclaration", "function () { return this.ownerDocument.activeElement === this; }"); check->SetBool("returnByValue", true);
          Command(s, "Runtime.callFunctionOn", check, [this, s, key](Dict result) {
            if (result->GetType("result") != VTYPE_DICTIONARY || !result->GetDictionary("result")->GetBool("value")) { Finish(s, false, "", "The browser focus changed before key input."); return; }
            auto down = CefDictionaryValue::Create(); down->SetString("key", key); down->SetInt("windowsVirtualKeyCode", keys.at(key)); down->SetString("type", "keyDown"); down->SetInt("modifiers", 0);
            auto up = down->Copy(false); up->SetString("type", "keyUp");
            Input(s, "Input.dispatchKeyEvent", down, [this, s, up] { Input(s, "Input.dispatchKeyEvent", up, [this, s] { Finish(s, true); }); });
          });
        });
      });
    });
  }
  void Scroll(const std::shared_ptr<Session>& s, Dict action) {
    Command(s, "Page.getLayoutMetrics", nullptr, [this, s, action](Dict result) {
      auto viewport = result->GetType("cssVisualViewport") == VTYPE_DICTIONARY ? result->GetDictionary("cssVisualViewport") : nullptr;
      const double width = Decimal(viewport, "clientWidth"), height = Decimal(viewport, "clientHeight");
      if (!(width > 0 && height > 0) || Decimal(viewport, "scale") != 1) { Finish(s, false, "", "The browser scroll viewport is unavailable."); return; }
      const double x = width / 2, y = height / 2;
      auto hit = CefDictionaryValue::Create(); hit->SetInt("x", x); hit->SetInt("y", y); hit->SetBool("includeUserAgentShadowDOM", false);
      Command(s, "DOM.getNodeForLocation", hit, [this, s, x, y, action](Dict hit) {
        const int backend = Number(hit, "backendNodeId");
        DOM(s, [this, s, backend, x, y, action](Dict, std::shared_ptr<DOMMetadata> metadata) {
          auto info = metadata->nodes.find(backend);
          if (info == metadata->nodes.end() || info->second.blocked || info->second.sensitive) { Finish(s, false, "", "The browser scroll target is private or unavailable."); return; }
          Resolve(s, backend, [this, s, x, y, action](const std::string& object) { Inspect(s, object, "click", "", [this, s, x, y, action](Dict) {
            auto wheel = CefDictionaryValue::Create(); wheel->SetString("type", "mouseWheel"); wheel->SetDouble("x", x); wheel->SetDouble("y", y); wheel->SetDouble("deltaX", Decimal(action, "x")); wheel->SetDouble("deltaY", Decimal(action, "y"));
            Input(s, "Input.dispatchMouseEvent", wheel, [this, s] { Finish(s, true); });
          }); });
        });
      });
    });
  }
  void Screenshot(const std::shared_ptr<Session>& s) {
    Prepare(s, [this, s] { DOM(s, [this, s](Dict, std::shared_ptr<DOMMetadata> before) {
      if (!before->ScreenshotSafe()) { Finish(s, false, "", "Screenshots of private, editable, or ambiguous documents are refused."); return; }
      auto params = CefDictionaryValue::Create(); params->SetString("format", "png"); params->SetBool("fromSurface", true); params->SetBool("captureBeyondViewport", false);
      Command(s, "Page.captureScreenshot", params, [this, s, before](Dict result) {
        const auto png = String(result, "data");
        if (png.size() < 44 || png.size() > 650000) { Finish(s, false, "", "The browser PNG exceeded the bounded screenshot limit."); return; }
        auto binary = CefBase64Decode(png); std::vector<unsigned char> bytes(binary ? binary->GetSize() : 0);
        if (binary && !bytes.empty()) binary->GetData(bytes.data(), bytes.size(), 0);
        const unsigned char signature[] = {137,80,78,71,13,10,26,10};
        if (bytes.size() < 33 || !std::equal(std::begin(signature), std::end(signature), bytes.begin()) || std::string(bytes.begin() + 12, bytes.begin() + 16) != "IHDR") { Finish(s, false, "", "The browser screenshot was not a valid PNG frame."); return; }
        const auto number = [&bytes](size_t at) { return uint32_t(bytes[at]) << 24 | uint32_t(bytes[at+1]) << 16 | uint32_t(bytes[at+2]) << 8 | uint32_t(bytes[at+3]); };
        const uint32_t width = number(16), height = number(20);
        if (!width || !height || width > 4096 || height > 4096 || uint64_t(width) * height > 8000000) { Finish(s, false, "", "The browser screenshot pixel dimensions exceeded limits."); return; }
        DOM(s, [this, s, before, png, width, height](Dict, std::shared_ptr<DOMMetadata> after) {
          bool same = before->nodes.size() == after->nodes.size();
          for (const auto& [id, info] : before->nodes) {
            const auto it = after->nodes.find(id);
            if (it == after->nodes.end() || it->second.tag != info.tag || it->second.blocked != info.blocked || it->second.sensitive != info.sensitive || it->second.editable != info.editable) { same = false; break; }
          }
          if (!same || !after->ScreenshotSafe()) { Finish(s, false, "", "The browser document changed during capture. Discard the frame."); return; }
          auto frame = CefDictionaryValue::Create(); frame->SetInt("version", 1); frame->SetString("encoding", "png"); frame->SetString("pngBase64", png); frame->SetInt("width", width); frame->SetInt("height", height); frame->SetString("trust", "untrusted_browser");
          Document(s, [this, s, frame] { Finish(s, true, JSON(frame)); });
        });
      });
    }); });
  }
  void Upload(const std::shared_ptr<Session>& s, const std::string& selector, List paths) {
    auto files = CefListValue::Create();
    for (size_t i = 0; i < paths->GetSize(); ++i) {
      const std::string path = paths->GetType(i) == VTYPE_STRING ? paths->GetString(i).ToString() : "";
      struct stat info;
      if (path.empty() || path.front() != '/' || path.size() > 4096 || path.find('\0') != std::string::npos || lstat(path.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) { Finish(s, false, "", "The approved browser upload file is unavailable or is not a regular file."); return; }
      files->SetString(i, path);
    }
    Prepare(s, [this, s, selector, files] { DOM(s, [this, s, selector, files](Dict root, std::shared_ptr<DOMMetadata>) {
      auto query = CefDictionaryValue::Create(); query->SetInt("nodeId", Number(root, "nodeId")); query->SetString("selector", selector);
      Command(s, "DOM.querySelector", query, [this, s, files](Dict found) {
        const int node_id = Number(found, "nodeId"); if (!node_id) { Finish(s, false, "", "The browser upload target was not found."); return; }
        auto params = CefDictionaryValue::Create(); params->SetInt("nodeId", node_id); params->SetInt("depth", 0);
        Command(s, "DOM.describeNode", params, [this, s, node_id, files](Dict result) {
          auto node = result->GetType("node") == VTYPE_DICTIONARY ? result->GetDictionary("node") : nullptr; const int backend = Number(node, "backendNodeId");
          if (String(node, "nodeName") != "INPUT" || !backend) { Finish(s, false, "", "The browser upload target is not a file input."); return; }
          DOM(s, [this, s, backend, node_id, files](Dict, std::shared_ptr<DOMMetadata> metadata) {
            auto info = metadata->nodes.find(backend);
            if (info == metadata->nodes.end() || info->second.blocked || info->second.sensitive) { Finish(s, false, "", "The browser upload target is private or stale."); return; }
            Resolve(s, backend, [this, s, backend, files](const std::string& object) { Inspect(s, object, "click", "", [this, s, backend, files](Dict) {
              auto set = CefDictionaryValue::Create(); set->SetInt("backendNodeId", backend); set->SetList("files", files);
              Input(s, "DOM.setFileInputFiles", set, [this, s] { Finish(s, true); });
            }); });
          });
        });
      });
    }); });
  }
  void Create(const std::string& request, List allowed) {
    if (!allowed || allowed->GetSize() < 1 || allowed->GetSize() > 20 || sessions.size() >= 8) { ReplyNow(request, false, "", "Isolated browsers require one to twenty origins and support at most eight sessions."); return; }
    auto s = std::make_shared<Session>();
    for (size_t i = 0; i < allowed->GetSize(); ++i) {
      const auto raw = allowed->GetType(i) == VTYPE_STRING ? allowed->GetString(i).ToString() : "";
      const auto origin = Origin(raw);
      if (origin.empty()) { ReplyNow(request, false, "", "The isolated browser origin allowlist is invalid."); return; }
      s->origins.insert(origin);
    }
    s->id = "native-browser-" + std::string([[[NSUUID UUID] UUIDString] UTF8String]);
    sessions[s->id] = s; Start(s, request, "create");
    auto policy = CefRefPtr<OriginPolicy>(new OriginPolicy(s->origins));
    std::weak_ptr<Impl> weak = weak_from_this(); std::weak_ptr<Session> weak_session = s;
    s->context_handler = new ContextHandler(policy, [weak, weak_session, policy](CefRefPtr<CefRequestContext> context) {
      auto self = weak.lock(); auto session = weak_session.lock(); if (!self || !session || !self->Current(session)) return;
      if (!context || !context->GetCachePath().empty() || context->IsSharingWith(CefRequestContext::GetGlobalContext())) { self->Finish(session, false, "", "Fresh isolated Chromium storage could not be verified."); self->Close(session); return; }
      for (const auto& [id, other] : self->sessions) if (other != session && other->context && context->IsSharingWith(other->context)) { self->Finish(session, false, "", "Separate browser session storage could not be verified."); self->Close(session); return; }
      session->context = context;
      session->client = new BackgroundClient(session->origins, policy);
      session->client->created = [weak, weak_session](CefRefPtr<CefBrowser> browser) {
        auto self = weak.lock(); auto session = weak_session.lock();
        if (!self || !session || session->closing || self->stopping) { browser->GetHost()->CloseBrowser(true); return; }
        session->browser = browser;
        if (!browser->GetHost()->IsWindowRenderingDisabled() || browser->GetHost()->GetRuntimeStyle() != CEF_RUNTIME_STYLE_ALLOY || browser->GetHost()->GetRequestContext()->IsSharingWith(CefRequestContext::GetGlobalContext())) { self->Finish(session, false, "", "The isolated browser did not use the required windowless private context."); self->Close(session); return; }
        auto observer = CefRefPtr<Observer>(new Observer([weak, weak_session](int id, bool ok, std::string json) {
          auto self = weak.lock(); auto session = weak_session.lock(); if (!self || !session || !self->Current(session)) return;
          auto found = session->commands.find(id); if (found == session->commands.end()) return;
          auto callback = std::move(found->second); session->commands.erase(found); callback(ok, json);
        }));
        session->registration = browser->GetHost()->AddDevToolsMessageObserver(observer);
        if (!session->registration) { self->Finish(session, false, "", "The isolated browser protocol observer could not be installed."); self->Close(session); return; }
        self->Finish(session, true, Literal(session->id));
      };
      session->client->closed = [weak, weak_session] { auto self = weak.lock(); auto session = weak_session.lock(); if (self && session) self->Closed(session); };
      session->client->navigating = [weak, weak_session] { auto self = weak.lock(); auto session = weak_session.lock(); if (self && session) self->NavigateStarted(session); };
      session->client->loaded = [weak, weak_session](bool ok) { auto self = weak.lock(); auto session = weak_session.lock(); if (self && session) self->LoadFinished(session, ok); };
      session->client->failed = [weak, weak_session](const std::string& error) { auto self = weak.lock(); auto session = weak_session.lock(); if (self && session && !session->request.empty()) self->Finish(session, false, "", error); };
      CefWindowInfo window;
      // Pinned CEF152 cef_mac.h explicitly selects Alloy for SetAsWindowless;
      // a null parent uses the main screen. No stock window or view is created.
      window.SetAsWindowless(kNullWindowHandle);
      CefBrowserSettings settings; settings.windowless_frame_rate = 30; settings.background_color = CefColorSetARGB(255, 255, 255, 255);
      if (!CefBrowserHost::CreateBrowser(window, session->client, "about:blank", settings, nullptr, context)) { self->Finish(session, false, "", "Chromium could not create the windowless isolated browser."); session->client = nullptr; self->Close(session); }
    });
    CefRequestContextSettings settings; settings.persist_session_cookies = false;
    s->context = CefRequestContext::CreateContext(settings, s->context_handler);
    if (!s->context) { Finish(s, false, "", "Chromium could not initialize an in-memory isolated context."); Close(s); }
  }
  void Request(const std::string& request, Dict input) {
    CEF_REQUIRE_UI_THREAD();
    if (requests.count(request) || closed_requests.count(request)) return; // Never answer or execute a replay twice.
    if (request.empty() || request.size() > 200) { if (reply) reply(request, false, "", "The isolated browser request identity is invalid."); return; }
    if (stopping || !input || !input->IsValid() || input->GetType("operation") != VTYPE_STRING || JSON(input).size() > kMaxWire) { ReplyNow(request, false, "", "The isolated browser request is invalid or unavailable."); return; }
    // The authenticated transport owns the original request dictionary. Take
    // our own bounded copy before any async browser/context callbacks exist.
    input = input->Copy(false);
    if (!input || !input->IsValid()) { ReplyNow(request, false, "", "The isolated browser request could not be retained."); return; }
    const auto operation = String(input, "operation");
    if (operation == "create") { Create(request, input->GetType("allowedOrigins") == VTYPE_LIST ? input->GetList("allowedOrigins") : nullptr); return; }
    auto found = sessions.find(String(input, "sessionId"));
    if (found == sessions.end() || found->second->closing) { ReplyNow(request, false, "", "The isolated browser session is unavailable."); return; }
    auto s = found->second;
    if (operation == "close") {
      if (!s->request.empty()) Finish(s, false, "", "The isolated browser session was closed.");
      ReplyNow(request, true); Close(s); return;
    }
    if (!s->request.empty() || !s->browser || !s->browser->IsValid()) { ReplyNow(request, false, "", "The isolated browser session is busy or is not ready."); return; }
    if (operation == "navigate") {
      const auto url = String(input, "url"); if (!Allowed(s->origins, url)) { ReplyNow(request, false, "", "Navigation is outside the isolated origin allowlist."); return; }
      Start(s, request, operation); s->refs.clear(); s->navigate_url = url; s->loaded = false; s->browser->GetMainFrame()->LoadURL(url); return;
    }
    if (operation == "diagnostics") {
      auto list = CefListValue::Create(); for (size_t i = 0; i < s->diagnostics.size(); ++i) { auto item = CefDictionaryValue::Create(); item->SetString("type", "error"); item->SetString("message", s->diagnostics[i]); list->SetDictionary(i, item); }
      auto root = CefValue::Create(); root->SetList(list); ReplyNow(request, true, JSON(root)); return;
    }
    if (operation == "downloads") { ReplyNow(request, true, "[]"); return; } // Downloads are denied by this background client.
    if (operation != "snapshot" && operation != "act" && operation != "screenshot" && operation != "viewport" && operation != "upload") { ReplyNow(request, false, "", "This operation is unavailable for isolated background sessions."); return; }
    Start(s, request, operation);
    if (operation == "snapshot") { Snapshot(s); return; }
    if (operation == "screenshot") { Screenshot(s); return; }
    if (operation == "viewport") {
      auto viewport = input->GetType("viewport") == VTYPE_DICTIONARY ? input->GetDictionary("viewport") : nullptr;
      const int width = Number(viewport, "width"), height = Number(viewport, "height"); const double scale = viewport && viewport->HasKey("deviceScaleFactor") ? Decimal(viewport, "deviceScaleFactor") : 1;
      if (width < 240 || width > 3840 || height < 240 || height > 2160 || !std::isfinite(scale) || scale < .5 || scale > 4 || width * scale > 4096 || height * scale > 4096 || width * height * scale * scale > 8000000) { Finish(s, false, "", "The isolated browser viewport exceeds bounds."); return; }
      auto params = CefDictionaryValue::Create(); params->SetInt("width", width); params->SetInt("height", height); params->SetDouble("deviceScaleFactor", scale); params->SetBool("mobile", width < 768);
      Command(s, "Emulation.setDeviceMetricsOverride", params, [this, s, width, height](Dict) { s->client->width = width; s->client->height = height; s->browser->GetHost()->WasResized(); s->refs.clear(); Finish(s, true); }); return;
    }
    if (operation == "upload") {
      const auto selector = String(input, "selector"); const auto paths = input->GetType("paths") == VTYPE_LIST ? input->GetList("paths")->Copy() : nullptr;
      if (selector.empty() || selector.size() > 2000 || selector.find('\0') != std::string::npos || !paths || paths->GetSize() < 1 || paths->GetSize() > 20) { Finish(s, false, "", "The approved browser upload request is invalid."); return; }
      s->refs.clear(); Upload(s, selector, paths); return;
    }
    // Retain independent underlying data, not a child handle whose owner
    // (input) is destroyed as soon as Request returns.
    auto action = input->GetType("action") == VTYPE_DICTIONARY ? input->GetDictionary("action")->Copy(false) : nullptr; const auto type = String(action, "type");
    auto refs = s->refs;
    if (!action || refs.empty() || s->refs_generation != s->generation || std::chrono::steady_clock::now() - s->refs_created > std::chrono::seconds(30)) { Finish(s, false, "", "A fresh isolated browser snapshot is required before acting."); return; }
    if (type == "type" && (action->GetType("text") != VTYPE_STRING || String(action, "text").size() > 20000) || type == "select" && (action->GetType("value") != VTYPE_STRING || String(action, "value").size() > 2000)) { Finish(s, false, "", "Browser input exceeded its bounded size."); return; }
    if (type == "scroll" && (!std::isfinite(Decimal(action, "x")) || !std::isfinite(Decimal(action, "y")) || std::abs(Decimal(action, "x")) > 100000 || std::abs(Decimal(action, "y")) > 100000)) { Finish(s, false, "", "Browser scrolling exceeded its bounds."); return; }
    if (type != "click" && type != "type" && type != "select" && type != "key" && type != "scroll") { Finish(s, false, "", "This browser action is unavailable."); return; }
    ElementRef ref;
    if (type == "click" || type == "type" || type == "select") {
      const auto target = refs.find(Ref(String(action, "target")));
      if (target == refs.end() || target->second.name == "Sensitive field") { Finish(s, false, "", "The browser target requires a fresh, non-sensitive element ref."); return; }
      ref = target->second;
    }
    s->refs.clear();
    Prepare(s, [this, s, action, type, ref, refs] { if (type == "key") Key(s, String(action, "key"), refs); else if (type == "scroll") Scroll(s, action); else ActTarget(s, ref, type, action); });
  }
  void Cancel(const std::string& request) {
    CEF_REQUIRE_UI_THREAD();
    for (const auto& [id, s] : sessions) if (s->request == request) { Finish(s, false, "", "The isolated browser request was cancelled. Its session is closing; do not replay the action."); Close(s); return; }
  }
  void Shutdown(std::function<void()> callback) {
    CEF_REQUIRE_UI_THREAD();
    // CloseBrowser can synchronously deliver OnBeforeClose. Its completion
    // callback may release the owning manager before this loop returns.
    // Retain this implementation for the entire shutdown stack, not only
    // while the completion callbacks themselves are running.
    auto keep_alive = shared_from_this();
    if (callback) shutdown_callbacks.push_back(std::move(callback));
    stopping = true; shutdown_hold = keep_alive;
    const auto copy = sessions;
    for (const auto& [id, s] : copy) { if (!s->request.empty()) Finish(s, false, "", "Kestrel is closing the isolated browser."); Close(s); }
    CheckShutdown();
  }
};

NativeIsolatedAutomation::NativeIsolatedAutomation(CefRefPtr<CefBrowser> owner, Reply reply)
    : impl_(std::make_shared<Impl>(std::move(reply))) { CEF_REQUIRE_UI_THREAD(); (void)owner; }
NativeIsolatedAutomation::~NativeIsolatedAutomation() { if (impl_) impl_->Shutdown({}); }
void NativeIsolatedAutomation::Request(const std::string& request, Dict value) { impl_->Request(request, value); }
void NativeIsolatedAutomation::Cancel(const std::string& request) { impl_->Cancel(request); }
void NativeIsolatedAutomation::Shutdown(std::function<void()> callback) { impl_->Shutdown(std::move(callback)); }
