#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>
#include <poll.h>
#include <pwd.h>
#include <cstring>
#include <cerrno>
#include <limits.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
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
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/cef_id_mappers.h"
#include "include/cef_path_util.h"
#include "kestrel_chromium_app.h"
#include "kestrel_chromium_desktop.h"
#include "native_isolated_automation.h"

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
  DesktopClient(std::string ui_url, NativeIsolatedAutomation::Reply automation_reply)
      : ui_url_(std::move(ui_url)), automation_reply_(std::move(automation_reply)) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefFocusHandler> GetFocusHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int http_status) override {
    if (frame->IsMain() && frame->GetURL() == ui_url_ && http_status >= 200 && http_status < 400)
      std::cout << "KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED" << std::endl;
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
    if (first_browser_ && first_browser_->GetIdentifier() == browser->GetIdentifier())
      first_browser_ = browsers_.empty() ? nullptr : browsers_.begin()->second;
    std::cout << "KESTREL_CHROMIUM_DESKTOP_TAB_CLOSED remaining=" << browsers_.size() << std::endl;
    // Closing a macOS window must not terminate active Core work. Quit owns
    // the process lifetime; Dock activation and New Window can reopen Home.
    MaybeQuit();
  }
  void Close() {
    closing_ = true;
    if (automation_) {
      CefRefPtr<DesktopClient> self = this;
      automation_->Shutdown([self] { self->automation_closed_ = true; self->MaybeQuit(); });
    }
    if (browsers_.empty()) { MaybeQuit(); return; }
    const auto snapshot = browsers_;
    for (const auto& [id, browser] : snapshot) browser->GetHost()->CloseBrowser(true);
  }
  void AutomationRequest(const std::string& id, CefRefPtr<CefDictionaryValue> request) {
    if (closing_ || automation_resetting_) { automation_reply_(id, false, "", "The native browser is shutting down or resetting its isolated sessions."); return; }
    if (!automation_) {
      automation_closed_ = false;
      automation_ = std::make_unique<NativeIsolatedAutomation>(Active(), automation_reply_);
    }
    automation_->Request(id, request);
  }
  void AutomationCancel(const std::string& id) { if (automation_) automation_->Cancel(id); }
  void AutomationReset(std::function<void()> done) {
    if (automation_resetting_) return; // The private broker permits one barrier at a time.
    automation_resetting_ = true;
    if (!automation_) { automation_resetting_ = false; if (done) done(); return; }
    CefRefPtr<DesktopClient> self = this;
    automation_->Shutdown([self, done] {
      self->automation_closed_ = true;
      self->automation_.reset();
      self->automation_resetting_ = false;
      if (done) done();
      self->MaybeQuit();
    });
  }
  void UiReady() { ui_ready_ = true; OpenUiWhenReady(); }
  CefRefPtr<CefBrowser> Active() {
    const auto active = browsers_.find(active_id_);
    return active != browsers_.end() ? active->second : first_browser_;
  }
  void OpenWindow(const std::string& url = "") {
    if (closing_) return;
    CefWindowInfo window;
    window.runtime_style = CEF_RUNTIME_STYLE_CHROME;
    CefBrowserSettings settings;
    CefBrowserHost::CreateBrowserSync(window, this, url.empty() ? ui_url_ : url, settings, nullptr, nullptr);
  }
  void Reopen() {
    if (closing_) return;
    const auto browser = Active();
    if (!browser) { OpenWindow(); return; }
    NSView* view = (__bridge NSView*)browser->GetHost()->GetWindowHandle();
    NSWindow* window = view.window;
    if (window.miniaturized) [window deminiaturize:nil];
    [window makeKeyAndOrderFront:nil];
  }
  void OpenSettings() {
    const auto browser = Active();
    if (browser) browser->GetMainFrame()->LoadURL(ui_url_ + "?app=settings");
    else OpenWindow(ui_url_ + "?app=settings");
  }
 private:
  void MaybeQuit() { if (closing_ && browsers_.empty() && automation_closed_) CefQuitMessageLoop(); }
  void OpenUiWhenReady() {
    if (!document_ready_ || ui_opened_ || !first_browser_) return;
    ui_opened_ = true;
    const std::string url = first_browser_->GetMainFrame()->GetURL();
    if (url.empty() || url == "about:blank") first_browser_->GetMainFrame()->LoadURL(ui_url_);
  }
  const std::string ui_url_;
  NativeIsolatedAutomation::Reply automation_reply_;
  std::unique_ptr<NativeIsolatedAutomation> automation_;
  bool automation_closed_ = true;
  bool automation_resetting_ = false;
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
NSOpenPanel* desktop_workspace_panel;
NSString* desktop_workspace_panel_id;
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
  if (!browser && desktop_client && ([item.representedObject isEqualToString:@"IDC_NEW_WINDOW"] || [item.representedObject isEqualToString:@"IDC_NEW_TAB"])) {
    desktop_client->OpenWindow(); return;
  }
  const int command = cef_id_for_command_id_name([item.representedObject UTF8String]);
  if (browser && command >= 0) browser->GetHost()->ExecuteChromeCommand(command, CEF_WOD_CURRENT_TAB);
}
- (void)settings:(id)sender { if (desktop_client) desktop_client->OpenSettings(); }
- (BOOL)validateMenuItem:(NSMenuItem*)item {
  const auto browser = desktop_client ? desktop_client->Active() : nullptr;
  if (item.action != @selector(chromeCommand:)) return desktop_client != nullptr;
  if (!browser && desktop_client && ([item.representedObject isEqualToString:@"IDC_NEW_WINDOW"] || [item.representedObject isEqualToString:@"IDC_NEW_TAB"])) return YES;
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
  if (desktop_workspace_panel) [desktop_workspace_panel cancel:nil];
  if (desktop_broker_input) {
    @try { [desktop_broker_input closeFile]; } @catch (NSException*) {}
    desktop_broker_input = nil;
  }
  desktop_client->Close();
  return true;
}

bool ReopenKestrelChromiumDesktop() {
  if (!desktop_client) return false;
  desktop_client->Reopen();
  return true;
}

// Only an owned, private, separately marked default profile may reopen without
// another choice. Never infer ownership from a pre-existing nonempty folder.
static NSString* DefaultNativeProfile() {
  NSFileManager* files = NSFileManager.defaultManager;
  struct passwd* user = getpwuid(getuid());
  if (!user || !user->pw_dir) return nil;
  NSString* home = [NSString stringWithUTF8String:user->pw_dir];
  NSString* support = [home stringByAppendingPathComponent:@"Library/Application Support"];
  NSString* legacy = [support stringByAppendingPathComponent:@"Kestrel"];
  NSString* root = [support stringByAppendingPathComponent:@"Kestrel Native"];
  NSString* profile = [root stringByAppendingPathComponent:@"Default"];
  const char* test_env = getenv("KESTREL_NATIVE_TEST_PROFILE_ROOT");
  const bool test = test_env && *test_env;
  if (test) {
    // A private, already-existing directory inside macOS's per-user temporary
    // directory permits a no-CLI canary without touching a real profile.
    char temporary[PATH_MAX]{};
    char resolved_temp[PATH_MAX]{};
    char resolved_test[PATH_MAX]{};
    if (!confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, sizeof(temporary)) ||
        !realpath(temporary, resolved_temp) || !realpath(test_env, resolved_test)) return nil;
    const std::string base = std::string(resolved_temp) + "/";
    const std::string selected = resolved_test;
    struct stat supplied{};
    if (test_env[0] != '/' || lstat(test_env, &supplied) || !S_ISDIR(supplied.st_mode) ||
        supplied.st_uid != getuid() || (supplied.st_mode & 0077) ||
        selected.compare(0, base.size(), base) != 0) return nil;
    profile = [NSString stringWithUTF8String:resolved_test];
  }
  if (!test) {
    // Do not allow an ancestor alias to redirect the default into another
    // profile. The usual Application Support location must already exist.
    char resolved_home[PATH_MAX]{};
    char resolved_support[PATH_MAX]{};
    if (!realpath(home.fileSystemRepresentation, resolved_home) ||
        !realpath(support.fileSystemRepresentation, resolved_support) ||
        std::string(resolved_support) != std::string(resolved_home) + "/Library/Application Support") return nil;
    struct stat parent{};
    if (lstat(root.fileSystemRepresentation, &parent) == 0) {
      if (!S_ISDIR(parent.st_mode) || parent.st_uid != getuid() || (parent.st_mode & 0077)) return nil;
    } else if (errno != ENOENT) return nil;
  }
  const char* path = profile.fileSystemRepresentation;
  struct stat info{};
  bool exists = lstat(path, &info) == 0;
  if (!exists && errno != ENOENT) return nil;
  if (exists && (!S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0077))) return nil;
  NSString* marker = [profile stringByAppendingPathComponent:@".kestrel-native-default-v1"];
  const char* marker_path = marker.fileSystemRepresentation;
  if (exists) {
    int fd = open(marker_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd >= 0) {
      struct stat marker_info{};
      char data[32]{};
      const ssize_t count = read(fd, data, sizeof(data));
      const bool valid = !fstat(fd, &marker_info) && S_ISREG(marker_info.st_mode) &&
          marker_info.st_uid == getuid() && marker_info.st_nlink == 1 &&
          !(marker_info.st_mode & 0077) && count == 18 && !memcmp(data, "kestrel-native-v1\n", 18);
      close(fd);
      return valid ? profile : nil;
    }
    if (errno != ENOENT) return nil;
    NSArray* contents = [files contentsOfDirectoryAtPath:profile error:nil];
    if (!contents || contents.count != 0) {
      std::cerr << "Native default profile is not recognized; existing files were preserved." << std::endl;
      return nil;
    }
  }
  bool existing_data = false;
  if (!test) {
    // PRODUCT_IDENTITY uses "Kestrel" for Electron's Application Support
    // directory. Any other entry under Kestrel Native (including Development)
    // may be another profile; preserve it and ask before making Default.
    existing_data = [files fileExistsAtPath:legacy];
    struct stat parent{};
    if (!lstat(root.fileSystemRepresentation, &parent)) {
      NSError* inventory_error = nil;
      NSArray<NSString*>* entries = [files contentsOfDirectoryAtPath:root error:&inventory_error];
      if (!entries) return nil;
      for (NSString* entry in entries) if (![entry isEqualToString:@"Default"]) existing_data = true;
    } else if (errno != ENOENT) return nil;
  }
  if (existing_data) {
    NSAlert* choice = [[NSAlert alloc] init];
    choice.messageText = @"Use a separate Kestrel profile?";
    choice.informativeText = @"Existing Kestrel data was found. Continue with a separate native profile, or cancel. Your existing profile and credentials will remain untouched; they will not be transferred.";
    [choice addButtonWithTitle:@"Continue with Separate Profile"];
    [choice addButtonWithTitle:@"Cancel"];
    if ([choice runModal] != NSAlertFirstButtonReturn) return nil;
  }
  if (!test) {
    // The native parent must be an actual owned directory, never a link to the
    // legacy profile. Create no profile at all until after the choice above.
    struct stat parent{};
    if (lstat(root.fileSystemRepresentation, &parent)) {
      if (errno != ENOENT || mkdir(root.fileSystemRepresentation, 0700)) return nil;
      if (lstat(root.fileSystemRepresentation, &parent)) return nil;
    }
    if (!S_ISDIR(parent.st_mode) || parent.st_uid != getuid() || (parent.st_mode & 0077)) return nil;
    if (!exists && mkdir(path, 0700)) return nil;
    if (lstat(path, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0077)) return nil;
  }
  const int fd = open(marker_path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return nil;
  const char marker_data[] = "kestrel-native-v1\n";
  const bool saved = write(fd, marker_data, sizeof(marker_data) - 1) == sizeof(marker_data) - 1 && fsync(fd) == 0;
  close(fd);
  if (!saved) return nil; // Preserve an incomplete marker for explicit recovery.
  return profile;
}

int RunKestrelChromiumDesktop(int argc, char** argv, bool default_profile) {
  NSString* requested = default_profile ? DefaultNativeProfile() : Argument(argc, argv, "--kestrel-cache-path");
  if (!requested || !requested.isAbsolutePath) {
    std::cerr << (default_profile ? "Native default profile is unavailable or setup was cancelled; existing data was preserved." : "Native Chromium requires an explicit isolated profile.") << std::endl;
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
  if (default_profile || HasArgument(argc, argv, "--kestrel-durable-profile")) [arguments addObject:@"--durable-profile"];
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
  desktop_client = new DesktopClient(ui_url, [broker, input](const std::string& request_key, bool ok,
      const std::string& result_json, const std::string& error) {
    if (!broker.running || request_key.empty() || request_key.size() > 100) return;
    NSString* request_id = [NSString stringWithUTF8String:request_key.c_str()];
    if (!request_id) return;
    NSMutableDictionary* response = [@{@"kind":@"automation-response", @"id":request_id, @"ok":@(ok)} mutableCopy];
    if (ok && result_json.size() <= 1'048'000) {
      NSData* result_data = [NSData dataWithBytes:result_json.data() length:result_json.size()];
      id result = [NSJSONSerialization JSONObjectWithData:result_data options:NSJSONReadingFragmentsAllowed error:nil];
      if (result) response[@"result"] = result;
      else { response[@"ok"] = @NO; response[@"error"] = @"The native automation response was invalid."; }
    } else {
      response[@"ok"] = @NO;
      response[@"error"] = !ok && error.size() <= 500 ? ([NSString stringWithUTF8String:error.c_str()] ?: @"Native automation failed.") : @"The native automation response exceeded its limit.";
    }
    NSData* bytes = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    if (!bytes || bytes.length > 1'048'576) return;
    NSMutableData* line = [bytes mutableCopy]; [line appendBytes:"\n" length:1];
    @try { [input.fileHandleForWriting writeData:line]; } @catch (NSException*) { /* Broker shutdown settles its pending requests. */ }
  });
  desktop_broker_input = input.fileHandleForWriting;
  NSMutableData* event_buffer = [[NSMutableData alloc] init];
  output.fileHandleForReading.readabilityHandler = ^(NSFileHandle* handle) {
    NSData* data = handle.availableData;
    if (!data.length) { handle.readabilityHandler = nil; return; }
    const uint8_t newline = '\n';
    // Bound each newline frame, not a coalesced read containing several valid
    // requests. Large type/upload requests must not disable future dispatch.
    NSUInteger offset = 0;
    while (offset < data.length) {
    const NSUInteger count = MIN(data.length - offset, 1'048'577 - event_buffer.length);
    [event_buffer appendBytes:static_cast<const uint8_t*>(data.bytes) + offset length:count];
    offset += count;
    NSRange range;
    while ((range = [event_buffer rangeOfData:[NSData dataWithBytes:&newline length:1] options:0 range:NSMakeRange(0, event_buffer.length)]).location != NSNotFound) {
      if (range.location > 1'048'576) {
        handle.readabilityHandler = nil;
        std::cerr << "Native desktop protocol frame exceeded its limit." << std::endl;
        dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; }); return;
      }
      NSData* message = [event_buffer subdataWithRange:NSMakeRange(0, range.location)];
      [event_buffer replaceBytesInRange:NSMakeRange(0, range.location + 1) withBytes:nullptr length:0];
      NSDictionary* value = [NSJSONSerialization JSONObjectWithData:message options:0 error:nil];
      if (![value isKindOfClass:NSDictionary.class]) continue;
      if ([value[@"kind"] isEqualToString:@"dialog-cancel"] && [value[@"id"] isKindOfClass:NSString.class]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (desktop_workspace_panel && [desktop_workspace_panel_id isEqualToString:value[@"id"]]) [desktop_workspace_panel cancel:nil];
        });
      }
      if ([value[@"kind"] isEqualToString:@"automation-reset"] && [value[@"id"] isKindOfClass:NSString.class] &&
          [value[@"id"] length] <= 100 && [value[@"id"] hasPrefix:@"automation-"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (!desktop_client) return;
          desktop_client->AutomationReset([broker, input, value] {
            if (!broker.running) return;
            NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"kind":@"automation-reset-response", @"id":value[@"id"], @"ok":@YES} options:0 error:nil];
            if (!bytes) return;
            NSMutableData* line = [bytes mutableCopy]; [line appendBytes:"\n" length:1];
            @try { [input.fileHandleForWriting writeData:line]; } @catch (NSException*) {}
          });
        });
      }
      if (([value[@"kind"] isEqualToString:@"automation-request"] || [value[@"kind"] isEqualToString:@"automation-cancel"]) &&
          [value[@"id"] isKindOfClass:NSString.class] && [value[@"id"] length] <= 100 && [value[@"id"] hasPrefix:@"automation-"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (!desktop_client) return;
          const std::string request_id([value[@"id"] UTF8String]);
          if ([value[@"kind"] isEqualToString:@"automation-cancel"]) { desktop_client->AutomationCancel(request_id); return; }
          if (![value[@"request"] isKindOfClass:NSDictionary.class]) return;
          NSData* data = [NSJSONSerialization dataWithJSONObject:value[@"request"] options:0 error:nil];
          if (!data || data.length > 1'048'576) return;
          const auto parsed = CefParseJSON(std::string(static_cast<const char*>(data.bytes), data.length), JSON_PARSER_RFC);
          if (parsed && parsed->GetType() == VTYPE_DICTIONARY) desktop_client->AutomationRequest(request_id, parsed->GetDictionary());
        });
      }
      if ([value[@"kind"] isEqualToString:@"ui-ready"]) dispatch_async(dispatch_get_main_queue(), ^{
        if (desktop_client) {
          desktop_client->UiReady();
          // This comes only after Core is ready and the authenticated extension
          // worker has connected. It does not assert React has rendered.
          std::cout << "KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY" << std::endl;
        }
      });
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
          } else if ([type isEqualToString:@"select-workspace-folder"] && [value[@"id"] hasPrefix:@"dialog-"] && [value[@"id"] length] <= 100) {
            if (desktop_workspace_panel) response = @{@"ok":@NO, @"error":@"A native folder picker is already open."};
            else {
              NSOpenPanel* panel = NSOpenPanel.openPanel;
              panel.title = @"Grant Kestrel a project folder"; panel.prompt = @"Grant folder";
              panel.canChooseDirectories = YES; panel.canChooseFiles = NO;
              panel.allowsMultipleSelection = NO; panel.canCreateDirectories = YES;
              desktop_workspace_panel = panel; desktop_workspace_panel_id = value[@"id"];
              [panel beginWithCompletionHandler:^(NSModalResponse result) {
                const bool owned = desktop_workspace_panel == panel && [desktop_workspace_panel_id isEqualToString:value[@"id"]];
                if (!owned) return;
                desktop_workspace_panel = nil; desktop_workspace_panel_id = nil;
                NSURL* selected = result == NSModalResponseOK ? panel.URLs.firstObject : nil;
                NSDictionary* selection = selected.isFileURL && selected.path.length > 0 && selected.path.length <= 4096
                    ? @{@"ok":@YES, @"selectedWorkspacePath":selected.path}
                    : @{@"ok":@YES, @"cancelled":@YES};
                NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"kind":@"host-response", @"id":value[@"id"], @"response":selection} options:0 error:nil];
                if (!bytes || !broker.running) return;
                NSMutableData* line = [bytes mutableCopy]; [line appendBytes:"\n" length:1];
                @try { [input.fileHandleForWriting writeData:line]; } @catch (NSException*) {}
              }];
              return;
            }
          }
          NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"kind":@"host-response", @"id":value[@"id"], @"response":response} options:0 error:nil];
          if (!bytes || !broker.running) return;
          NSMutableData* line = [bytes mutableCopy];
          [line appendBytes:"\n" length:1];
          @try { [input.fileHandleForWriting writeData:line]; } @catch (NSException*) { /* Owner shutdown cancels the pending request. */ }
        });
      }
    }
    if (event_buffer.length > 1'048'576) {
      handle.readabilityHandler = nil;
      std::cerr << "Native desktop protocol frame exceeded its limit." << std::endl;
      dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; }); return;
    }
    }
  };
  CefMainArgs args(argc, argv);
  CefSettings settings;
  settings.windowless_rendering_enabled = true;
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
  // The documented dev launcher stops its owned process with SIGTERM. Route
  // that through the same clean Quit path as the menu, on AppKit's thread.
  const auto previous_sigterm = signal(SIGTERM, SIG_IGN);
  dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(termination, ^{ [NSApp terminate:nil]; });
  dispatch_resume(termination);
  CefRunMessageLoop();
  dispatch_source_cancel(termination);
  signal(SIGTERM, previous_sigterm);
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
