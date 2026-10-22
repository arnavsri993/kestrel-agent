#ifndef KESTREL_CHROME_WINDOW_MAC_H_
#define KESTREL_CHROME_WINDOW_MAC_H_

#include <functional>
#include <memory>
#include <string>

#include "include/cef_browser.h"

// Experimental macOS container for a non-Views Chrome browser window. All
// methods, including destruction, must run on the browser process UI thread.
// The caller owns browser shutdown and supplies an isolated Alloy shell context.
// Chrome retains its original NSWindow and NSWindowDelegate throughout.
class KestrelChromeWindowContainer final {
 public:
  static std::unique_ptr<KestrelChromeWindowContainer> Create(
      CefRefPtr<CefBrowser> owner,
      std::function<void()> on_window_closing,
      std::string* error);

  ~KestrelChromeWindowContainer();
  KestrelChromeWindowContainer(const KestrelChromeWindowContainer&) = delete;
  KestrelChromeWindowContainer& operator=(
      const KestrelChromeWindowContainer&) = delete;

  CefWindowHandle ShellParentHandle() const;
  CefRect ShellBounds() const;
  void SetShellBrowser(CefRefPtr<CefBrowser> shell);

  // Bounds use top-left-origin CSS DIPs in the full shell viewport. Chrome's
  // native controls and active tab are both laid out inside this rectangle.
  // The Chrome surface starts hidden until the caller supplies its bounds.
  void SetBrowserBounds(const CefRect& bounds, bool visible);
  void DetachShell();
  void Minimize();
  void ToggleZoom();
  int WindowNumber() const;

 private:
  struct State;
  explicit KestrelChromeWindowContainer(std::shared_ptr<State> state);
  std::shared_ptr<State> state_;
};

#endif  // KESTREL_CHROME_WINDOW_MAC_H_
