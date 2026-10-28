#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>
#include <poll.h>
#include <limits.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <iostream>
#include <map>
#include <string>
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_focus_handler.h"
#include "include/cef_display_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_task.h"
#include "include/cef_id_mappers.h"
#include "include/cef_path_util.h"
#include "kestrel_chromium_app.h"
#include "kestrel_chromium_desktop.h"

namespace {
class OpenKestrelNewTabTask final : public CefTask {
 public:
  OpenKestrelNewTabTask(CefRefPtr<CefBrowser> browser, std::string expected, std::string ui)
      : browser_(browser), expected_(std::move(expected)), ui_(std::move(ui)) {}
  void Execute() override {
    if (browser_->IsValid() && browser_->GetMainFrame()->GetURL() == expected_)
      browser_->GetMainFrame()->LoadURL(ui_);
  }
 private:
  CefRefPtr<CefBrowser> browser_;
  const std::string expected_, ui_;
  IMPLEMENT_REFCOUNTING(OpenKestrelNewTabTask);
};
class DesktopClient final : public CefClient, public CefLifeSpanHandler, public CefFocusHandler, public CefDisplayHandler, public CefLoadHandler {
 public:
  explicit DesktopClient(std::string ui_url) : ui_url_(std::move(ui_url)) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefFocusHandler> GetFocusHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int http_status) override {
    if (frame->IsMain() && first_browser_ && browser->IsSame(first_browser_) &&
        frame->GetURL() == "about:blank") {
      // The first document wakes a dormant MV3 worker through runtime.connect.
      // Core authentication must not be a prerequisite for opening that page.
      document_ready_ = true;
      OpenUiWhenReady();
    }
  }
  void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                   ErrorCode code, const CefString& text, const CefString& failed_url) override {
    if (!frame->IsMain() || failed_url != ui_url_ || code == ERR_ABORTED || startup_retries_ >= 10) return;
    ++startup_retries_;
    // Chrome registers unpacked resources asynchronously on a fresh profile.
    // Retry only the owned first document, and only while its URL is unchanged.
    CefPostDelayedTask(TID_UI, new OpenKestrelNewTabTask(browser, frame->GetURL(), ui_url_), 200);
  }
  void OnAddressChange(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, const CefString& address) override {
    const std::string url = address;
    if (frame->IsMain() && (url == "chrome://newtab/" || url == "chrome://new-tab-page/"))
      CefPostTask(TID_UI, new OpenKestrelNewTabTask(browser, url, ui_url_));
  }
  void OnGotFocus(CefRefPtr<CefBrowser> browser) override { active_id_ = browser->GetIdentifier(); }
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    browsers_[browser->GetIdentifier()] = browser;
    browser->GetHost()->SetAccessibilityState(STATE_ENABLED);
    if (!first_browser_) first_browser_ = browser;
    OpenUiWhenReady();
    if (closing_) browser->GetHost()->CloseBrowser(true);
    std::cout << "KESTREL_CHROMIUM_DESKTOP_TAB_READY" << std::endl;
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    browsers_.erase(browser->GetIdentifier());
    if (first_browser_ && first_browser_->GetIdentifier() == browser->GetIdentifier()) first_browser_ = nullptr;
    std::cout << "KESTREL_CHROMIUM_DESKTOP_TAB_CLOSED remaining=" << browsers_.size() << std::endl;
    if (browsers_.empty()) CefQuitMessageLoop();
  }
  void Close() {
    closing_ = true;
    const auto snapshot = browsers_;
    for (const auto& [id, browser] : snapshot) browser->GetHost()->CloseBrowser(true);
  }
  void UiReady() { ui_ready_ = true; OpenUiWhenReady(); }
  CefRefPtr<CefBrowser> Active() {
    const auto active = browsers_.find(active_id_);
    return active != browsers_.end() ? active->second : first_browser_;
  }
  void OpenSettings() { const auto browser = Active(); if (browser) browser->GetMainFrame()->LoadURL(ui_url_ + "?app=settings"); }
 private:
  void OpenUiWhenReady() {
    if (!document_ready_ || ui_opened_ || !first_browser_) return;
    ui_opened_ = true;
    const std::string url = first_browser_->GetMainFrame()->GetURL();
    if (url.empty() || url == "about:blank") first_browser_->GetMainFrame()->LoadURL(ui_url_);
  }
  const std::string ui_url_;
  bool ui_ready_ = false;
  bool document_ready_ = false;
  int startup_retries_ = 0;
  bool ui_opened_ = false;
  CefRefPtr<CefBrowser> first_browser_;
  bool closing_ = false;
  int active_id_ = -1;
  std::map<int, CefRefPtr<CefBrowser>> browsers_;
  IMPLEMENT_REFCOUNTING(DesktopClient);
};
CefRefPtr<DesktopClient> desktop_client;
NSFileHandle* desktop_broker_input;
NSString* Argument(int argc, char** argv, const char* name) {
  for (int i = 1; i + 1 < argc; ++i) if (std::string(argv[i]) == name) return [NSString stringWithUTF8String:argv[i + 1]];
  return nil;
}
bool HasArgument(int argc, char** argv, const char* name) {
  for (int i = 1; i < argc; ++i) if (std::string(argv[i]) == name) return true;
  return false;
}
}

@interface KestrelChromiumMenuTarget : NSObject <NSMenuItemValidation>
- (void)chromeCommand:(NSMenuItem*)item;
- (void)settings:(id)sender;
@end
@implementation KestrelChromiumMenuTarget
- (void)chromeCommand:(NSMenuItem*)item {
  const auto browser = desktop_client ? desktop_client->Active() : nullptr;
  const int command = cef_id_for_command_id_name([item.representedObject UTF8String]);
  if (browser && command >= 0) browser->GetHost()->ExecuteChromeCommand(command, CEF_WOD_CURRENT_TAB);
}
- (void)settings:(id)sender { if (desktop_client) desktop_client->OpenSettings(); }
- (BOOL)validateMenuItem:(NSMenuItem*)item {
  const auto browser = desktop_client ? desktop_client->Active() : nullptr;
  if (item.action != @selector(chromeCommand:)) return browser != nullptr;
  const int command = cef_id_for_command_id_name([item.representedObject UTF8String]);
  return browser && command >= 0 && browser->GetHost()->CanExecuteChromeCommand(command);
}
@end

static KestrelChromiumMenuTarget* desktop_menu_target;
static void InstallDesktopMenu() {
  desktop_menu_target = [[KestrelChromiumMenuTarget alloc] init];
  NSMenu* main = [[NSMenu alloc] init];
  auto submenu = [main](NSString* title) {
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    NSMenu* menu = [[NSMenu alloc] initWithTitle:title]; item.submenu = menu; [main addItem:item]; return menu;
  };
  auto command = [](NSMenu* menu, NSString* title, NSString* name, NSString* key, NSEventModifierFlags modifiers) {
    NSMenuItem* item = [menu addItemWithTitle:title action:@selector(chromeCommand:) keyEquivalent:key];
    item.target = desktop_menu_target; item.representedObject = name; item.keyEquivalentModifierMask = modifiers;
  };
  const auto cmd = NSEventModifierFlagCommand;
  NSMenu* app_menu = submenu(@"Kestrel");
  [app_menu addItemWithTitle:@"About Kestrel" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
  NSMenuItem* settings = [app_menu addItemWithTitle:@"Settings…" action:@selector(settings:) keyEquivalent:@","]; settings.target = desktop_menu_target;
  [app_menu addItem:NSMenuItem.separatorItem];
  [app_menu addItemWithTitle:@"Hide Kestrel" action:@selector(hide:) keyEquivalent:@"h"];
  [app_menu addItemWithTitle:@"Quit Kestrel" action:@selector(terminate:) keyEquivalent:@"q"];
  NSMenu* file = submenu(@"File");
  command(file,@"New Tab",@"IDC_NEW_TAB",@"t",cmd);
  command(file,@"New Window",@"IDC_NEW_WINDOW",@"n",cmd);
  command(file,@"Reopen Closed Tab",@"IDC_RESTORE_TAB",@"t",cmd|NSEventModifierFlagShift);
  command(file,@"Close Tab",@"IDC_CLOSE_TAB",@"w",cmd);
  [file addItem:NSMenuItem.separatorItem];
  command(file,@"Print…",@"IDC_PRINT",@"p",cmd);
  NSMenu* edit = submenu(@"Edit");
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  NSMenuItem* redo = [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"]; redo.keyEquivalentModifierMask = cmd|NSEventModifierFlagShift;
  [edit addItem:NSMenuItem.separatorItem];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  command(edit,@"Find…",@"IDC_FIND",@"f",cmd);
  NSMenu* view = submenu(@"View");
  command(view,@"Open Location…",@"IDC_FOCUS_LOCATION",@"l",cmd);
  command(view,@"Reload",@"IDC_RELOAD",@"r",cmd);
  command(view,@"Zoom In",@"IDC_ZOOM_PLUS",@"=",cmd);
  command(view,@"Zoom Out",@"IDC_ZOOM_MINUS",@"-",cmd);
  command(view,@"Actual Size",@"IDC_ZOOM_NORMAL",@"0",cmd);
  NSMenu* history = submenu(@"History");
  command(history,@"Back",@"IDC_BACK",@"[",cmd);
  command(history,@"Forward",@"IDC_FORWARD",@"]",cmd);
  command(history,@"Show History",@"IDC_SHOW_HISTORY",@"y",cmd);
  NSMenu* bookmarks = submenu(@"Bookmarks");
  command(bookmarks,@"Bookmark This Tab",@"IDC_BOOKMARK_THIS_TAB",@"d",cmd);
  command(bookmarks,@"Bookmark Manager",@"IDC_SHOW_BOOKMARK_MANAGER",@"",cmd);
  NSMenu* window = submenu(@"Window");
  [window addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
  [window addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
  NSApp.windowsMenu = window;
  NSApp.mainMenu = main;
}

bool CloseKestrelChromiumDesktop() {
  if (!desktop_client) return false;
  if (desktop_broker_input) {
    @try { [desktop_broker_input closeFile]; } @catch (NSException*) {}
    desktop_broker_input = nil;
  }
  desktop_client->Close();
  return true;
}

int RunKestrelChromiumDesktop(int argc, char** argv) {
  NSString* requested = Argument(argc, argv, "--kestrel-cache-path");
  if (!requested || !requested.isAbsolutePath) {
    std::cerr << "Native Chromium requires an explicit isolated profile." << std::endl;
    return 1;
  }
  NSError* error = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtPath:requested withIntermediateDirectories:YES
        attributes:@{NSFilePosixPermissions:@0700} error:&error]) return 1;
  char resolved[PATH_MAX]{};
  if (!realpath(requested.fileSystemRepresentation, resolved)) return 1;
  NSString* profile = [NSString stringWithUTF8String:resolved];
  const std::string lock_path = std::string(resolved) + "/.kestrel-desktop.lock";
  const int lock_fd = open(lock_path.c_str(), O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0600);
  struct stat lock_stat{};
  if (lock_fd < 0 || fstat(lock_fd, &lock_stat) || !S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != getuid() || flock(lock_fd, LOCK_EX|LOCK_NB)) {
    if (lock_fd >= 0) close(lock_fd);
    std::cerr << "This native Kestrel profile is already in use or unavailable." << std::endl; return 1;
  }
  struct LockOwner { int fd; ~LockOwner() { close(fd); } } lock_owner{lock_fd};
  NSString* resources = NSBundle.mainBundle.resourcePath;
  NSTask* broker = [[NSTask alloc] init];
  broker.executableURL = [NSURL fileURLWithPath:[resources stringByAppendingPathComponent:@"agent-core/node/bin/node"]];
  NSMutableArray* arguments = [NSMutableArray arrayWithArray:@[
    [resources stringByAppendingPathComponent:@"native-ui-broker.mjs"], @"--profile-root", profile,
    @"--browser-pid", [NSString stringWithFormat:@"%d", getpid()]]];
  if (HasArgument(argc, argv, "--kestrel-durable-profile")) [arguments addObject:@"--durable-profile"];
  broker.arguments = arguments;
  NSDictionary* inherited = NSProcessInfo.processInfo.environment;
  NSMutableDictionary* environment = [NSMutableDictionary dictionary];
  for (NSString* name in @[@"HOME", @"PATH", @"LANG", @"TMPDIR"]) if (inherited[name]) environment[name] = inherited[name];
  broker.environment = environment;
  NSPipe* output = [NSPipe pipe];
  NSPipe* input = [NSPipe pipe];
  broker.standardOutput = output;
  broker.standardInput = input;
  broker.standardError = NSFileHandle.fileHandleWithStandardError;
  if (![broker launchAndReturnError:&error]) {
    std::cerr << "Kestrel could not launch its native UI broker." << std::endl; return 1;
  }
  pollfd ready{output.fileHandleForReading.fileDescriptor, POLLIN, 0};
  if (poll(&ready, 1, 15000) <= 0) { std::cerr << "Kestrel native UI broker startup timed out." << std::endl; [broker terminate]; return 1; }
  NSData* line = output.fileHandleForReading.availableData;
  NSDictionary* setup = [NSJSONSerialization JSONObjectWithData:line options:0 error:&error];
  NSString* extension_root = setup[@"extensionRoot"];
  NSString* extension_id = setup[@"extensionId"];
  if (![extension_root isKindOfClass:NSString.class] || ![extension_id isKindOfClass:NSString.class] ||
      ![extension_root hasPrefix:[profile stringByAppendingString:@"/"]] || extension_id.length != 32) {
    std::cerr << "Kestrel native UI broker returned invalid startup information." << std::endl;
    [broker terminate]; return 1;
  }
  std::string ui_path(extension_root.UTF8String);
  std::string ui_url = "chrome-extension://" + std::string(extension_id.UTF8String) + "/index.html";
  desktop_client = new DesktopClient(ui_url);
  desktop_broker_input = input.fileHandleForWriting;
  NSMutableData* event_buffer = [[NSMutableData alloc] init];
  output.fileHandleForReading.readabilityHandler = ^(NSFileHandle* handle) {
    NSData* data = handle.availableData;
    if (!data.length) { handle.readabilityHandler = nil; return; }
    [event_buffer appendData:data];
    if (event_buffer.length > 65536) { handle.readabilityHandler = nil; return; }
    const uint8_t newline = '\n';
    NSRange range;
    while ((range = [event_buffer rangeOfData:[NSData dataWithBytes:&newline length:1] options:0 range:NSMakeRange(0, event_buffer.length)]).location != NSNotFound) {
      NSData* message = [event_buffer subdataWithRange:NSMakeRange(0, range.location)];
      [event_buffer replaceBytesInRange:NSMakeRange(0, range.location + 1) withBytes:nullptr length:0];
      NSDictionary* value = [NSJSONSerialization JSONObjectWithData:message options:0 error:nil];
      if (![value isKindOfClass:NSDictionary.class]) continue;
      if ([value[@"kind"] isEqualToString:@"ui-ready"]) dispatch_async(dispatch_get_main_queue(), ^{ if (desktop_client) desktop_client->UiReady(); });
      if ([value[@"kind"] isEqualToString:@"host-request"] && [value[@"id"] isKindOfClass:NSString.class] && [value[@"request"] isKindOfClass:NSDictionary.class]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          NSString* type = value[@"request"][@"type"];
          NSDictionary* response = @{@"ok":@NO, @"error":@"Unsupported native desktop request."};
          if ([type isEqualToString:@"get-system-state"]) {
            SMAppServiceStatus status = SMAppService.mainAppService.status;
            NSString* label = status == SMAppServiceStatusEnabled ? @"enabled" : status == SMAppServiceStatusRequiresApproval ? @"requires-approval" : status == SMAppServiceStatusNotFound ? @"not-found" : @"not-registered";
            response = @{@"ok":@YES, @"launchAtLogin":@(status == SMAppServiceStatusEnabled), @"launchStatus":label, @"userName":NSFullUserName()};
          } else if ([type isEqualToString:@"get-default-browser-status"]) {
            NSURL* handler = [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:[NSURL URLWithString:@"https://kestrel.invalid/"]];
            BOOL is_default = handler && [handler.URLByResolvingSymlinksInPath isEqual:NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath];
            response = @{@"ok":@YES, @"isDefault":@(is_default), @"canSetAsDefault":@([NSBundle.mainBundle.bundlePath isEqualToString:@"/Applications/Kestrel.app"])};
          }
          NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"kind":@"host-response", @"id":value[@"id"], @"response":response} options:0 error:nil];
          if (!bytes || !broker.running) return;
          NSMutableData* line = [bytes mutableCopy];
          [line appendBytes:"\n" length:1];
          @try { [input.fileHandleForWriting writeData:line]; } @catch (NSException*) { /* Owner shutdown cancels the pending request. */ }
        });
      }
    }
  };
  CefMainArgs args(argc, argv);
  CefSettings settings;
  settings.persist_session_cookies = true;
  CefString(&settings.root_cache_path) = profile.UTF8String;
  CefString(&settings.cache_path) = profile.UTF8String;
  CefRefPtr<KestrelChromiumApp> app = new KestrelChromiumApp([resources, profile, extension_id, ui_url] {
    // CEF's root_cache_path owns Chromium's user-data directory. PK_USER_DATA
    // describes macOS Application Support and must never be used for this.
    NSString* directory = [profile stringByAppendingPathComponent:@"NativeMessagingHosts"];
    NSError* failure = nil;
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:&failure];
    NSDictionary* manifest = @{@"name":@"com.kestrel.desktop", @"description":@"Kestrel native workspace bridge",
      @"path":[resources stringByAppendingPathComponent:@"../MacOS/Kestrel Native Bridge"], @"type":@"stdio",
      @"allowed_origins":@[[NSString stringWithFormat:@"chrome-extension://%@/", extension_id]]};
    NSData* bytes = [NSJSONSerialization dataWithJSONObject:manifest options:0 error:&failure];
    if (!bytes || ![bytes writeToFile:[directory stringByAppendingPathComponent:@"com.kestrel.desktop.json"] options:NSDataWritingAtomic error:&failure]) {
      std::cerr << "Could not register Kestrel's native transport." << std::endl;
      CefQuitMessageLoop(); return;
    }
    CefWindowInfo window;
    window.runtime_style = CEF_RUNTIME_STYLE_CHROME;
    CefBrowserSettings browser_settings;
    if (!CefBrowserHost::CreateBrowserSync(window, desktop_client, "about:blank", browser_settings, nullptr, nullptr)) CefQuitMessageLoop();
  }, false, true, std::string(profile.UTF8String), [] { return desktop_client; }, ui_path);
  id<NSApplicationDelegate> owner_delegate = NSApp.delegate;
  if (!CefInitialize(args, settings, app, nullptr)) { [broker terminate]; desktop_client = nullptr; desktop_broker_input = nil; return CefGetExitCode(); }
  // CEF initializes Chromium's app controller during startup. Install our
  // embedding delegate and native menus afterwards, just as the CEF sample
  // does, so Quit owns the Core and messaging lifetimes as well as the window.
  NSApp.delegate = owner_delegate;
  InstallDesktopMenu();
  CefRunMessageLoop();
  // Native messaging keeps the extension worker alive. End the owned broker
  // before Chromium teardown, otherwise each can wait for the other's pipe.
  output.fileHandleForReading.readabilityHandler = nil;
  if (desktop_broker_input) {
    @try { [desktop_broker_input closeFile]; } @catch (NSException*) {}
    desktop_broker_input = nil;
  }
  for (int i = 0; broker.running && i < 40; ++i) usleep(100000);
  if (broker.running) [broker terminate];
  desktop_client = nullptr;
  app = nullptr;
  CefShutdown();
  desktop_menu_target = nil;
  return 0;
}
