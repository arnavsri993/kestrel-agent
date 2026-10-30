#include "native_isolated_downloads.h"

#include <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <map>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <utility>
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/cef_values.h"

namespace {
constexpr uint64_t kByteLimit = 100000000;
constexpr size_t kActiveLimit = 4;
constexpr size_t kHistoryLimit = 100;

class OwnedFd final {
 public:
  explicit OwnedFd(int descriptor = -1) : descriptor_(descriptor) {}
  ~OwnedFd() { Reset(); }
  OwnedFd(OwnedFd&& other) noexcept : descriptor_(other.descriptor_) {
    other.descriptor_ = -1;
  }
  OwnedFd(const OwnedFd&) = delete;
  OwnedFd& operator=(const OwnedFd&) = delete;
  int Get() const { return descriptor_; }
  bool Reset() noexcept {
    const bool okay = descriptor_ < 0 || close(descriptor_) == 0;
    descriptor_ = -1;
    return okay;
  }
 private:
  int descriptor_;
};

enum class HashPhase { kPending, kSuccess, kFailed };
struct HashResult {
  std::atomic<bool> cancelled{false};
  std::atomic<HashPhase> phase{HashPhase::kPending};
  uint64_t generation = 0;
  struct stat file_identity = {};
  // Written once on the worker and read only after a release/acquire phase
  // transition, or by its subsequently posted UI completion task.
  std::string sha256;
};

bool SameObject(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino;
}

bool SameFileVersion(const struct stat& initial, const struct stat& final) {
  return S_ISREG(final.st_mode) && SameObject(initial, final) &&
         final.st_nlink == 1 && final.st_size == initial.st_size &&
         final.st_mtimespec.tv_sec == initial.st_mtimespec.tv_sec &&
         final.st_mtimespec.tv_nsec == initial.st_mtimespec.tv_nsec &&
         final.st_ctimespec.tv_sec == initial.st_ctimespec.tv_sec &&
         final.st_ctimespec.tv_nsec == initial.st_ctimespec.tv_nsec;
}

std::string OpaqueId() {
  std::array<unsigned char, 16> random;
  arc4random_buf(random.data(), random.size());
  constexpr char hex[] = "0123456789abcdef";
  std::string result(32, '0');
  for (size_t i = 0; i < random.size(); ++i) {
    result[2 * i] = hex[random[i] >> 4];
    result[2 * i + 1] = hex[random[i] & 15];
  }
  return result;
}

std::string CreatedAt() {
  struct timeval now;
  struct tm utc;
  if (gettimeofday(&now, nullptr) != 0 || !gmtime_r(&now.tv_sec, &utc)) return "";
  char text[32];
  const size_t count = strftime(text, sizeof(text), "%Y-%m-%dT%H:%M:%S", &utc);
  if (!count) return "";
  std::snprintf(text + count, sizeof(text) - count, ".%03dZ",
                static_cast<int>(now.tv_usec / 1000));
  return text;
}
}  // namespace

struct NativeIsolatedDownloads::Impl : std::enable_shared_from_this<Impl> {
  struct Entry {
    std::string id, filename, created_at, directory_name, path, sha256;
    std::string status = "progressing";
    uint64_t bytes = 0;
    uint64_t announced_bytes = 0;
    bool continued = false;
    bool live = true;
    int directory_fd = -1;
    CefRefPtr<CefDownloadItemCallback> callback;
    std::shared_ptr<HashResult> hash_result;
  };

  Impl(std::function<bool(const std::string&)> policy, std::function<void()> observed)
      : allowed_url(std::move(policy)), observed_download(std::move(observed)) {
    char temporary[PATH_MAX] = {};
    const size_t count = confstr(_CS_DARWIN_USER_TEMP_DIR, temporary,
                                 sizeof(temporary));
    if (!count || count >= sizeof(temporary)) return;
    constexpr char suffix[] = "kestrel-background-downloads.XXXXXX";
    size_t length = std::strlen(temporary);
    if (!length || length + sizeof(suffix) + 1 > sizeof(temporary)) return;
    if (temporary[length - 1] != '/') temporary[length++] = '/';
    std::memcpy(temporary + length, suffix, sizeof(suffix));
    if (!mkdtemp(temporary)) return;
    root_fd = open(temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (root_fd < 0) { rmdir(temporary); return; }
    char canonical[PATH_MAX];
    struct stat state;
    if (fchmod(root_fd, 0700) != 0 || fstat(root_fd, &state) != 0 ||
        !S_ISDIR(state.st_mode) || state.st_uid != geteuid() ||
        !realpath(temporary, canonical)) {
      close(root_fd); root_fd = -1; rmdir(temporary); return;
    }
    try {
      root_path = canonical;
    } catch (...) {
      close(root_fd); root_fd = -1; rmdir(temporary);
    }
  }

  ~Impl() {
    // CEF does not throw from its callbacks, but destruction must remain safe
    // even if a future wrapper introduces an exception during cancellation.
    try { Stop(); } catch (...) {}
    for (auto& [unused, entry] : entries) {
      Cleanup(entry);
      if (entry.directory_fd >= 0) close(entry.directory_fd);
    }
    CleanupRoot();
    if (root_fd >= 0) close(root_fd);
  }

  std::function<bool(const std::string&)> allowed_url;
  std::function<void()> observed_download;
  std::map<uint32_t, Entry> entries;
  std::string root_path;
  int root_fd = -1;
  bool closed = false;
  uint64_t received_bytes = 0;
  uint64_t generation = 1;

  bool RootMatches() const {
    struct stat opened, named;
    return root_fd >= 0 && !root_path.empty() &&
           fstat(root_fd, &opened) == 0 && lstat(root_path.c_str(), &named) == 0 &&
           S_ISDIR(named.st_mode) && SameObject(opened, named) &&
           named.st_uid == geteuid() && (named.st_mode & 0777) == 0700;
  }

  bool DirectoryMatches(const Entry& entry) const {
    struct stat opened, named;
    return RootMatches() && entry.directory_fd >= 0 &&
           fstat(entry.directory_fd, &opened) == 0 &&
           fstatat(root_fd, entry.directory_name.c_str(), &named,
                   AT_SYMLINK_NOFOLLOW) == 0 &&
           S_ISDIR(named.st_mode) && SameObject(opened, named) &&
           named.st_uid == geteuid() && (named.st_mode & 0777) == 0700;
  }

  size_t Active() const {
    size_t active = 0;
    for (const auto& [unused, entry] : entries) if (entry.live) ++active;
    return active;
  }

  bool Allowed(const std::string& url) const {
    if (!allowed_url || url.empty() || url.size() > 8192) return false;
    CefURLParts parts;
    if (!CefParseURL(url, parts) || parts.username.length || parts.password.length ||
        !parts.host.length) return false;
    const std::string scheme = CefString(&parts.scheme).ToString();
    return (scheme == "http" || scheme == "https") && allowed_url(url);
  }

  bool Allowed(CefRefPtr<CefDownloadItem> item) const {
    const std::string original = item->GetOriginalUrl().ToString();
    return Allowed(item->GetURL().ToString()) &&
           (original.empty() || Allowed(original));
  }

  Entry* FindOrCreate(CefRefPtr<CefDownloadItem> item) {
    auto existing = entries.find(item->GetId());
    if (existing != entries.end()) return &existing->second;
    if (closed || !RootMatches() || entries.size() >= kHistoryLimit ||
        Active() >= kActiveLimit || received_bytes >= kByteLimit || !Allowed(item)) {
      return nullptr;
    }
    Entry entry;
    entry.id = OpaqueId();
    // Never copy a server-provided filename: even a sanitized basename can
    // contain credentials, private document names or a URL query value.
    entry.filename = "download-" + entry.id + ".bin";
    entry.directory_name = "item-" + entry.id;
    entry.created_at = CreatedAt();
    return &entries.emplace(item->GetId(), std::move(entry)).first->second;
  }

  uint64_t ReservedExcept(const Entry& current) const {
    uint64_t reserved = 0;
    for (const auto& [unused, entry] : entries) {
      if (&entry != &current && entry.live && entry.status == "progressing" &&
          entry.announced_bytes > entry.bytes) {
        reserved += entry.announced_bytes - entry.bytes;
      }
    }
    return reserved;
  }

  bool Account(Entry& entry, uint64_t bytes) {
    // Saturation also prevents malicious/invalid CEF counters overflowing the
    // cumulative accounting. Failed/cancelled bytes never refund the budget.
    bytes = std::min(bytes, kByteLimit + 1);
    if (bytes > entry.bytes) {
      received_bytes = std::min(kByteLimit + 1,
                               received_bytes + bytes - entry.bytes);
      entry.bytes = bytes;
    }
    return bytes <= kByteLimit && received_bytes <= kByteLimit;
  }

  bool WithinBudget(Entry& entry, CefRefPtr<CefDownloadItem> item) {
    // Known lengths are refused before Continue. Unknown lengths are enforced
    // at CEF progress callbacks; CEF offers no hard network-stream byte cap.
    const int64_t received = item->GetReceivedBytes();
    const int64_t total = item->GetTotalBytes();
    if (received < 0 || total < -1 || !Account(entry, static_cast<uint64_t>(received))) {
      return false;
    }
    if (total > static_cast<int64_t>(kByteLimit)) return false;
    entry.announced_bytes = std::max(entry.bytes,
        total > 0 ? static_cast<uint64_t>(total) : uint64_t{0});
    const uint64_t reserved = ReservedExcept(entry);
    return received_bytes <= kByteLimit && reserved <= kByteLimit - received_bytes &&
           entry.announced_bytes - entry.bytes <= kByteLimit - received_bytes - reserved;
  }

  bool Prepare(Entry& entry) {
    if (!RootMatches() || entry.directory_fd >= 0 ||
        mkdirat(root_fd, entry.directory_name.c_str(), 0700) != 0) return false;
    entry.directory_fd = openat(root_fd, entry.directory_name.c_str(),
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (entry.directory_fd < 0) {
      unlinkat(root_fd, entry.directory_name.c_str(), AT_REMOVEDIR);
      return false;
    }
    if (fchmod(entry.directory_fd, 0700) != 0 || !DirectoryMatches(entry)) return false;
    struct stat existing;
    // Every destination lives in an exclusively created private directory.
    // The renderer and suggested filename never participate in this path.
    if (fstatat(entry.directory_fd, entry.filename.c_str(), &existing,
                 AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;
    entry.path = root_path + "/" + entry.directory_name + "/" + entry.filename;
    return true;
  }

  void Cleanup(Entry& entry) noexcept {
    if (entry.directory_fd < 0) return;
    // Work only through the fd of our exclusively created directory. No path
    // traversal or recursive deletion, including when a writer is cancelling.
    const int duplicate = fcntl(entry.directory_fd, F_DUPFD_CLOEXEC, 0);
    DIR* directory = duplicate >= 0 ? fdopendir(duplicate) : nullptr;
    if (directory) {
      rewinddir(directory);
      while (struct dirent* child = readdir(directory)) {
        if (!std::strcmp(child->d_name, ".") || !std::strcmp(child->d_name, "..")) continue;
        struct stat state;
        if (fstatat(entry.directory_fd, child->d_name, &state,
                     AT_SYMLINK_NOFOLLOW) == 0 && !S_ISDIR(state.st_mode)) {
          // unlinkat removes a symlink itself; it never follows its target.
          unlinkat(entry.directory_fd, child->d_name, 0);
        }
      }
      closedir(directory);
    } else if (duplicate >= 0) close(duplicate);
    struct stat opened, named;
    if (root_fd >= 0 && fstat(entry.directory_fd, &opened) == 0 &&
        fstatat(root_fd, entry.directory_name.c_str(), &named,
                AT_SYMLINK_NOFOLLOW) == 0 && SameObject(opened, named)) {
      // Removing the directory prevents an in-flight cancelled writer from
      // later finalizing or recreating its destination by absolute path.
      unlinkat(root_fd, entry.directory_name.c_str(), AT_REMOVEDIR);
    }
  }

  void CleanupRoot() noexcept {
    if (RootMatches()) rmdir(root_path.c_str());
  }

  void Cancel(Entry& entry, const char* status,
              CefRefPtr<CefDownloadItemCallback> callback = nullptr) {
    if (entry.hash_result) {
      entry.hash_result->cancelled.store(true, std::memory_order_release);
      entry.hash_result.reset();
      entry.live = false;
    }
    if (entry.status == "progressing") entry.status = status;
    auto cancel = callback ? callback : entry.callback;
    entry.callback = nullptr;
    if (cancel) cancel->Cancel();
    Cleanup(entry);
  }

  void Stop() {
    if (!closed) ++generation;
    closed = true;
    for (auto& [unused, entry] : entries) {
      if (entry.status == "progressing") Cancel(entry, "cancelled");
      else { entry.callback = nullptr; Cleanup(entry); }
    }
    CleanupRoot();
  }

  void FinishHash(uint32_t id, const std::shared_ptr<HashResult>& result) {
    auto found = entries.find(id);
    if (found == entries.end()) return;
    auto& entry = found->second;
    if (entry.hash_result != result || result->generation != generation || closed ||
        result->cancelled.load(std::memory_order_acquire) ||
        entry.status != "progressing") return;
    const HashPhase phase = result->phase.load(std::memory_order_acquire);
    if (phase == HashPhase::kPending) return;
    // Only UI publishes a result, and only for this unchanged, live owner.
    struct stat named;
    const bool valid = phase == HashPhase::kSuccess && result->sha256.size() == 64 &&
                       DirectoryMatches(entry) &&
                       fstatat(entry.directory_fd, entry.filename.c_str(), &named,
                                AT_SYMLINK_NOFOLLOW) == 0 &&
                       SameFileVersion(result->file_identity, named);
    if (valid) entry.sha256 = result->sha256;
    entry.status = valid ? "completed" : "failed";
    entry.live = false;
    entry.hash_result.reset();
    if (!valid) Cleanup(entry);
  }

  void PollHashes() {
    for (auto& [id, entry] : entries) {
      // Delivery failure is also visible without another CEF download event.
      // Polling the public download list settles it as failed, never completed.
      const auto result = entry.hash_result;
      if (result) FinishHash(id, result);
    }
  }

  class HashCompletion final : public CefTask {
   public:
    HashCompletion(std::weak_ptr<Impl> owner, uint32_t id,
                   std::shared_ptr<HashResult> result, bool success)
        : owner_(std::move(owner)), id_(id), result_(std::move(result)),
          success_(success) {}
    void Execute() override {
      executed_ = true;
      result_->phase.store(success_ ? HashPhase::kSuccess : HashPhase::kFailed,
                           std::memory_order_release);
      try {
        if (auto owner = owner_.lock()) owner->FinishHash(id_, result_);
      } catch (...) {
        // SnapshotJson will finalize this failure if allocation failed here.
        result_->phase.store(HashPhase::kFailed, std::memory_order_release);
      }
    }
   private:
    ~HashCompletion() override {
      if (!executed_) result_->phase.store(HashPhase::kFailed, std::memory_order_release);
    }
    std::weak_ptr<Impl> owner_;
    uint32_t id_;
    std::shared_ptr<HashResult> result_;
    bool success_, executed_ = false;
    IMPLEMENT_REFCOUNTING(HashCompletion);
  };

  class HashTask final : public CefTask {
   public:
    HashTask(std::weak_ptr<Impl> owner, uint32_t id,
             std::shared_ptr<HashResult> result, OwnedFd file, OwnedFd directory,
             struct stat initial, struct stat directory_identity,
             std::string filename)
        : owner_(std::move(owner)), id_(id), result_(std::move(result)),
          file_(std::move(file)), directory_(std::move(directory)),
          initial_(initial), directory_identity_(directory_identity),
          filename_(std::move(filename)) {}
    void Execute() override {
      executed_ = true;
      try {
        bool success = Hash();
        if (!file_.Reset()) success = false;
        if (!directory_.Reset()) success = false;
        if (result_->cancelled.load(std::memory_order_acquire)) return;
        // No strong owner/browser/item reference crosses into this worker.
        // A rejected or dropped completion publishes only a failure flag.
        CefRefPtr<CefTask> completion = new HashCompletion(owner_, id_, result_, success);
        if (!CefPostTask(TID_UI, completion)) {
          result_->phase.store(HashPhase::kFailed, std::memory_order_release);
        }
      } catch (...) {
        file_.Reset();
        directory_.Reset();
        result_->phase.store(HashPhase::kFailed, std::memory_order_release);
      }
    }
   private:
    ~HashTask() override {
      if (!executed_) result_->phase.store(HashPhase::kFailed, std::memory_order_release);
    }
    bool Hash() {
      if (result_->cancelled.load(std::memory_order_acquire)) return false;
      CC_SHA256_CTX digest;
      if (CC_SHA256_Init(&digest) != 1) return false;
      std::array<unsigned char, 64 * 1024> buffer;
      uint64_t read_bytes = 0;
      while (!result_->cancelled.load(std::memory_order_acquire)) {
        const ssize_t count = read(file_.Get(), buffer.data(), buffer.size());
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return false;
        if (!count) break;
        read_bytes += static_cast<uint64_t>(count);
        if (read_bytes > kByteLimit || read_bytes > static_cast<uint64_t>(initial_.st_size) ||
            CC_SHA256_Update(&digest, buffer.data(), static_cast<CC_LONG>(count)) != 1) {
          return false;
        }
      }
      if (result_->cancelled.load(std::memory_order_acquire)) return false;
      struct stat final, named, directory;
      const bool valid = read_bytes == static_cast<uint64_t>(initial_.st_size) &&
          fstat(file_.Get(), &final) == 0 &&
          fstat(directory_.Get(), &directory) == 0 &&
          SameObject(directory_identity_, directory) &&
          fstatat(directory_.Get(), filename_.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
          SameFileVersion(initial_, final) && SameFileVersion(initial_, named);
      unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
      if (!valid || CC_SHA256_Final(bytes, &digest) != 1) return false;
      constexpr char hex[] = "0123456789abcdef";
      result_->sha256.assign(CC_SHA256_DIGEST_LENGTH * 2, '0');
      for (size_t index = 0; index < sizeof(bytes); ++index) {
        result_->sha256[2 * index] = hex[bytes[index] >> 4];
        result_->sha256[2 * index + 1] = hex[bytes[index] & 15];
      }
      return true;
    }
    std::weak_ptr<Impl> owner_;
    uint32_t id_;
    std::shared_ptr<HashResult> result_;
    OwnedFd file_, directory_;
    struct stat initial_, directory_identity_;
    std::string filename_;
    bool executed_ = false;
    IMPLEMENT_REFCOUNTING(HashTask);
  };

  bool StartHash(uint32_t id, Entry& entry, const std::string& full_path) {
    if (!DirectoryMatches(entry) || full_path != entry.path || entry.hash_result) return false;
    OwnedFd file(openat(entry.directory_fd, entry.filename.c_str(),
                        O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
    OwnedFd directory(fcntl(entry.directory_fd, F_DUPFD_CLOEXEC, 0));
    struct stat initial, directory_identity;
    if (file.Get() < 0 || directory.Get() < 0 ||
        fstat(file.Get(), &initial) != 0 || !S_ISREG(initial.st_mode) ||
        initial.st_nlink != 1 || initial.st_uid != geteuid() || initial.st_size < 0 ||
        initial.st_size > static_cast<off_t>(kByteLimit) ||
        static_cast<uint64_t>(initial.st_size) != entry.bytes ||
        !Account(entry, static_cast<uint64_t>(initial.st_size)) ||
        fstat(directory.Get(), &directory_identity) != 0) return false;
    auto result = std::make_shared<HashResult>();
    result->generation = generation;
    result->file_identity = initial;
    entry.hash_result = result;
    entry.live = true;  // Hash workers share the four-active-download bound.
    CefRefPtr<CefTask> task = new HashTask(weak_from_this(), id, result,
        std::move(file), std::move(directory), initial, directory_identity, entry.filename);
    if (!CefPostTask(TID_FILE_BACKGROUND, task)) {
      result->phase.store(HashPhase::kFailed, std::memory_order_release);
      FinishHash(id, result);
      return false;
    }
    return true;
  }
};

NativeIsolatedDownloads::NativeIsolatedDownloads(
    std::function<bool(const std::string&)> allowed_url, std::function<void()> observed_download)
    : impl_(std::make_shared<Impl>(std::move(allowed_url), std::move(observed_download))) {}

NativeIsolatedDownloads::~NativeIsolatedDownloads() = default;

bool NativeIsolatedDownloads::CanDownload(CefRefPtr<CefBrowser>, const CefString& url,
                                          const CefString& request_method) {
  try {
    const std::string method = request_method.ToString();
    if (!CefCurrentlyOn(TID_UI) || impl_->closed ||
        (method != "GET" && method != "POST") || !impl_->Allowed(url.ToString())) return false;
    // Even a refused download replaces document navigation. This is an
    // observation of a download decision, never a claim that it was accepted.
    if (impl_->observed_download) impl_->observed_download();
    impl_->PollHashes();
    return !impl_->closed && impl_->RootMatches() &&
           impl_->entries.size() < kHistoryLimit && impl_->Active() < kActiveLimit &&
           impl_->received_bytes < kByteLimit;
  } catch (...) { return false; }
}

bool NativeIsolatedDownloads::OnBeforeDownload(
    CefRefPtr<CefBrowser>, CefRefPtr<CefDownloadItem> item,
    const CefString&, CefRefPtr<CefBeforeDownloadCallback> callback) {
  try {
    if (!CefCurrentlyOn(TID_UI) || !item || !item->IsValid() || !callback) return true;
    if (!impl_->closed && impl_->Allowed(item) && impl_->observed_download) {
      impl_->observed_download();
    }
    impl_->PollHashes();
    Impl::Entry* entry = impl_->FindOrCreate(item);
    if (!entry) return true;
    if (entry->continued || entry->status != "progressing" || impl_->closed ||
        !impl_->Allowed(item) || !impl_->WithinBudget(*entry, item) ||
        !impl_->Prepare(*entry)) {
      impl_->Cancel(*entry, "failed");
      if (!entry->continued) entry->live = false;
      return true;
    }
    entry->continued = true;
    callback->Continue(entry->path, false);
  } catch (...) {
    // Returning true suppresses default handling (including Chrome's shelf).
    // Dropping the uncontinued callback cancels rather than opening a dialog.
    try { Close(); } catch (...) {}
  }
  return true;
}

void NativeIsolatedDownloads::OnDownloadUpdated(
    CefRefPtr<CefBrowser>, CefRefPtr<CefDownloadItem> item,
    CefRefPtr<CefDownloadItemCallback> callback) {
  try {
    if (!CefCurrentlyOn(TID_UI) || !item || !item->IsValid()) {
      if (callback) callback->Cancel();
      return;
    }
    impl_->PollHashes();
    Impl::Entry* entry = impl_->FindOrCreate(item);
    if (!entry) { if (callback) callback->Cancel(); return; }
    const bool terminal = item->IsComplete() || item->IsCanceled() || item->IsInterrupted();
    entry->live = !terminal || static_cast<bool>(entry->hash_result);
    entry->callback = terminal ? nullptr : callback;
    if (impl_->closed || entry->status != "progressing") {
      // Repeated completion events must not remove the session's retained
      // successful artifact. Close remains responsible for its cleanup.
      if (!impl_->closed && entry->status == "completed") return;
      impl_->Cancel(*entry, "cancelled", callback);
      if (impl_->closed) impl_->CleanupRoot();
      return;
    }
    if (!impl_->Allowed(item) || !impl_->WithinBudget(*entry, item)) {
      impl_->Cancel(*entry, "failed", callback);
      return;
    }
    if (item->IsCanceled()) { impl_->Cancel(*entry, "cancelled", callback); return; }
    if (item->IsInterrupted()) { impl_->Cancel(*entry, "failed", callback); return; }
    if (item->IsComplete()) {
      if (entry->hash_result) return;
      // A CEF completion event alone is insufficient: only report success for
      // the exact regular file whose complete, bounded bytes were hashed.
      entry->callback = nullptr;
      if (!entry->continued ||
          !impl_->StartHash(item->GetId(), *entry, item->GetFullPath().ToString())) {
        impl_->Cancel(*entry, "failed");
        entry->live = false;
      }
    }
  } catch (...) {
    if (callback) callback->Cancel();
    try { Close(); } catch (...) {}
  }
}

std::string NativeIsolatedDownloads::SnapshotJson() {
  try {
    if (!CefCurrentlyOn(TID_UI)) return "[]";
    impl_->PollHashes();
    auto list = CefListValue::Create();
    size_t index = 0;
    for (const auto& [unused, entry] : impl_->entries) {
      auto value = CefDictionaryValue::Create();
      value->SetString("id", entry.id);
      value->SetString("filename", entry.filename);
      value->SetDouble("bytes", static_cast<double>(entry.bytes));
      value->SetString("status", entry.status);
      if (entry.status == "completed") value->SetString("sha256", entry.sha256);
      value->SetString("createdAt", entry.created_at);
      list->SetDictionary(index++, value);
    }
    auto root = CefValue::Create();
    root->SetList(list);
    return CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
  } catch (...) { return "[]"; }
}

void NativeIsolatedDownloads::Close() {
  // The owner calls Close on UI before closing its browser. The destructor
  // repeats fd-only cleanup in case terminal callbacks raced cancellation.
  if (!CefCurrentlyOn(TID_UI)) return;
  try { impl_->Stop(); } catch (...) {}
}
