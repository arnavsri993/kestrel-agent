#ifndef KESTREL_NATIVE_CHROMIUM_APP_H_
#define KESTREL_NATIVE_CHROMIUM_APP_H_
#pragma once

#include <functional>

#include "include/cef_app.h"
#include "include/cef_browser_process_handler.h"
#include "include/cef_command_line.h"
#include "include/cef_render_process_handler.h"
#include "include/wrapper/cef_message_router.h"

// The browser and renderer sides must use identical message-router names.
CefMessageRouterConfig KestrelBridgeRouterConfig();

// This object is supplied to both the browser executable and every CEF helper.
// It owns only host-neutral CEF policy and renderer bindings; AppKit window
// creation remains in the browser executable.
class KestrelChromiumApp final : public CefApp,
                                 public CefBrowserProcessHandler,
                                 public CefRenderProcessHandler {
 public:
  using BrowserContextInitialized = std::function<void()>;

  explicit KestrelChromiumApp(
      BrowserContextInitialized on_context_initialized = {});

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;
  void OnRegisterCustomSchemes(
      CefRawPtr<CefSchemeRegistrar> registrar) override;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override;
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override;

  void OnContextInitialized() override;

  void OnWebKitInitialized() override;
  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override;
  void OnContextReleased(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override;
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override;

 private:
  BrowserContextInitialized on_context_initialized_;
  CefRefPtr<CefMessageRouterRendererSide> renderer_router_;

  IMPLEMENT_REFCOUNTING(KestrelChromiumApp);
};

#endif  // KESTREL_NATIVE_CHROMIUM_APP_H_
