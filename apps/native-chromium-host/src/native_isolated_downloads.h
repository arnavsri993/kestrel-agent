#ifndef KESTREL_NATIVE_ISOLATED_DOWNLOADS_H_
#define KESTREL_NATIVE_ISOLATED_DOWNLOADS_H_

#include <functional>
#include <memory>
#include <string>
#include "include/cef_download_handler.h"

// One handler per isolated OSR session. Construct, query and close on the CEF
// UI thread. The URL predicate must own its policy, not capture session state.
// Files are temporary implementation details, never renderer-selected paths.
// Close is idempotent and must run before the session/browser is torn down.
// Hashing runs on CEF's background file thread; Close cancels without joining.
class NativeIsolatedDownloads final : public CefDownloadHandler {
 public:
  explicit NativeIsolatedDownloads(
      std::function<bool(const std::string&)> allowed_url,
      // Reports a real download decision, including local quota refusals.
      std::function<void()> observed_download = {});
  bool CanDownload(CefRefPtr<CefBrowser> browser, const CefString& url,
                   const CefString& request_method) override;
  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefDownloadItem> download_item,
                        const CefString& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback) override;
  void OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefDownloadItem> download_item,
                         CefRefPtr<CefDownloadItemCallback> callback) override;
  // BrowserDownload[] JSON; contains no URL, local path or suggested filename.
  // Completed transfers remain progressing until asynchronous hash validation.
  std::string SnapshotJson();
  void Close();

 private:
  ~NativeIsolatedDownloads() override;
  struct Impl;
  std::shared_ptr<Impl> impl_;
  IMPLEMENT_REFCOUNTING(NativeIsolatedDownloads);
  DISALLOW_COPY_AND_ASSIGN(NativeIsolatedDownloads);
};

#endif  // KESTREL_NATIVE_ISOLATED_DOWNLOADS_H_
