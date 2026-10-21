#include "kestrel_chrome_window_mac.h"

#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <cmath>
#include <utility>

#include "include/cef_request_context.h"
#include "include/cef_task.h"
#include "include/views/cef_browser_view.h"

struct KestrelChromeWindowContainer::State
    : public std::enable_shared_from_this<State> {
  CefRefPtr<CefBrowser> owner;
  CefRefPtr<CefRequestContext> owner_context;
  CefRefPtr<CefBrowser> shell;
  NSWindow* __strong window = nil;
  NSView* __strong chrome_root = nil;
  NSView* __strong chrome_clip = nil;
  NSView* __strong container = nil;
  NSMutableArray* __strong observers = nil;
  std::function<void()> on_window_closing;
  CefRect browser_bounds;
  bool browser_visible = false;
  bool closing = false;
  bool cleaned_up = false;
  bool layout_pending = false;

  void ApplyLayout() {
    if (closing || cleaned_up || !window || !container || !chrome_root) return;

    const NSRect available = container.bounds;
    if (shell && shell->IsValid()) {
      NSView* shell_view =
          (__bridge NSView*)shell->GetHost()->GetWindowHandle();
      if (shell_view && shell_view.superview == container) {
        shell_view.frame = available;
        shell_view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      }
    }

    const CGFloat x = std::clamp<CGFloat>(browser_bounds.x, 0,
                                        available.size.width);
    const CGFloat top = std::clamp<CGFloat>(browser_bounds.y, 0,
                                          available.size.height);
    const CGFloat width = std::clamp<CGFloat>(
        browser_bounds.width, 0, available.size.width - x);
    const CGFloat height = std::clamp<CGFloat>(
        browser_bounds.height, 0, available.size.height - top);
    chrome_clip.hidden = !browser_visible || width <= 0 || height <= 0;
    if (chrome_clip.hidden) return;

    // Native Chromium compositor layers can extend beyond their NSView. Keep
    // them inside a separate layer-backed viewport so neither a stale frame
    // nor outer-window geometry can paint over Kestrel's agent/sidebar panes.
    chrome_clip.frame = NSMakeRect(x, available.size.height - top - height,
                                   width, height);
    chrome_root.frame = NSMakeRect(0, 0, width, height);
    // Chromium can apply outer-window geometry after Cocoa resizes this child.
    // Calling setFrameSize even when unchanged notifies BridgedContentView's
    // native host of the actual inset viewport, including Chrome's controls.
    [chrome_root setFrameSize:NSMakeSize(width, height)];
    [chrome_clip setNeedsDisplay:YES];
    [container setNeedsDisplay:YES];
  }

  void ScheduleLayout() {
    if (closing || cleaned_up || layout_pending) return;
    layout_pending = true;
    const std::weak_ptr<State> weak = shared_from_this();
    dispatch_async(dispatch_get_main_queue(), ^{
      const auto state = weak.lock();
      if (!state || state->closing || state->cleaned_up) return;
      state->layout_pending = false;
      state->ApplyLayout();
      // Give Chromium's posted window-geometry work another queue turn. Both
      // passes read current bounds, so a newer React layout wins naturally.
      dispatch_async(dispatch_get_main_queue(), ^{
        if (const auto next = weak.lock()) next->ApplyLayout();
      });
    });
  }

  void DetachShell() {
    if (!shell) return;
    // An Alloy native child closes its containing NSWindow via CloseBrowser.
    // Removing its owning NSView tears down only that browser instead.
    if (shell->IsValid()) {
      NSView* shell_view =
          (__bridge NSView*)shell->GetHost()->GetWindowHandle();
      if (shell_view && shell_view.superview == container) {
        [shell_view removeFromSuperview];
      }
    }
    shell = nullptr;
  }

  void ObserveWindow() {
    observers = [[NSMutableArray alloc] init];
    const std::weak_ptr<State> weak = shared_from_this();
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    for (NSNotificationName name in @[
           NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification,
           NSWindowDidEnterFullScreenNotification,
           NSWindowDidExitFullScreenNotification,
           NSWindowDidChangeBackingPropertiesNotification,
           NSWindowDidChangeScreenNotification
         ]) {
      id observer = [center addObserverForName:name
                                       object:window
                                        queue:nil
                                   usingBlock:^(NSNotification*) {
        if (const auto state = weak.lock()) state->ScheduleLayout();
      }];
      [observers addObject:observer];
    }
    id closing_observer = [center
        addObserverForName:NSWindowWillCloseNotification
                    object:window
                     queue:nil
                usingBlock:^(NSNotification*) {
      const auto state = weak.lock();
      if (!state || state->closing || state->cleaned_up) return;
      state->closing = true;
      // Keep a local callback: the owner may destroy its container here.
      const auto callback = state->on_window_closing;
      if (callback) callback();
      // Let the owner mark all Chrome tabs as closing before native child
      // removal can synchronously deliver the shell's OnBeforeClose callback.
      state->DetachShell();
    }];
    [observers addObject:closing_observer];
  }

  void Cleanup() {
    if (cleaned_up) return;
    cleaned_up = true;
    for (id observer in observers) {
      [NSNotificationCenter.defaultCenter removeObserver:observer];
    }
    observers = nil;
    on_window_closing = nullptr;
    DetachShell();
    if (!closing && window && window.contentView == container && chrome_root) {
      // Restore Chromium's original content view when the live container is
      // discarded. Its native delegate and native window were never replaced.
      [chrome_root removeFromSuperview];
      window.contentView = chrome_root;
      chrome_root.hidden = NO;
      chrome_root.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      [chrome_root setFrameSize:container.bounds.size];
    }
    owner = nullptr;
    owner_context = nullptr;
    chrome_root = nil;
    chrome_clip = nil;
    container = nil;
    window = nil;
  }
};

std::unique_ptr<KestrelChromeWindowContainer>
KestrelChromeWindowContainer::Create(
    CefRefPtr<CefBrowser> owner,
    std::function<void()> on_window_closing,
    std::string* error) {
  const auto fail = [error](const char* message) {
    if (error) *error = message;
    return std::unique_ptr<KestrelChromeWindowContainer>();
  };
  if (!CefCurrentlyOn(TID_UI)) return fail("Chrome container requires UI thread.");
  if (!owner || !owner->IsValid() ||
      owner->GetHost()->GetRuntimeStyle() != CEF_RUNTIME_STYLE_CHROME ||
      CefBrowserView::GetForBrowser(owner)) {
    return fail("Chrome container requires a non-Views Chrome browser.");
  }
  NSView* root = (__bridge NSView*)owner->GetHost()->GetWindowHandle();
  NSWindow* window = root.window;
  if (!root || !window || window.contentView != root) {
    return fail("Chrome container could not find its original native window.");
  }

  auto state = std::make_shared<State>();
  state->owner = owner;
  state->owner_context = owner->GetHost()->GetRequestContext();
  state->window = window;
  state->chrome_root = root;
  state->on_window_closing = std::move(on_window_closing);
  const NSRect bounds = root.bounds;
  state->container = [[NSView alloc] initWithFrame:bounds];
  state->container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  state->container.wantsLayer = YES;
  state->container.layer.masksToBounds = YES;
  state->chrome_clip = [[NSView alloc] initWithFrame:NSZeroRect];
  state->chrome_clip.wantsLayer = YES;
  state->chrome_clip.clipsToBounds = YES;
  state->chrome_clip.layer.masksToBounds = YES;
  state->chrome_clip.hidden = YES;
  [root removeFromSuperview];
  window.contentView = state->container;
  [state->container addSubview:state->chrome_clip];
  [state->chrome_clip addSubview:root];
  root.autoresizingMask = NSViewNotSizable;
  root.hidden = NO;
  root.clipsToBounds = YES;
  state->ObserveWindow();
  if (error) error->clear();
  return std::unique_ptr<KestrelChromeWindowContainer>(
      new KestrelChromeWindowContainer(std::move(state)));
}

KestrelChromeWindowContainer::KestrelChromeWindowContainer(
    std::shared_ptr<State> state)
    : state_(std::move(state)) {}

KestrelChromeWindowContainer::~KestrelChromeWindowContainer() {
  state_->Cleanup();
}

CefWindowHandle KestrelChromeWindowContainer::ShellParentHandle() const {
  return (__bridge void*)state_->container;
}

CefRect KestrelChromeWindowContainer::ShellBounds() const {
  const NSRect bounds = state_->container.bounds;
  return CefRect(0, 0, static_cast<int>(std::floor(bounds.size.width)),
                 static_cast<int>(std::floor(bounds.size.height)));
}

void KestrelChromeWindowContainer::SetShellBrowser(CefRefPtr<CefBrowser> shell) {
  if (!shell || !shell->IsValid() || state_->closing || state_->cleaned_up ||
      shell->GetHost()->GetRuntimeStyle() != CEF_RUNTIME_STYLE_ALLOY ||
      shell->GetHost()->GetRequestContext()->IsSame(
          state_->owner_context)) {
    return;
  }
  NSView* shell_view = (__bridge NSView*)shell->GetHost()->GetWindowHandle();
  if (!shell_view || shell_view.superview != state_->container ||
      shell_view.window != state_->window) {
    return;
  }
  if (state_->shell && !state_->shell->IsSame(shell)) state_->DetachShell();
  state_->shell = shell;
  [state_->container addSubview:state_->chrome_clip
                    positioned:NSWindowAbove
                    relativeTo:nil];
  state_->ApplyLayout();
  state_->ScheduleLayout();
}

void KestrelChromeWindowContainer::SetBrowserBounds(const CefRect& bounds,
                                                  bool visible) {
  state_->browser_bounds = bounds;
  state_->browser_visible = visible;
  state_->ApplyLayout();
  state_->ScheduleLayout();
}

void KestrelChromeWindowContainer::DetachShell() { state_->DetachShell(); }

void KestrelChromeWindowContainer::Minimize() {
  if (!state_->closing && state_->window) [state_->window miniaturize:nil];
}

void KestrelChromeWindowContainer::ToggleZoom() {
  if (!state_->closing && state_->window) [state_->window zoom:nil];
}

int KestrelChromeWindowContainer::WindowNumber() const {
  return state_->window ? static_cast<int>(state_->window.windowNumber) : 0;
}
