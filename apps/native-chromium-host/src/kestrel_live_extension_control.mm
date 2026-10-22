#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <limits.h>
#include <set>
#include <chrono>
#include <cstdio>
#include "include/cef_parser.h"
#include "include/cef_request_context.h"
#include "kestrel_live_extension_control.h"

namespace {
constexpr char kFailure[] = "Native Chromium extension control failed.";
bool ValidId(const std::string& id) {
  return id.size() == 32 && id.find_first_not_of("abcdefghijklmnop") == std::string::npos;
}
std::string Quote(const std::string& value) {
  auto root = CefValue::Create(); root->SetString(value);
  return CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
}
std::string PathId(const std::string& path) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(path.data(), static_cast<CC_LONG>(path.size()), hash);
  std::string id;
  for (int i = 0; i < 16; ++i) {
    id += static_cast<char>('a' + (hash[i] >> 4));
    id += static_cast<char>('a' + (hash[i] & 15));
  }
  return id;
}
}

struct KestrelLiveExtensionControl::Operation {
  std::string operation;
  std::string id;
  std::string path;
  Callback callback;
  std::chrono::steady_clock::time_point deadline;
  bool mutation_issued = false;
  bool done = false;
};

KestrelLiveExtensionControl::KestrelLiveExtensionControl(
    std::shared_ptr<KestrelPrivateChromePipe> pipe, std::string profile_root,
    std::function<void()> fatal_callback)
    : pipe_(std::move(pipe)), profile_root_(std::move(profile_root)),
      fatal_callback_(std::move(fatal_callback)) {}

bool KestrelLiveExtensionControl::Current(const std::shared_ptr<Operation>& operation) {
  if (stopped_ || !operation || operation->done || active_ != operation) return false;
  if (std::chrono::steady_clock::now() >= operation->deadline) {
    Expire(operation);
    return false;
  }
  return true;
}

void KestrelLiveExtensionControl::Finish(const std::shared_ptr<Operation>& operation,
    CefRefPtr<CefDictionaryValue> result, const std::string& error) {
  if (operation->done) return;
  fprintf(stderr, "Kestrel extension control: %s %s.\n", operation->operation.c_str(), error.empty() ? "confirmed" : "failed");
  operation->done = true;
  auto callback = std::move(operation->callback);
  if (active_ == operation) active_.reset();
  if (callback) callback(result, error);
  StartNext();
}

void KestrelLiveExtensionControl::Expire(const std::shared_ptr<Operation>& operation) {
  if (stopped_ || operation->done) return;
  fprintf(stderr, "Kestrel extension control: operation deadline exceeded.\n");
  if (active_ == operation && operation->mutation_issued) {
    Stop(true);
    return;
  }
  Finish(operation, nullptr, kFailure);
}

void KestrelLiveExtensionControl::Stop(bool fatal) {
  if (stopped_) return;
  stopped_ = true;
  auto active = std::move(active_);
  auto queued = std::move(queued_);
  control_target_.clear();
  control_session_.clear();
  pipe_.reset();
  auto fatal_callback = std::move(fatal_callback_);
  // Invalidate every token before invoking any callback, which can reenter us.
  if (active) active->done = true;
  for (auto& operation : queued) operation->done = true;
  if (fatal && fatal_callback) fatal_callback();
  if (active) {
    auto callback = std::move(active->callback);
    if (callback) callback(nullptr, kFailure);
  }
  for (auto& operation : queued) {
    auto callback = std::move(operation->callback);
    if (callback) callback(nullptr, kFailure);
  }
}

void KestrelLiveExtensionControl::Shutdown() { Stop(false); }

void KestrelLiveExtensionControl::Retry(std::function<void()> callback) {
  const auto operation = active_;
  if (!Current(operation)) return;
  std::weak_ptr<KestrelLiveExtensionControl> weak = shared_from_this();
  std::weak_ptr<Operation> token = operation;
  // This block retains only C++ state, never a CefRefPtr. Shutdown invalidates
  // its token before CEF objects and the UI thread are torn down.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
      dispatch_get_main_queue(), ^{
        auto self = weak.lock(); auto operation = token.lock();
        if (self && self->Current(operation)) callback();
      });
}

void KestrelLiveExtensionControl::Request(const std::string& method,
    CefRefPtr<CefDictionaryValue> params, const std::string& session,
    Callback callback, bool mutation) {
  const auto operation = active_;
  if (!Current(operation)) return;
  if (mutation) operation->mutation_issued = true;
  std::weak_ptr<KestrelLiveExtensionControl> weak = shared_from_this();
  std::weak_ptr<Operation> token = operation;
  pipe_->Request(method, params, session,
      [weak, token, method, callback = std::move(callback)](auto result, const std::string& error) {
        auto self = weak.lock(); auto operation = token.lock();
        if (!self || !self->Current(operation)) return;
        if (!error.empty()) {
          fprintf(stderr, "Kestrel extension control: %s: %s\n", method.c_str(), error.c_str());
          // A protocol error is a definitive response. Transport failures can
          // leave an already-issued mutator executing after Node rolls back.
          if (operation->mutation_issued && !error.starts_with("Chrome protocol error: ")) {
            self->Stop(true);
            return;
          }
        }
        callback(result, error);
      });
}

void KestrelLiveExtensionControl::Evaluate(const std::string& expression,
                                           Callback callback, bool mutation) {
  auto params = CefDictionaryValue::Create();
  params->SetString("expression", expression);
  params->SetBool("awaitPromise", true); params->SetBool("returnByValue", true);
  std::weak_ptr<KestrelLiveExtensionControl> weak = shared_from_this();
  Request("Runtime.evaluate", params, control_session_,
      [weak, callback, mutation](auto result, const std::string& error) {
        if (!error.empty() || !result || result->HasKey("exceptionDetails") ||
            result->GetType("result") != VTYPE_DICTIONARY) {
          fprintf(stderr, "Kestrel extension control: evaluation failed (%s).\n",
              !error.empty() ? "transport/protocol" : "exception or invalid result");
          if (mutation && error.empty()) {
            if (auto self = weak.lock()) self->Stop(true);
            return;
          }
          callback(nullptr, kFailure); return;
        }
        auto remote = result->GetDictionary("result");
        auto value = remote->GetValue("value");
        if (!value || value->GetType() != VTYPE_DICTIONARY) {
          fprintf(stderr, "Kestrel extension control: evaluation returned invalid value.\n");
          if (mutation) {
            if (auto self = weak.lock()) self->Stop(true);
            return;
          }
          callback(nullptr, kFailure); return;
        }
        callback(value->GetDictionary()->Copy(false), "");
      }, mutation);
}

void KestrelLiveExtensionControl::EnsureControl(Callback callback, int attempts) {
  auto self = shared_from_this();
  if (!control_session_.empty()) {
    Evaluate("({ready:location.href==='chrome://extensions/'&&!!chrome.developerPrivate&&!!chrome.management})",
        [self, callback, attempts](auto value, const std::string& error) {
          if (error.empty() && value && value->GetBool("ready")) {
            callback(CefDictionaryValue::Create(), ""); return;
          }
          if (attempts >= 30) { callback(nullptr, kFailure); return; }
          self->Retry([self, callback, attempts] { self->EnsureControl(callback, attempts + 1); });
        });
    return;
  }
  auto attach_control = [self, callback] {
    auto attach = CefDictionaryValue::Create();
    attach->SetString("targetId", self->control_target_); attach->SetBool("flatten", true);
    self->Request("Target.attachToTarget", attach, "",
        [self, callback](auto attached, const std::string& attach_error) {
          if (!attach_error.empty() || !attached || attached->GetType("sessionId") != VTYPE_STRING) {
            callback(nullptr, kFailure); return;
          }
          self->control_session_ = attached->GetString("sessionId").ToString();
          self->EnsureControl(callback);
        });
  };
  if (!control_target_.empty()) { attach_control(); return; }
  auto params = CefDictionaryValue::Create();
  params->SetString("url", "chrome://extensions/");
  params->SetBool("background", true); params->SetBool("hidden", true);
  Request("Target.createTarget", params, "",
      [self, callback, attach_control](auto result, const std::string& error) {
        if (!error.empty() || !result || result->GetType("targetId") != VTYPE_STRING) {
          callback(nullptr, kFailure); return;
        }
        self->control_target_ = result->GetString("targetId").ToString();
        attach_control();
      }, true);
}

bool KestrelLiveExtensionControl::DenyFileAccessBeforeLoad(
    const std::string& id, const std::string& path) {
  // Chromium's unpacked loader consults the path-derived ID before parsing a
  // manifest key. Seed both IDs through the public profile preference API so
  // there is no interval in which a reviewed extension gains file access.
  auto context = CefRequestContext::GetGlobalContext();
  if (!context) {
    fprintf(stderr, "Kestrel extension control: file-access preseed has no global context.\n");
    return false;
  }
  if (!context->CanSetPreference("extensions.settings")) {
    fprintf(stderr, "Kestrel extension control: file-access preseed CanSetPreference failed.\n");
    return false;
  }
  auto previous = context->GetPreference("extensions.settings");
  if (!previous || previous->GetType() != VTYPE_DICTIONARY) {
    fprintf(stderr, "Kestrel extension control: file-access preseed preference is missing or not a dictionary.\n");
    return false;
  }
  auto settings = previous->GetDictionary()->Copy(false);
  for (const auto& key : std::set<std::string>{id, PathId(path)}) {
    auto extension = settings->GetType(key) == VTYPE_DICTIONARY
        ? settings->GetDictionary(key)->Copy(false) : CefDictionaryValue::Create();
    extension->SetBool("newAllowFileAccess", false);
    settings->SetDictionary(key, extension);
  }
  auto value = CefValue::Create(); value->SetDictionary(settings);
  CefString error;
  const bool success = context->SetPreference("extensions.settings", value, error);
  if (!success) fprintf(stderr, "Kestrel extension control: file-access preseed SetPreference failed: %s\n",
      error.ToString().c_str());
  return success;
}

void KestrelLiveExtensionControl::Get(const std::string& id, Callback callback) {
  auto self = shared_from_this();
  Request("Extensions.getExtensions", CefDictionaryValue::Create(), "",
      [self, id, callback](auto result, const std::string& error) {
        if (!error.empty() || !result || result->GetType("extensions") != VTYPE_LIST) {
          callback(nullptr, kFailure); return;
        }
        auto extensions = result->GetList("extensions");
        CefRefPtr<CefDictionaryValue> registered;
        std::set<std::string> ids;
        for (size_t index = 0; index < extensions->GetSize(); ++index) {
          if (extensions->GetType(index) != VTYPE_DICTIONARY) { callback(nullptr, kFailure); return; }
          auto extension = extensions->GetDictionary(index);
          if (extension->GetType("id") != VTYPE_STRING ||
              !ValidId(extension->GetString("id").ToString()) ||
              !ids.insert(extension->GetString("id").ToString()).second) {
            callback(nullptr, kFailure); return;
          }
          if (extension->GetString("id").ToString() == id) registered = extension;
        }
        if (!registered) {
          auto absent = CefDictionaryValue::Create(); absent->SetBool("absent", true);
          callback(absent, ""); return;
        }
        if (registered->GetType("path") != VTYPE_STRING ||
            registered->GetType("version") != VTYPE_STRING ||
            registered->GetType("enabled") != VTYPE_BOOL ||
            registered->GetString("path").ToString() != self->profile_root_ + "/browser-extensions/" + id ||
            registered->GetString("version").empty()) {
          fprintf(stderr, "Kestrel extension control: registration metadata is invalid.\n");
          callback(nullptr, kFailure); return;
        }
        // Carry plain C++ metadata across the asynchronous evaluation. No CEF
        // child value may outlive its owning CDP response or CEF shutdown.
        const std::string path = registered->GetString("path").ToString();
        const std::string version = registered->GetString("version").ToString();
        const bool enabled = registered->GetBool("enabled");
        self->Evaluate("(async()=>{const e=await chrome.developerPrivate.getExtensionInfo(" + Quote(id) +
            ");if(!e||typeof e.fileAccess?.isActive!=='boolean')throw Error('Missing file-access metadata');"
            "return {id:e.id,name:e.name,version:e.version,path:e.path,state:e.state,fileAccess:e.fileAccess.isActive}})()",
            [id, path, version, enabled, callback](auto info, const std::string& info_error) {
              if (!info_error.empty() || !info || info->GetType("id") != VTYPE_STRING ||
                  info->GetType("name") != VTYPE_STRING || info->GetType("path") != VTYPE_STRING ||
                  info->GetType("version") != VTYPE_STRING || info->GetType("state") != VTYPE_STRING ||
                  info->GetType("fileAccess") != VTYPE_BOOL || info->GetString("id").ToString() != id ||
                  info->GetString("path").ToString() != path || info->GetString("version").ToString() != version ||
                  info->GetString("state").ToString() != (enabled ? "ENABLED" : "DISABLED")) {
                fprintf(stderr, "Kestrel extension control: WebUI metadata did not match private registration.\n");
                callback(nullptr, kFailure); return;
              }
              info->Remove("state");
              info->SetBool("enabled", enabled);
              info->SetString("ready", enabled ? "passed" : "not_checked");
              callback(info, "");
            });
      });
}

void KestrelLiveExtensionControl::Load(const std::string& id, const std::string& path,
                                      Callback callback) {
  if (!Current(active_)) return;
  if (!DenyFileAccessBeforeLoad(id, path)) { callback(nullptr, kFailure); return; }
  auto self = shared_from_this();
  auto params = CefDictionaryValue::Create(); params->SetString("path", path);
  Request("Extensions.loadUnpacked", params, "",
      [self, id, path, callback](auto result, const std::string& error) {
        if (!error.empty()) {
          fprintf(stderr, "Kestrel extension control: load response failed.\n");
          callback(nullptr, kFailure); return;
        }
        if (!result || result->GetType("id") != VTYPE_STRING || result->GetString("id").ToString() != id) {
          fprintf(stderr, "Kestrel extension control: load outcome has unknown or unexpected identity.\n");
          self->Stop(true); return;
        }
        self->Evaluate("(async()=>{await chrome.management.setEnabled(" + Quote(id) +
            ",true);return {ok:true}})()",
            [self, id, path, callback](auto value, const std::string& enable_error) {
              if (!enable_error.empty()) { callback(nullptr, kFailure); return; }
              self->Get(id, [id, path, callback](auto info, const std::string& get_error) {
                if (!get_error.empty() || !info || !info->GetBool("enabled") ||
                    info->GetBool("fileAccess") || info->GetString("path").ToString() != path ||
                    info->GetString("id").ToString() != id) {
                  fprintf(stderr, "Kestrel extension control: loaded extension metadata did not match required ID/path/enabled/file-access state.\n");
                  callback(nullptr, kFailure); return;
                }
                callback(info, "");
              });
            }, true);
      }, true);
}

void KestrelLiveExtensionControl::Worker(const std::string& id, Callback callback,
                                        int attempts) {
  auto self = shared_from_this();
  Request("Target.getTargets", CefDictionaryValue::Create(), "",
      [self, id, callback, attempts](auto result, const std::string& error) {
        if (!error.empty() || !result) { callback(nullptr, kFailure); return; }
        auto targets = result->GetList("targetInfos");
        if (targets) for (size_t i = 0; i < targets->GetSize(); ++i) {
          auto target = targets->GetDictionary(i);
          if (!target || target->GetString("type") != "service_worker" ||
              !target->GetString("url").ToString().starts_with("chrome-extension://" + id + "/")) continue;
          auto params = CefDictionaryValue::Create();
          params->SetString("targetId", target->GetString("targetId")); params->SetBool("flatten", true);
          self->Request("Target.attachToTarget", params, "",
              [self, id, attempts, callback](auto attached, const std::string& attach_error) {
                if (!attach_error.empty() || !attached) { callback(nullptr, kFailure); return; }
                const std::string session = attached->GetString("sessionId").ToString();
                auto eval = CefDictionaryValue::Create();
                eval->SetString("expression", "globalThis.chrome?.runtime?.id"); eval->SetBool("returnByValue", true);
                self->Request("Runtime.evaluate", eval, session,
                    [self, id, attempts, session, callback](auto evaluated, const std::string& eval_error) {
                      auto remote = evaluated ? evaluated->GetDictionary("result") : nullptr;
                      const bool passed = eval_error.empty() && remote &&
                          remote->GetString("value").ToString() == id;
                      if (!passed) fprintf(stderr,
                          "Kestrel extension control: worker identity not ready (type=%s exception=%d).\n",
                          remote ? remote->GetString("type").ToString().c_str() : "missing",
                          evaluated && evaluated->HasKey("exceptionDetails"));
                      auto detach = CefDictionaryValue::Create(); detach->SetString("sessionId", session);
                      self->Request("Target.detachFromTarget", detach, "",
                          [self, id, attempts, passed, callback](auto, const std::string& detach_error) {
                            if (!detach_error.empty()) { callback(nullptr, kFailure); return; }
                            if (passed) { callback(CefDictionaryValue::Create(), ""); return; }
                            if (attempts >= 50) { callback(nullptr, kFailure); return; }
                            self->Retry([self, id, callback, attempts] { self->Worker(id, callback, attempts + 1); });
                          });
                    });
              });
          return;
        }
        if (attempts >= 50) { callback(nullptr, kFailure); return; }
        self->Retry([self, id, callback, attempts] { self->Worker(id, callback, attempts + 1); });
      });
}

void KestrelLiveExtensionControl::Handle(CefRefPtr<CefDictionaryValue> request,
                                        Callback callback) {
  if (stopped_ || !request || queued_.size() >= 64) { callback(nullptr, kFailure); return; }
  const std::string operation = request->GetString("operation").ToString();
  const std::string id = request->GetString("id").ToString();
  if (!ValidId(id) || (operation != "load" && operation != "get" && operation != "disable" &&
      operation != "uninstall" && operation != "start-worker")) { callback(nullptr, kFailure); return; }
  std::string path;
  if (operation == "load") {
    path = request->GetString("path").ToString();
    char actual[PATH_MAX]{};
    const std::string expected = profile_root_ + "/browser-extensions/" + id;
    if (path != expected || !realpath(path.c_str(), actual) || path != actual ||
        request->GetType("allowFileAccess") != VTYPE_BOOL || request->GetBool("allowFileAccess")) {
      callback(nullptr, kFailure); return;
    }
  }
  auto pending = std::make_shared<Operation>();
  pending->operation = operation; pending->id = id; pending->path = path;
  pending->callback = std::move(callback);
  // The manager's worker-start deadline is ten seconds. Stop native work
  // before that deadline can trigger rollback against a still-running call.
  const int deadline_seconds = operation == "start-worker" ? 8 : 20;
  pending->deadline = std::chrono::steady_clock::now() + std::chrono::seconds(deadline_seconds);
  queued_.push_back(pending);
  std::weak_ptr<KestrelLiveExtensionControl> weak = shared_from_this();
  std::weak_ptr<Operation> token = pending;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, deadline_seconds * NSEC_PER_SEC),
      dispatch_get_main_queue(), ^{
        auto self = weak.lock(); auto operation = token.lock();
        if (self && operation) self->Expire(operation);
      });
  StartNext();
}

void KestrelLiveExtensionControl::StartNext() {
  if (stopped_ || active_) return;
  while (!queued_.empty() && queued_.front()->done) queued_.pop_front();
  if (queued_.empty()) return;
  active_ = std::move(queued_.front()); queued_.pop_front();
  auto pending = active_;
  if (!Current(pending)) return;
  const std::string operation = pending->operation;
  const std::string id = pending->id;
  const std::string path = pending->path;
  fprintf(stderr, "Kestrel extension control: %s started.\n", operation.c_str());
  auto self = shared_from_this();
  Callback callback = [self, pending](auto result, const std::string& error) {
    if (self->Current(pending)) self->Finish(pending, result, error);
  };
  EnsureControl([self, operation, id, path, callback](auto, const std::string& error) {
    if (!error.empty()) { callback(nullptr, kFailure); return; }
    if (operation == "load") { self->Load(id, path, callback); return; }
    if (operation == "get") { self->Get(id, callback); return; }
    if (operation == "disable" || operation == "uninstall") {
      self->Get(id, [self, operation, id, callback](auto info, const std::string& error) {
        if (!error.empty() || !info) { callback(nullptr, kFailure); return; }
        // Package records can outlive Chromium's in-memory registration after
        // restart. Removing or disabling an absent registration is complete.
        if (info->GetBool("absent")) { callback(CefDictionaryValue::Create(), ""); return; }
        if (operation == "uninstall") {
          auto params = CefDictionaryValue::Create(); params->SetString("id", id);
          self->Request("Extensions.uninstall", params, "", callback, true); return;
        }
        self->Evaluate("(async()=>{await chrome.management.setEnabled(" + Quote(id) +
            ",false);return {ok:true}})()", [self, id, callback](auto, const std::string& disable_error) {
              if (!disable_error.empty()) { callback(nullptr, kFailure); return; }
              self->Get(id, [callback](auto info, const std::string& get_error) {
                if (!get_error.empty() || !info || info->GetBool("enabled")) callback(nullptr, kFailure);
                else callback(CefDictionaryValue::Create(), "");
              });
            }, true);
      });
      return;
    }
    self->Request("ServiceWorker.enable", CefDictionaryValue::Create(), self->control_session_,
        [self, id, callback](auto, const std::string& enable_error) {
          if (!enable_error.empty()) { callback(nullptr, kFailure); return; }
          auto params = CefDictionaryValue::Create();
          params->SetString("scopeURL", "chrome-extension://" + id + "/");
          self->Request("ServiceWorker.startWorker", params, self->control_session_,
              [self, id, callback](auto, const std::string& error) {
                if (!error.empty()) { callback(nullptr, kFailure); return; }
                self->Worker(id, callback);
              }, true);
        });
  });
}
