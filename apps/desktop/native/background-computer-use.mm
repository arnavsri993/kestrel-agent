// Kestrel Background Computer Use
//
// This is intentionally a small, synchronous Node-API bridge.  It uses only
// public macOS APIs and exposes semantic Accessibility operations plus a
// desktop-independent ScreenCaptureKit window capture.  There is deliberately
// no global input path in this file: the background-safe contract is enforced
// by the TypeScript manager and this bridge never creates or posts input.

#define NAPI_VERSION 8

#include <node_api.h>

#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreImage/CoreImage.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <Foundation/Foundation.h>
#include <ImageIO/ImageIO.h>
#include <ScreenCaptureKit/ScreenCaptureKit.h>

#include <dispatch/dispatch.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr int kProtocolVersion = 1;
constexpr size_t kMaxTreeNodes = 800;
constexpr size_t kMaxTreeDepth = 24;
constexpr size_t kMaxTextLength = 20'000;
constexpr double kAXMessagingTimeoutSeconds = 1.0;
constexpr double kShareableContentTimeoutSeconds = 8.0;
constexpr double kCaptureTimeoutSeconds = 8.0;

class NativeError final : public std::exception {
 public:
  NativeError(std::string code, std::string message)
      : code_(std::move(code)), message_(std::move(message)) {}

  const char* what() const noexcept override { return message_.c_str(); }
  const std::string& code() const { return code_; }
  const std::string& message() const { return message_; }

 private:
  std::string code_;
  std::string message_;
};

[[noreturn]] void Fail(const char* code, const std::string& message) {
  throw NativeError(code, message);
}

std::string UTF8(NSString* value) {
  if (!value) return {};
  const char* bytes = [value UTF8String];
  return bytes ? std::string(bytes) : std::string();
}

NSString* NSStringFromUTF8(const std::string& value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

std::string BoundedUTF8(NSString* value, size_t maxLength = kMaxTextLength) {
  if (!value) return {};
  if ([value length] > maxLength) value = [value substringToIndex:maxLength];
  return UTF8(value);
}

std::string NSErrorMessage(NSError* error, const char* fallback) {
  if (!error) return fallback;
  NSString* description = error.localizedDescription;
  std::string result = BoundedUTF8(description, 500);
  return result.empty() ? std::string(fallback) : result;
}

bool IsObject(napi_env env, napi_value value) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object;
}

napi_value GetNamed(napi_env env, napi_value object, const char* name,
                   bool* present = nullptr) {
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) {
    Fail("invalidRequest", "The native bridge could not inspect a request property.");
  }
  if (present) *present = has;
  if (!has) return nullptr;
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) {
    Fail("invalidRequest", "The native bridge could not read a request property.");
  }
  return value;
}

std::string RequiredString(napi_env env, napi_value object, const char* name,
                           size_t maxLength) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) {
    Fail("invalidRequest", std::string("Missing native request property: ") + name);
  }
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    Fail("invalidRequest", std::string("Native request property is not a string: ") + name);
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > maxLength) {
    Fail("invalidRequest", std::string("Native request string is too long: ") + name);
  }
  std::string result(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, result.data(), length + 1, &length) != napi_ok)
    Fail("invalidRequest", "The native bridge could not decode a request string.");
  result.resize(length);
  return result;
}

std::optional<std::string> OptionalString(napi_env env, napi_value object,
                                          const char* name, size_t maxLength) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) return std::nullopt;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
    Fail("invalidRequest", std::string("Native request property is not a string: ") + name);
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > maxLength)
    Fail("invalidRequest", std::string("Native request string is too long: ") + name);
  std::string result(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, result.data(), length + 1, &length) != napi_ok)
    Fail("invalidRequest", "The native bridge could not decode a request string.");
  result.resize(length);
  return result;
}

double RequiredNumber(napi_env env, napi_value value, const char* name) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || std::trunc(number) != number)
    Fail("invalidRequest", std::string("Native request property is not an integer: ") + name);
  return number;
}

int64_t RequiredInteger(napi_env env, napi_value object, const char* name,
                        int64_t minimum, int64_t maximum) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present)
    Fail("invalidRequest", std::string("Missing native request property: ") + name);
  double number = RequiredNumber(env, value, name);
  if (number < static_cast<double>(minimum) || number > static_cast<double>(maximum))
    Fail("invalidRequest", std::string("Native request property is out of bounds: ") + name);
  return static_cast<int64_t>(number);
}

std::optional<int64_t> OptionalInteger(napi_env env, napi_value object, const char* name,
                                       int64_t minimum, int64_t maximum) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) return std::nullopt;
  double number = RequiredNumber(env, value, name);
  if (number < static_cast<double>(minimum) || number > static_cast<double>(maximum))
    Fail("invalidRequest", std::string("Native request property is out of bounds: ") + name);
  return static_cast<int64_t>(number);
}

double RequiredFiniteNumber(napi_env env, napi_value object, const char* name,
                            double minimum, double maximum) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) Fail("invalidRequest", std::string("Missing native request property: ") + name);
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
      number < minimum || number > maximum)
    Fail("invalidRequest", std::string("Native request property is out of bounds: ") + name);
  return number;
}

bool OptionalBoolean(napi_env env, napi_value object, const char* name, bool fallback) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) return fallback;
  bool result = false;
  if (napi_get_value_bool(env, value, &result) != napi_ok)
    Fail("invalidRequest", std::string("Native request property is not a boolean: ") + name);
  return result;
}

napi_value RequiredObject(napi_env env, napi_value object, const char* name) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present || !IsObject(env, value))
    Fail("invalidRequest", std::string("Native request property is not an object: ") + name);
  return value;
}

std::vector<std::string> StringArray(napi_env env, napi_value value, const char* name,
                                     size_t maxItems, size_t maxLength) {
  bool isArray = false;
  if (napi_is_array(env, value, &isArray) != napi_ok || !isArray)
    Fail("invalidRequest", std::string("Native request property is not an array: ") + name);
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok || length > maxItems)
    Fail("invalidRequest", std::string("Native request array is too large: ") + name);
  std::vector<std::string> result;
  result.reserve(length);
  for (uint32_t index = 0; index < length; index++) {
    napi_value item = nullptr;
    if (napi_get_element(env, value, index, &item) != napi_ok)
      Fail("invalidRequest", "The native bridge could not read an array item.");
    napi_valuetype type;
    if (napi_typeof(env, item, &type) != napi_ok || type != napi_string)
      Fail("invalidRequest", "Native selector ancestry must contain strings.");
    size_t itemLength = 0;
    if (napi_get_value_string_utf8(env, item, nullptr, 0, &itemLength) != napi_ok ||
        itemLength > maxLength)
      Fail("invalidRequest", "Native selector ancestry contains an oversized string.");
    std::string itemValue(itemLength + 1, '\0');
    if (napi_get_value_string_utf8(env, item, itemValue.data(), itemLength + 1, &itemLength) != napi_ok)
      Fail("invalidRequest", "The native bridge could not decode selector ancestry.");
    itemValue.resize(itemLength);
    result.push_back(std::move(itemValue));
  }
  return result;
}

napi_value ParseJSON(napi_env env, NSString* json) {
  napi_value global = nullptr;
  napi_value parse = nullptr;
  napi_value input = nullptr;
  napi_value result = nullptr;
  std::string string = UTF8(json);
  if (napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "JSON", &input) != napi_ok ||
      napi_get_named_property(env, input, "parse", &parse) != napi_ok ||
      napi_create_string_utf8(env, string.c_str(), string.size(), &input) != napi_ok ||
      napi_call_function(env, global, parse, 1, &input, &result) != napi_ok) {
    Fail("nativeBridgeUnavailable", "The native bridge produced an invalid JSON response.");
  }
  return result;
}

napi_value JSON(napi_env env, id value) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!data || error) Fail("nativeBridgeUnavailable", NSErrorMessage(error, "JSON serialization failed."));
  NSString* string = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!string) Fail("nativeBridgeUnavailable", "The native bridge produced invalid UTF-8 JSON.");
  return ParseJSON(env, string);
}

napi_value ThrowTyped(napi_env env, const char* code, const std::string& message) {
  napi_value messageValue = nullptr;
  napi_value error = nullptr;
  napi_value codeValue = nullptr;
  napi_create_string_utf8(env, message.c_str(), message.size(), &messageValue);
  napi_create_error(env, nullptr, messageValue, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &codeValue);
  napi_set_named_property(env, error, "code", codeValue);
  napi_throw(env, error);
  return nullptr;
}

napi_value CallArguments(napi_env env, napi_callback_info info, size_t expected,
                         std::vector<napi_value>* output) {
  constexpr size_t kMaximumNativeArguments = 8;
  size_t argc = kMaximumNativeArguments;
  napi_value argv[kMaximumNativeArguments] = {};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != expected)
    Fail("invalidRequest", "The native bridge received an unexpected argument list.");
  output->assign(argv, argv + expected);
  return expected > 0 ? (*output)[0] : nullptr;
}

struct WindowSnapshot {
  uint32_t windowId = 0;
  pid_t pid = 0;
  std::string bundleId;
  std::string applicationName;
  std::string title;
  CGRect bounds = CGRectZero;
  int layer = 0;
  bool visible = false;
  bool hasAlpha = true;
};

bool DictionaryNumber(CFDictionaryRef dictionary, CFStringRef key, int64_t* result) {
  if (!dictionary || !result) return false;
  CFNumberRef number = static_cast<CFNumberRef>(CFDictionaryGetValue(dictionary, key));
  if (!number || CFGetTypeID(number) != CFNumberGetTypeID()) return false;
  return CFNumberGetValue(number, kCFNumberSInt64Type, result);
}

std::string DictionaryString(CFDictionaryRef dictionary, CFStringRef key) {
  if (!dictionary) return {};
  CFStringRef value = static_cast<CFStringRef>(CFDictionaryGetValue(dictionary, key));
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return {};
  return BoundedUTF8((__bridge NSString*)value, 1'000);
}

bool DictionaryBounds(CFDictionaryRef dictionary, CGRect* result) {
  if (!dictionary || !result) return false;
  CFDictionaryRef bounds = static_cast<CFDictionaryRef>(CFDictionaryGetValue(dictionary, kCGWindowBounds));
  return bounds && CGRectMakeWithDictionaryRepresentation(bounds, result);
}

bool IsKestrelBundle(const std::string& bundleId) {
  return bundleId == "com.kestrel.desktop" ||
         bundleId.rfind("com.kestrel.desktop.", 0) == 0;
}

std::vector<WindowSnapshot> EnumerateCGWindows() {
  CFArrayRef raw = CGWindowListCopyWindowInfo(
      kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!raw) return {};
  std::vector<WindowSnapshot> windows;
  CFIndex count = CFArrayGetCount(raw);
  windows.reserve(std::min<CFIndex>(count, static_cast<CFIndex>(kMaxTreeNodes)));
  for (CFIndex index = 0; index < count && windows.size() < kMaxTreeNodes; index++) {
    CFDictionaryRef dictionary = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(raw, index));
    int64_t windowId = 0;
    int64_t ownerPid = 0;
    if (!DictionaryNumber(dictionary, kCGWindowNumber, &windowId) ||
        !DictionaryNumber(dictionary, kCGWindowOwnerPID, &ownerPid) ||
        windowId <= 0 || ownerPid <= 0 || ownerPid == getpid() ||
        windowId > std::numeric_limits<uint32_t>::max())
      continue;
    WindowSnapshot snapshot;
    snapshot.windowId = static_cast<uint32_t>(windowId);
    snapshot.pid = static_cast<pid_t>(ownerPid);
    snapshot.applicationName = DictionaryString(dictionary, kCGWindowOwnerName);
    snapshot.title = DictionaryString(dictionary, kCGWindowName);
    snapshot.layer = 0;
    int64_t layer = 0;
    if (DictionaryNumber(dictionary, kCGWindowLayer, &layer)) snapshot.layer = static_cast<int>(layer);
    snapshot.visible = false;
    CFBooleanRef onScreen = static_cast<CFBooleanRef>(CFDictionaryGetValue(dictionary, kCGWindowIsOnscreen));
    if (onScreen && CFGetTypeID(onScreen) == CFBooleanGetTypeID()) snapshot.visible = CFBooleanGetValue(onScreen);
    CFNumberRef alpha = static_cast<CFNumberRef>(CFDictionaryGetValue(dictionary, kCGWindowAlpha));
    if (alpha && CFGetTypeID(alpha) == CFNumberGetTypeID()) {
      CGFloat value = 1;
      CFNumberGetValue(alpha, kCFNumberCGFloatType, &value);
      snapshot.hasAlpha = value > 0.001;
    }
    if (!DictionaryBounds(dictionary, &snapshot.bounds)) snapshot.bounds = CGRectZero;
    NSRunningApplication* application = [NSRunningApplication runningApplicationWithProcessIdentifier:snapshot.pid];
    if (application) {
      snapshot.bundleId = UTF8(application.bundleIdentifier);
      if (snapshot.applicationName.empty()) snapshot.applicationName = UTF8(application.localizedName);
    }
    if (snapshot.bundleId.empty()) snapshot.bundleId = "unknown";
    if (IsKestrelBundle(snapshot.bundleId)) continue;
    if (snapshot.applicationName.empty()) snapshot.applicationName = "Unknown application";
    windows.push_back(std::move(snapshot));
  }
  CFRelease(raw);
  return windows;
}

bool ScreenCapturePermission() {
  if (@available(macOS 10.15, *)) return CGPreflightScreenCaptureAccess();
  return false;
}

NSRunningApplication* FrontmostApplication() {
  return NSWorkspace.sharedWorkspace.frontmostApplication;
}

pid_t FrontmostPID() {
  NSRunningApplication* application = FrontmostApplication();
  return application ? application.processIdentifier : 0;
}

NSString* BundleIdentifierForPID(pid_t pid) {
  NSRunningApplication* application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  return application.bundleIdentifier ?: @"unknown";
}

std::string Architecture() {
#if defined(__arm64__)
  return "arm64";
#else
  return "unsupported";
#endif
}

std::string NowISO8601() {
  NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return UTF8([formatter stringFromDate:[NSDate date]]);
}

NSString* CapabilityState(bool accessibility, bool capture) {
  if (accessibility || capture) return accessibility ? @"unverified" : @"observationOnly";
  return @"unavailable";
}

NSArray* Backends(bool accessibility, bool capture) {
  NSMutableArray* result = [NSMutableArray arrayWithCapacity:2];
  if (accessibility) [result addObject:@"macos-accessibility"];
  if (capture) [result addObject:@"screencapturekit"];
  return result;
}

NSDictionary* BoundsDictionary(CGRect bounds) {
  return @{
    @"x": @(bounds.origin.x),
    @"y": @(bounds.origin.y),
    @"width": @(std::max<CGFloat>(0, bounds.size.width)),
    @"height": @(std::max<CGFloat>(0, bounds.size.height)),
  };
}

NSDictionary* WindowDictionary(const WindowSnapshot& snapshot, bool accessibility, bool capture) {
  std::string captureState = !capture ? "unavailable" :
      (!snapshot.visible || !snapshot.hasAlpha ? "unavailable" : "available");
  NSMutableDictionary* result = [@{
    @"pid": @(snapshot.pid),
    @"bundleId": NSStringFromUTF8(snapshot.bundleId),
    @"applicationName": NSStringFromUTF8(snapshot.applicationName),
    @"windowId": @(snapshot.windowId),
    @"bounds": BoundsDictionary(snapshot.bounds),
    @"layer": @(snapshot.layer),
    @"visible": snapshot.visible && snapshot.hasAlpha ? @YES : @NO,
    @"captureState": NSStringFromUTF8(captureState),
    @"accessibilityAvailable": accessibility ? @YES : @NO,
    @"isFrontmostApplication": FrontmostPID() == snapshot.pid ? @YES : @NO,
    @"capability": CapabilityState(accessibility, capture),
    @"supportedBackends": Backends(accessibility, capture),
  } mutableCopy];
  if (!snapshot.title.empty()) result[@"title"] = NSStringFromUTF8(snapshot.title);
  return result;
}

NSDictionary* ApplicationDictionary(NSRunningApplication* application, bool accessibility, bool capture) {
  pid_t pid = application.processIdentifier;
  NSMutableDictionary* result = [@{
    @"pid": @(pid),
    @"bundleId": application.bundleIdentifier ?: @"unknown",
    @"name": application.localizedName ?: @"Unknown application",
    @"isFrontmost": pid == FrontmostPID() ? @YES : @NO,
    @"accessibilityAvailable": accessibility ? @YES : @NO,
    @"capability": CapabilityState(accessibility, capture),
    @"supportedBackends": Backends(accessibility, capture),
  } mutableCopy];
  return result;
}

SCShareableContent* ShareableContent() {
  if (!ScreenCapturePermission())
    Fail("permissionDenied", "Screen Recording permission is required for window capture.");
  __block SCShareableContent* content = nil;
  __block NSError* callbackError = nil;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                           onScreenWindowsOnly:NO
                                               completionHandler:^(SCShareableContent* value, NSError* error) {
    content = value;
    callbackError = error;
    dispatch_semaphore_signal(semaphore);
  }];
  if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW,
                                                        static_cast<int64_t>(kShareableContentTimeoutSeconds * NSEC_PER_SEC))) != 0)
    Fail("timeout", "ScreenCaptureKit did not return shareable window metadata in time.");
  if (!content) {
    if (callbackError && callbackError.code == 1003)
      Fail("protectedContent", NSErrorMessage(callbackError, "The selected window is protected."));
    Fail("captureUnavailable", NSErrorMessage(callbackError, "ScreenCaptureKit did not return shareable content."));
  }
  return content;
}

SCWindow* ShareableWindow(uint32_t windowId, SCShareableContent** contentOut = nullptr) {
  SCShareableContent* content = ShareableContent();
  for (SCWindow* window in content.windows) {
    if (window.windowID == windowId) {
      if (window.owningApplication.processID == getpid() ||
          IsKestrelBundle(UTF8(window.owningApplication.bundleIdentifier)))
        Fail("backgroundUnsafe", "Kestrel BrowserWindow and WebContents use the browser backend, never host-level computer use.");
      if (contentOut) *contentOut = content;
      return window;
    }
  }
  Fail("windowDisappeared", "The selected background window is no longer capturable.");
}

}  // namespace

@interface KestrelImageWait : NSObject
@property(nonatomic, assign) CGImageRef image;
@property(nonatomic, strong) NSError* error;
@property(nonatomic, strong) dispatch_semaphore_t semaphore;
@end

@implementation KestrelImageWait
- (void)setImage:(CGImageRef)value {
  if (_image == value) return;
  if (_image) CGImageRelease(_image);
  _image = value ? CGImageRetain(value) : nullptr;
}
- (void)dealloc {
  if (_image) CGImageRelease(_image);
}
@end

@interface KestrelStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) CMSampleBufferRef sampleBuffer;
@property(nonatomic, strong) NSError* error;
@property(nonatomic, strong) dispatch_semaphore_t started;
@property(nonatomic, strong) dispatch_semaphore_t firstFrame;
@property(nonatomic, strong) dispatch_semaphore_t stopped;
@end

@implementation KestrelStreamOutput
- (void)setSampleBuffer:(CMSampleBufferRef)value {
  if (_sampleBuffer == value) return;
  if (_sampleBuffer) CFRelease(_sampleBuffer);
  _sampleBuffer = value ? (CMSampleBufferRef)CFRetain(value) : nullptr;
}
- (void)dealloc {
  if (_sampleBuffer) CFRelease(_sampleBuffer);
}
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
         ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen || !sampleBuffer || !CMSampleBufferIsValid(sampleBuffer)) return;
  if (!_sampleBuffer) self.sampleBuffer = sampleBuffer;
  if (_firstFrame) dispatch_semaphore_signal(_firstFrame);
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  self.error = error;
  if (_started) dispatch_semaphore_signal(_started);
  if (_firstFrame) dispatch_semaphore_signal(_firstFrame);
  if (_stopped) dispatch_semaphore_signal(_stopped);
}
@end

namespace {

CGImageRef CaptureWithStream(SCWindow* window, size_t maxWidth, size_t maxHeight) {
  SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
  configuration.width = maxWidth;
  configuration.height = maxHeight;
  configuration.pixelFormat = kCVPixelFormatType_32BGRA;
  configuration.scalesToFit = YES;
  configuration.showsCursor = NO;
  KestrelStreamOutput* output = [[KestrelStreamOutput alloc] init];
  output.started = dispatch_semaphore_create(0);
  output.firstFrame = dispatch_semaphore_create(0);
  output.stopped = dispatch_semaphore_create(0);
  NSError* error = nil;
  SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
  bool outputAttached = false;
  bool captureStarted = false;
  bool captureStopped = false;
  CGImageRef image = nullptr;
  auto stop = [&]() {
    if (!stream) return;
    if (captureStarted && !captureStopped) {
      [stream stopCaptureWithCompletionHandler:^(NSError* stopError) {
        if (stopError && !output.error) output.error = stopError;
        dispatch_semaphore_signal(output.stopped);
      }];
      dispatch_semaphore_wait(output.stopped, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
      captureStopped = true;
    }
    if (outputAttached)
      [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:nil];
  };
  try {
    if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen
                sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)
                             error:&error])
      Fail("captureUnavailable", NSErrorMessage(error, "ScreenCaptureKit could not attach a window output."));
    outputAttached = true;
    [stream startCaptureWithCompletionHandler:^(NSError* startError) {
      output.error = startError;
      dispatch_semaphore_signal(output.started);
    }];
    captureStarted = true;
    if (dispatch_semaphore_wait(output.started, dispatch_time(DISPATCH_TIME_NOW,
                                                               static_cast<int64_t>(kCaptureTimeoutSeconds * NSEC_PER_SEC))) != 0)
      Fail("timeout", "ScreenCaptureKit did not start the window capture in time.");
    if (output.error)
      Fail("captureUnavailable", NSErrorMessage(output.error, "ScreenCaptureKit could not start the window capture."));
    if (dispatch_semaphore_wait(output.firstFrame, dispatch_time(DISPATCH_TIME_NOW,
                                                                  static_cast<int64_t>(kCaptureTimeoutSeconds * NSEC_PER_SEC))) != 0)
      Fail("captureUnavailable", "The selected background window did not produce a frame.");
    CMSampleBufferRef sample = output.sampleBuffer;
    if (!sample) Fail("captureUnavailable", "The selected background window returned no frame.");
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (!buffer) Fail("captureUnavailable", "The selected background window returned an invalid frame.");
    CIImage* ciImage = [CIImage imageWithCVPixelBuffer:(CVPixelBufferRef)buffer];
    CIContext* context = [[CIContext alloc] initWithOptions:nil];
    image = [context createCGImage:ciImage fromRect:ciImage.extent];
    stop();
    if (!image) Fail("captureUnavailable", "The selected background window could not be converted to an image.");
    return image;
  } catch (...) {
    if (image) CGImageRelease(image);
    stop();
    throw;
  }
}

CGImageRef CaptureImage(SCWindow* window, size_t maxWidth, size_t maxHeight) {
  if (@available(macOS 14.0, *)) {
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = maxWidth;
    configuration.height = maxHeight;
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.scalesToFit = YES;
    configuration.preservesAspectRatio = YES;
    configuration.showsCursor = NO;
    KestrelImageWait* wait = [[KestrelImageWait alloc] init];
    wait.semaphore = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageWithFilter:filter configuration:configuration
                                completionHandler:^(CGImageRef image, NSError* error) {
      wait.error = error;
      wait.image = image;
      dispatch_semaphore_signal(wait.semaphore);
    }];
    if (dispatch_semaphore_wait(wait.semaphore, dispatch_time(DISPATCH_TIME_NOW,
                                                               static_cast<int64_t>(kCaptureTimeoutSeconds * NSEC_PER_SEC))) != 0)
      Fail("timeout", "ScreenCaptureKit did not return a window capture in time.");
    if (wait.error)
      Fail("captureUnavailable", NSErrorMessage(wait.error, "ScreenCaptureKit could not capture the selected window."));
    if (!wait.image) Fail("captureUnavailable", "The selected window returned no image.");
    return CGImageRetain(wait.image);
  }
  return CaptureWithStream(window, maxWidth, maxHeight);
}

CGImageRef BoundedImage(CGImageRef source, size_t maxWidth, size_t maxHeight) {
  size_t width = CGImageGetWidth(source);
  size_t height = CGImageGetHeight(source);
  if (width <= maxWidth && height <= maxHeight) return CGImageRetain(source);
  double scale = std::min(static_cast<double>(maxWidth) / static_cast<double>(width),
                          static_cast<double>(maxHeight) / static_cast<double>(height));
  size_t boundedWidth = std::max<size_t>(1, static_cast<size_t>(std::floor(width * scale)));
  size_t boundedHeight = std::max<size_t>(1, static_cast<size_t>(std::floor(height * scale)));
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(nullptr, boundedWidth, boundedHeight, 8,
                                                boundedWidth * 4, colorSpace,
                                                kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (!context) Fail("captureUnavailable", "The bounded window image could not be allocated.");
  CGContextSetInterpolationQuality(context, kCGInterpolationMedium);
  CGContextDrawImage(context, CGRectMake(0, 0, boundedWidth, boundedHeight), source);
  CGImageRef image = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  if (!image) Fail("captureUnavailable", "The bounded window image could not be created.");
  return image;
}

bool IsBlank(CGImageRef image) {
  CGDataProviderRef provider = CGImageGetDataProvider(image);
  if (!provider) return true;
  CFDataRef data = CGDataProviderCopyData(provider);
  if (!data) return true;
  const UInt8* bytes = CFDataGetBytePtr(data);
  CFIndex length = CFDataGetLength(data);
  bool blank = length == 0;
  if (!blank) {
    blank = true;
    size_t step = std::max<CFIndex>(4, length / 256);
    for (CFIndex index = 0; index < length; index += static_cast<CFIndex>(step)) {
      if (bytes[index] != 0) {
        blank = false;
        break;
      }
    }
  }
  CFRelease(data);
  return blank;
}

NSData* EncodePNG(CGImageRef image) {
  CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
  if (!data) Fail("captureUnavailable", "The window PNG buffer could not be allocated.");
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(data, CFSTR("public.png"), 1, nullptr);
  if (!destination) {
    CFRelease(data);
    Fail("captureUnavailable", "The window PNG encoder is unavailable.");
  }
  CGImageDestinationAddImage(destination, image, nullptr);
  bool finalized = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  if (!finalized) {
    CFRelease(data);
    Fail("captureUnavailable", "The window PNG could not be finalized.");
  }
  return CFBridgingRelease(data);
}

std::optional<WindowSnapshot> FindWindow(uint32_t windowId) {
  for (const WindowSnapshot& window : EnumerateCGWindows())
    if (window.windowId == windowId) return window;
  return std::nullopt;
}

bool AXValuePoint(CFTypeRef value, CGPoint* point) {
  return value && CFGetTypeID(value) == AXValueGetTypeID() &&
         AXValueGetType((AXValueRef)value) == kAXValueCGPointType &&
         AXValueGetValue((AXValueRef)value, (AXValueType)kAXValueCGPointType, point);
}

bool AXValueSize(CFTypeRef value, CGSize* size) {
  return value && CFGetTypeID(value) == AXValueGetTypeID() &&
         AXValueGetType((AXValueRef)value) == kAXValueCGSizeType &&
         AXValueGetValue((AXValueRef)value, (AXValueType)kAXValueCGSizeType, size);
}

bool AXFrame(AXUIElementRef element, CGRect* result) {
  if (!element || !result) return false;
  CFTypeRef position = nullptr;
  CFTypeRef size = nullptr;
  AXError positionError = AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position);
  AXError sizeError = AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size);
  CGPoint point = CGPointZero;
  CGSize dimensions = CGSizeZero;
  bool valid = positionError == kAXErrorSuccess && sizeError == kAXErrorSuccess &&
               AXValuePoint(position, &point) && AXValueSize(size, &dimensions);
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  if (valid) *result = CGRectMake(point.x, point.y, std::max<CGFloat>(0, dimensions.width),
                                  std::max<CGFloat>(0, dimensions.height));
  return valid;
}

std::string AXString(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value)
    return {};
  std::string result;
  if (CFGetTypeID(value) == CFStringGetTypeID()) result = BoundedUTF8((__bridge NSString*)value, 1'000);
  CFRelease(value);
  return result;
}

std::optional<bool> AXBoolean(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value)
    return std::nullopt;
  std::optional<bool> result;
  if (CFGetTypeID(value) == CFBooleanGetTypeID()) result = CFBooleanGetValue((CFBooleanRef)value);
  CFRelease(value);
  return result;
}

bool IsSensitiveRole(const std::string& role, const std::string& subrole) {
  auto containsSensitiveWord = [](const std::string& value) {
    std::string lower = value;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char character) {
      return static_cast<char>(std::tolower(character));
    });
    return lower.find("secure") != std::string::npos || lower.find("password") != std::string::npos;
  };
  return containsSensitiveWord(role) || containsSensitiveWord(subrole);
}

id AXValueObject(CFTypeRef value) {
  if (!value) return [NSNull null];
  CFTypeID type = CFGetTypeID(value);
  if (type == CFStringGetTypeID()) {
    // AX values are application supplied. Keep conversion bounded even when
    // an application exposes a very large text value, before it crosses the
    // native/JavaScript boundary or enters a postcondition comparison.
    return NSStringFromUTF8(BoundedUTF8((__bridge NSString*)value));
  }
  if (type == CFBooleanGetTypeID()) return CFBooleanGetValue((CFBooleanRef)value) ? @YES : @NO;
  if (type == CFNumberGetTypeID()) {
    double number = 0;
    if (CFNumberGetValue((CFNumberRef)value, kCFNumberDoubleType, &number) && std::isfinite(number))
      return @(number);
  }
  if (type == CFNullGetTypeID()) return [NSNull null];
  return nil;
}

uint64_t FNV1a(const std::string& value) {
  uint64_t hash = 14695981039346656037ULL;
  for (unsigned char character : value) {
    hash ^= character;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string Fingerprint(const std::string& role, const std::string& subrole,
                        const std::string& identifier, const std::string& title,
                        const std::vector<std::string>& ancestry) {
  std::ostringstream source;
  source << role << '\x1f' << subrole << '\x1f' << identifier << '\x1f' << title << '\x1f';
  for (const std::string& item : ancestry) source << item << '\x1e';
  std::ostringstream result;
  result << "ax1-" << std::hex << std::setw(16) << std::setfill('0') << FNV1a(source.str());
  return result.str();
}

bool IsAllowedAction(const std::string& action) {
  return action == "AXPress" || action == "AXConfirm" || action == "AXCancel" ||
         action == "AXShowMenu" || action == "AXPick" || action == "AXIncrement" ||
         action == "AXDecrement";
}

std::string AXErrorCode(AXError error, const char* context) {
  switch (error) {
    case kAXErrorAPIDisabled:
      return "permissionDenied";
    case kAXErrorInvalidUIElement:
      return "staleElement";
    case kAXErrorCannotComplete:
      return "timeout";
    case kAXErrorActionUnsupported:
      return "unsupportedAction";
    case kAXErrorAttributeUnsupported:
      return "unsupportedAttribute";
    case kAXErrorNoValue:
      return "targetNotFound";
    default:
      return context && std::strcmp(context, "window") == 0 ? "windowDisappeared" : "nativeBridgeUnavailable";
  }
}

[[noreturn]] void FailAX(AXError error, const char* context, const std::string& message) {
  Fail(AXErrorCode(error, context).c_str(), message);
}

struct AXContext {
  AXUIElementRef application = nullptr;
  AXUIElementRef root = nullptr;
};

void ReleaseAXContext(AXContext* context) {
  if (!context) return;
  if (context->root && context->root != context->application) CFRelease(context->root);
  if (context->application) CFRelease(context->application);
  context->root = nullptr;
  context->application = nullptr;
}

bool CloseEnough(CGRect first, CGRect second) {
  return std::fabs(first.origin.x - second.origin.x) <= 4.0 &&
         std::fabs(first.origin.y - second.origin.y) <= 4.0 &&
         std::fabs(first.size.width - second.size.width) <= 4.0 &&
         std::fabs(first.size.height - second.size.height) <= 4.0;
}

AXUIElementRef AXWindowForCGWindow(AXUIElementRef application, const WindowSnapshot& target) {
  CFTypeRef rawWindows = nullptr;
  AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &rawWindows);
  if (error != kAXErrorSuccess || !rawWindows || CFGetTypeID(rawWindows) != CFArrayGetTypeID()) {
    if (rawWindows) CFRelease(rawWindows);
    FailAX(error, "window", "The target application did not expose its Accessibility windows.");
  }
  std::vector<AXUIElementRef> matches;
  CFArrayRef windows = (CFArrayRef)rawWindows;
  CFIndex windowCount = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < windowCount; index++) {
    AXUIElementRef candidate = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (!candidate) continue;
    AXUIElementSetMessagingTimeout(candidate, kAXMessagingTimeoutSeconds);
    std::string title = AXString(candidate, kAXTitleAttribute);
    CGRect frame = CGRectZero;
    bool hasTargetFrame = target.bounds.size.width > 0 && target.bounds.size.height > 0;
    bool frameMatches = hasTargetFrame && AXFrame(candidate, &frame) &&
                        CloseEnough(frame, target.bounds);
    bool titleMatches = !target.title.empty() && title == target.title;
    if (frameMatches || titleMatches) matches.push_back(candidate);
  }
  if (matches.size() > 1) {
    CFRelease(rawWindows);
    Fail("ambiguousSelector", "The selected CG window matched more than one Accessibility window.");
  }
  AXUIElementRef chosen = nullptr;
  if (matches.size() == 1) {
    chosen = (AXUIElementRef)CFRetain(matches[0]);
  } else if (windowCount == 1) {
    AXUIElementRef only = (AXUIElementRef)CFArrayGetValueAtIndex(windows, 0);
    if (only) chosen = (AXUIElementRef)CFRetain(only);
  }
  CFRelease(rawWindows);
  if (!chosen)
    Fail(windowCount > 1 ? "ambiguousSelector" : "windowDisappeared",
         windowCount > 1
             ? "The selected CG window could not be matched unambiguously to an Accessibility window."
             : "The selected window could not be matched to its Accessibility window.");
  AXUIElementSetMessagingTimeout(chosen, kAXMessagingTimeoutSeconds);
  return chosen;
}

AXContext MakeAXContext(pid_t pid, std::optional<uint32_t> windowId) {
  if (pid <= 0 || pid == getpid())
    Fail("backgroundUnsafe", "Kestrel cannot target its own BrowserWindow through host computer use.");
  if (!AXIsProcessTrusted())
    Fail("permissionDenied", "macOS Accessibility permission is required for semantic background control.");
  NSRunningApplication* application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!application || application.isTerminated)
    Fail("appTerminated", "The target application is no longer running.");
  if (IsKestrelBundle(UTF8(application.bundleIdentifier)))
    Fail("backgroundUnsafe", "Kestrel BrowserWindow and WebContents use the browser backend, never host-level computer use.");
  AXContext context;
  context.application = AXUIElementCreateApplication(pid);
  if (!context.application) Fail("nativeBridgeUnavailable", "The target Accessibility application could not be created.");
  AXUIElementSetMessagingTimeout(context.application, kAXMessagingTimeoutSeconds);
  if (windowId.has_value()) {
    std::optional<WindowSnapshot> snapshot = FindWindow(windowId.value());
    if (!snapshot || snapshot->pid != pid) {
      ReleaseAXContext(&context);
      Fail("windowDisappeared", "The selected window is not owned by the target application.");
    }
    context.root = AXWindowForCGWindow(context.application, snapshot.value());
  } else {
    context.root = context.application;
  }
  return context;
}

struct Selector {
  std::optional<std::string> elementId;
  std::optional<std::string> fingerprint;
  std::optional<std::string> role;
  std::optional<std::string> subrole;
  std::optional<std::string> identifier;
  std::optional<std::string> title;
  std::optional<std::string> description;
  std::optional<CGRect> frame;
  std::vector<std::string> ancestry;
  bool hasAncestry = false;
};

Selector ParseSelector(napi_env env, napi_value value) {
  if (!IsObject(env, value)) Fail("invalidRequest", "The Accessibility selector must be an object.");
  Selector selector;
  selector.elementId = OptionalString(env, value, "elementId", 200);
  selector.fingerprint = OptionalString(env, value, "fingerprint", 200);
  selector.role = OptionalString(env, value, "role", 200);
  selector.subrole = OptionalString(env, value, "subrole", 200);
  selector.identifier = OptionalString(env, value, "identifier", 500);
  selector.title = OptionalString(env, value, "title", 1'000);
  selector.description = OptionalString(env, value, "description", 1'000);
  bool framePresent = false;
  napi_value frameValue = GetNamed(env, value, "frame", &framePresent);
  if (framePresent) {
    if (!IsObject(env, frameValue))
      Fail("invalidRequest", "Native selector frame must be an object.");
    double x = RequiredFiniteNumber(env, frameValue, "x", -20'000, 20'000);
    double y = RequiredFiniteNumber(env, frameValue, "y", -20'000, 20'000);
    double width = RequiredFiniteNumber(env, frameValue, "width", 0, 20'000);
    double height = RequiredFiniteNumber(env, frameValue, "height", 0, 20'000);
    selector.frame = CGRectMake(x, y, width, height);
  }
  bool present = false;
  napi_value ancestry = GetNamed(env, value, "ancestry", &present);
  if (present) {
    selector.ancestry = StringArray(env, ancestry, "ancestry", 16, 200);
    selector.hasAncestry = true;
  }
  if (!selector.elementId && !selector.fingerprint && !selector.role && !selector.subrole &&
      !selector.identifier && !selector.title && !selector.description && !selector.frame &&
      !selector.hasAncestry)
    Fail("invalidRequest", "The Accessibility selector must contain a criterion.");
  return selector;
}

struct NodeRecord {
  AXUIElementRef element = nullptr;
  NSMutableDictionary* object = nil;
  std::string elementId;
  std::string fingerprint;
  std::string role;
  std::string subrole;
  std::string identifier;
  std::string title;
  std::string description;
  std::vector<std::string> ancestry;
};

void ReleaseNodes(std::vector<NodeRecord>* nodes) {
  if (!nodes) return;
  for (NodeRecord& node : *nodes)
    if (node.element) CFRelease(node.element);
  nodes->clear();
}

NSArray* AXActionNames(AXUIElementRef element) {
  CFArrayRef raw = nullptr;
  if (AXUIElementCopyActionNames(element, &raw) != kAXErrorSuccess || !raw) return @[];
  NSMutableArray* names = [NSMutableArray arrayWithCapacity:CFArrayGetCount(raw)];
  for (CFIndex index = 0; index < CFArrayGetCount(raw) && names.count < 32; index++) {
    CFStringRef value = (CFStringRef)CFArrayGetValueAtIndex(raw, index);
    if (!value || CFGetTypeID(value) != CFStringGetTypeID()) continue;
    std::string action = UTF8((__bridge NSString*)value);
    if (IsAllowedAction(action)) [names addObject:NSStringFromUTF8(action)];
  }
  CFRelease(raw);
  return names;
}

NSArray* SettableAttributes(AXUIElementRef element) {
  NSArray* candidates = @[ (__bridge NSString*)kAXValueAttribute,
                           (__bridge NSString*)kAXSelectedAttribute,
                           (__bridge NSString*)kAXExpandedAttribute ];
  NSMutableArray* result = [NSMutableArray arrayWithCapacity:3];
  for (NSString* attribute in candidates) {
    Boolean settable = false;
    AXError error = AXUIElementIsAttributeSettable(element, (__bridge CFStringRef)attribute, &settable);
    if (error == kAXErrorSuccess && settable) [result addObject:attribute];
  }
  return result;
}

NodeRecord BuildNode(AXUIElementRef element, const std::vector<std::string>& ancestry,
                     pid_t pid, std::optional<uint32_t> windowId) {
  NodeRecord record;
  record.element = (AXUIElementRef)CFRetain(element);
  AXUIElementSetMessagingTimeout(element, kAXMessagingTimeoutSeconds);
  record.role = AXString(element, kAXRoleAttribute);
  record.subrole = AXString(element, kAXSubroleAttribute);
  record.identifier = AXString(element, kAXIdentifierAttribute);
  record.title = AXString(element, kAXTitleAttribute);
  record.description = AXString(element, kAXDescriptionAttribute);
  record.ancestry = ancestry;
  CGRect frame = CGRectZero;
  bool hasFrame = AXFrame(element, &frame);
  // Geometry is a disambiguation hint, not part of the semantic identity. A
  // window can move or resize while the user works without invalidating an
  // otherwise stable Accessibility reference.
  record.fingerprint = Fingerprint(record.role, record.subrole, record.identifier, record.title,
                                   ancestry);
  record.elementId = "e-" + record.fingerprint;
  NSMutableDictionary* object = [@{
    @"elementId": NSStringFromUTF8(record.elementId),
    @"fingerprint": NSStringFromUTF8(record.fingerprint),
    @"valueRedacted": @NO,
    @"supportedActions": AXActionNames(element),
    @"settableAttributes": SettableAttributes(element),
    @"children": [NSMutableArray array],
    @"ancestry": [NSMutableArray arrayWithCapacity:ancestry.size()],
  } mutableCopy];
  NSMutableArray* ancestryArray = object[@"ancestry"];
  for (const std::string& item : ancestry) [ancestryArray addObject:NSStringFromUTF8(item)];
  if (!record.role.empty()) object[@"role"] = NSStringFromUTF8(record.role);
  if (!record.subrole.empty()) object[@"subrole"] = NSStringFromUTF8(record.subrole);
  if (!record.identifier.empty()) object[@"identifier"] = NSStringFromUTF8(record.identifier);
  if (!record.title.empty()) object[@"title"] = NSStringFromUTF8(record.title);
  if (!record.description.empty()) object[@"description"] = NSStringFromUTF8(record.description);
  std::string help = AXString(element, kAXHelpAttribute);
  if (!help.empty()) object[@"help"] = NSStringFromUTF8(help);
  if (hasFrame) object[@"frame"] = BoundsDictionary(frame);
  if (std::optional<bool> enabled = AXBoolean(element, kAXEnabledAttribute)) object[@"enabled"] = *enabled ? @YES : @NO;
  if (std::optional<bool> selected = AXBoolean(element, kAXSelectedAttribute)) object[@"selected"] = *selected ? @YES : @NO;
  if (std::optional<bool> focused = AXBoolean(element, kAXFocusedAttribute)) object[@"focused"] = *focused ? @YES : @NO;
  bool sensitive = IsSensitiveRole(record.role, record.subrole);
  if (sensitive) {
    object[@"valueRedacted"] = @YES;
    object[@"value"] = @{ @"redacted": @YES, @"reason": @"secure-field" };
  } else {
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value) == kAXErrorSuccess && value) {
      id converted = AXValueObject(value);
      if (converted) object[@"value"] = converted;
      CFRelease(value);
    }
  }
  record.object = object;
  return record;
}

struct CollectedTree {
  std::vector<NodeRecord> nodes;
  bool truncated = false;
};

bool AlreadyVisited(AXUIElementRef element, const CollectedTree& tree) {
  if (!element) return true;
  for (const NodeRecord& node : tree.nodes) {
    if (node.element && CFEqual(node.element, element)) return true;
  }
  return false;
}

void CollectNode(AXUIElementRef element, int depth, size_t maxNodes, size_t maxDepth,
                 pid_t pid, std::optional<uint32_t> windowId,
                 const std::vector<std::string>& ancestry, CollectedTree* tree) {
  if (!tree || tree->nodes.size() >= maxNodes) {
    if (tree) tree->truncated = true;
    return;
  }
  // Accessibility providers are allowed to expose shared descendants and,
  // in practice, occasional cycles. The retained AX references in nodes keep
  // the equality checks valid for the duration of this bounded traversal.
  // Never recurse into an element already represented in this snapshot.
  if (AlreadyVisited(element, *tree)) {
    tree->truncated = true;
    return;
  }
  NodeRecord record = BuildNode(element, ancestry, pid, windowId);
  size_t parentIndex = tree->nodes.size();
  tree->nodes.push_back(std::move(record));
  if (depth >= static_cast<int>(maxDepth)) {
    // A depth boundary is only truncation when the boundary node actually
    // exposes children. Leaf nodes at the requested depth are complete.
    CFTypeRef rawChildren = nullptr;
    AXError childError = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &rawChildren);
    if (childError == kAXErrorSuccess && rawChildren &&
        CFGetTypeID(rawChildren) == CFArrayGetTypeID() &&
        CFArrayGetCount((CFArrayRef)rawChildren) > 0)
      tree->truncated = true;
    if (rawChildren) CFRelease(rawChildren);
    return;
  }
  CFTypeRef rawChildren = nullptr;
  AXError error = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &rawChildren);
  if (error != kAXErrorSuccess || !rawChildren || CFGetTypeID(rawChildren) != CFArrayGetTypeID()) {
    if (rawChildren) CFRelease(rawChildren);
    return;
  }
  CFArrayRef children = (CFArrayRef)rawChildren;
  for (CFIndex index = 0; index < CFArrayGetCount(children); index++) {
    if (tree->nodes.size() >= maxNodes) {
      tree->truncated = true;
      break;
    }
    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, index);
    if (!child) continue;
    std::vector<std::string> childAncestry = ancestry;
    std::string token = tree->nodes[parentIndex].role;
    if (token.empty()) token = tree->nodes[parentIndex].title;
    if (token.empty()) token = tree->nodes[parentIndex].elementId;
    childAncestry.push_back(token);
    if (childAncestry.size() > 16) childAncestry.erase(childAncestry.begin());
    size_t before = tree->nodes.size();
    CollectNode(child, depth + 1, maxNodes, maxDepth, pid, windowId, childAncestry, tree);
    if (tree->nodes.size() > before)
      [tree->nodes[parentIndex].object[@"children"] addObject:tree->nodes[before].object[@"elementId"]];
  }
  CFRelease(rawChildren);
}

CollectedTree CollectTree(const AXContext& context, pid_t pid, std::optional<uint32_t> windowId,
                           size_t maxNodes, size_t maxDepth) {
  CollectedTree tree;
  std::vector<std::string> ancestry;
  CollectNode(context.root, 0, std::min(maxNodes, kMaxTreeNodes),
              std::min(maxDepth, kMaxTreeDepth), pid, windowId, ancestry, &tree);
  return tree;
}

NSDictionary* TreeDictionary(const CollectedTree& tree, pid_t pid, std::optional<uint32_t> windowId) {
  NSMutableArray* nodes = [NSMutableArray arrayWithCapacity:tree.nodes.size()];
  for (const NodeRecord& node : tree.nodes) [nodes addObject:node.object];
  NSMutableDictionary* result = [@{
    @"protocolVersion": @(kProtocolVersion),
    @"generation": NSStringFromUTF8("g-" + std::to_string(pid) + "-" + NowISO8601()),
    @"pid": @(pid),
    @"nodes": nodes,
    @"truncated": tree.truncated ? @YES : @NO,
  } mutableCopy];
  if (windowId.has_value()) result[@"windowId"] = @(windowId.value());
  return result;
}

bool SelectorMatches(const Selector& selector, const NodeRecord& node) {
  if (selector.elementId && selector.elementId.value() != node.elementId) return false;
  if (selector.fingerprint && selector.fingerprint.value() != node.fingerprint) return false;
  if (selector.role && selector.role.value() != node.role) return false;
  if (selector.subrole && selector.subrole.value() != node.subrole) return false;
  if (selector.identifier && selector.identifier.value() != node.identifier) return false;
  if (selector.title && selector.title.value() != node.title) return false;
  if (selector.description && selector.description.value() != node.description) return false;
  if (selector.frame) {
    CGRect frame = CGRectZero;
    if (!node.element || !AXFrame(node.element, &frame) || !CloseEnough(frame, selector.frame.value()))
      return false;
  }
  if (selector.hasAncestry && selector.ancestry != node.ancestry) return false;
  return true;
}

bool SelectorHasStableIdentity(const Selector& selector) {
  return selector.elementId.has_value() || selector.fingerprint.has_value();
}

// The returned NodeRecord owns the AX reference, but the collected vector must
// outlive the mutation.  This helper resolves and moves the selected reference
// into a standalone record while releasing the rest of the bounded snapshot.
NodeRecord ResolveNodeOwned(napi_env env, AXContext* context, const Selector& selector, pid_t pid,
                            std::optional<uint32_t> windowId) {
  CollectedTree tree = CollectTree(*context, pid, windowId, kMaxTreeNodes, kMaxTreeDepth);
  std::vector<size_t> matches;
  for (size_t index = 0; index < tree.nodes.size(); index++)
    if (SelectorMatches(selector, tree.nodes[index])) matches.push_back(index);
  if (matches.size() > 1 || (tree.truncated && matches.size() == 1 && !SelectorHasStableIdentity(selector))) {
    ReleaseNodes(&tree.nodes);
    Fail("ambiguousSelector", "The Accessibility selector is not unique in the current tree.");
  }
  if (matches.empty()) {
    ReleaseNodes(&tree.nodes);
    if (selector.elementId || selector.fingerprint)
      Fail("staleElement", "The Accessibility element reference is stale; inspect the window again.");
    Fail("targetNotFound", "The Accessibility selector did not match a current element.");
  }
  size_t selected = matches[0];
  NodeRecord result = std::move(tree.nodes[selected]);
  tree.nodes[selected].element = nullptr;
  ReleaseNodes(&tree.nodes);
  return result;
}

std::string ActionType(napi_env env, napi_value actionValue) {
  napi_value type = GetNamed(env, actionValue, "type");
  if (!type) Fail("invalidRequest", "The Accessibility action has no type.");
  napi_valuetype valueType;
  if (napi_typeof(env, type, &valueType) != napi_ok || valueType != napi_string)
    Fail("invalidRequest", "The Accessibility action type is invalid.");
  size_t length = 0;
  napi_get_value_string_utf8(env, type, nullptr, 0, &length);
  if (length > 32) Fail("invalidRequest", "The Accessibility action type is too long.");
  std::string result(length + 1, '\0');
  napi_get_value_string_utf8(env, type, result.data(), length + 1, &length);
  result.resize(length);
  return result;
}

std::string AXActionForType(const std::string& type, const std::string& direction) {
  if (type == "press") return "AXPress";
  if (type == "confirm") return "AXConfirm";
  if (type == "cancel") return "AXCancel";
  if (type == "showMenu") return "AXShowMenu";
  if (type == "pick" || type == "select") return "AXPick";
  if (type == "increment") return "AXIncrement";
  if (type == "decrement") return "AXDecrement";
  if (type == "scroll") return direction == "up" || direction == "left" ? "AXDecrement" : "AXIncrement";
  return {};
}

void EnsureBackground(pid_t pid) {
  if (FrontmostPID() == pid)
    Fail("backgroundUnsafe", "The target application is foreground; Kestrel will not take keyboard focus.");
}

NSDictionary* PerformAction(napi_env env, napi_value input) {
  pid_t pid = static_cast<pid_t>(RequiredInteger(env, input, "pid", 1, 10'000'000));
  std::optional<int64_t> windowNumber = OptionalInteger(env, input, "windowId", 1, 0x7fffffff);
  std::optional<uint32_t> windowId = windowNumber ? std::optional<uint32_t>(static_cast<uint32_t>(*windowNumber)) : std::nullopt;
  Selector selector = ParseSelector(env, RequiredObject(env, input, "selector"));
  napi_value actionValue = RequiredObject(env, input, "action");
  std::string type = ActionType(env, actionValue);
  std::string direction;
  if (type == "scroll") direction = RequiredString(env, actionValue, "direction", 8);
  int amount = 1;
  if (type == "scroll") amount = static_cast<int>(RequiredInteger(env, actionValue, "amount", 1, 10));
  if (type != "expand" && type != "collapse" && AXActionForType(type, direction).empty())
    Fail("unsupportedAction", "The requested semantic Accessibility action is not supported.");
  EnsureBackground(pid);
  AXContext context = MakeAXContext(pid, windowId);
  NodeRecord node;
  try {
    node = ResolveNodeOwned(env, &context, selector, pid, windowId);
    EnsureBackground(pid);
    if (type == "expand" || type == "collapse") {
      Boolean settable = false;
      AXError settableError = AXUIElementIsAttributeSettable(node.element, kAXExpandedAttribute, &settable);
      if (settableError != kAXErrorSuccess) FailAX(settableError, "attribute", "The target does not expose an expandable Accessibility value.");
      if (!settable) Fail("unsupportedAttribute", "The target Accessibility element does not allow expansion changes.");
      AXError setError = AXUIElementSetAttributeValue(node.element, kAXExpandedAttribute,
                                                       type == "expand" ? kCFBooleanTrue : kCFBooleanFalse);
      if (setError != kAXErrorSuccess) FailAX(setError, "attribute", "The Accessibility expansion change was rejected.");
      EnsureBackground(pid);
      if (node.element) {
        CFRelease(node.element);
        node.element = nullptr;
      }
      ReleaseAXContext(&context);
      return @{ @"performed": @YES,
                @"action": NSStringFromUTF8(type),
                @"backend": @"macos-accessibility",
                @"targetBundleId": BundleIdentifierForPID(pid) };
    }
    std::string action = AXActionForType(type, direction);
    NSArray* actions = AXActionNames(node.element);
    if (![actions containsObject:NSStringFromUTF8(action)])
      Fail("unsupportedAction", "The target Accessibility element does not advertise that action.");
    for (int index = 0; index < amount; index++) {
      AXError error = AXUIElementPerformAction(node.element, (__bridge CFStringRef)NSStringFromUTF8(action));
      if (error != kAXErrorSuccess) FailAX(error, "action", "The target Accessibility action was rejected.");
      EnsureBackground(pid);
    }
    CFRelease(node.element);
    node.element = nullptr;
    ReleaseAXContext(&context);
    return @{ @"performed": @YES,
              @"action": NSStringFromUTF8(action),
              @"backend": @"macos-accessibility",
              @"targetBundleId": BundleIdentifierForPID(pid) };
  } catch (...) {
    if (node.element) CFRelease(node.element);
    ReleaseAXContext(&context);
    throw;
  }
}

NSDictionary* ReadValue(napi_env env, napi_value input) {
  pid_t pid = static_cast<pid_t>(RequiredInteger(env, input, "pid", 1, 10'000'000));
  std::optional<int64_t> windowNumber = OptionalInteger(env, input, "windowId", 1, 0x7fffffff);
  std::optional<uint32_t> windowId = windowNumber ? std::optional<uint32_t>(static_cast<uint32_t>(*windowNumber)) : std::nullopt;
  Selector selector = ParseSelector(env, RequiredObject(env, input, "selector"));
  AXContext context = MakeAXContext(pid, windowId);
  NodeRecord node;
  try {
    node = ResolveNodeOwned(env, &context, selector, pid, windowId);
    bool sensitive = IsSensitiveRole(node.role, node.subrole);
    if (sensitive) {
      CFRelease(node.element);
      node.element = nullptr;
      ReleaseAXContext(&context);
      return @{ @"value": @{ @"redacted": @YES, @"reason": @"secure-field" }, @"redacted": @YES };
    }
    CFTypeRef value = nullptr;
    AXError error = AXUIElementCopyAttributeValue(node.element, kAXValueAttribute, &value);
    if (error != kAXErrorSuccess) FailAX(error, "attribute", "The target Accessibility value could not be read.");
    id converted = AXValueObject(value);
    if (value) CFRelease(value);
    if (!converted) Fail("unsupportedAttribute", "The target Accessibility value is not a supported primitive.");
    CFRelease(node.element);
    node.element = nullptr;
    ReleaseAXContext(&context);
    return @{ @"value": converted, @"redacted": @NO };
  } catch (...) {
    if (node.element) CFRelease(node.element);
    ReleaseAXContext(&context);
    throw;
  }
}

NSDictionary* SetValue(napi_env env, napi_value input) {
  pid_t pid = static_cast<pid_t>(RequiredInteger(env, input, "pid", 1, 10'000'000));
  std::optional<int64_t> windowNumber = OptionalInteger(env, input, "windowId", 1, 0x7fffffff);
  std::optional<uint32_t> windowId = windowNumber ? std::optional<uint32_t>(static_cast<uint32_t>(*windowNumber)) : std::nullopt;
  Selector selector = ParseSelector(env, RequiredObject(env, input, "selector"));
  std::string value = RequiredString(env, input, "value", kMaxTextLength);
  bool secret = OptionalBoolean(env, input, "secret", false);
  AXContext context = MakeAXContext(pid, windowId);
  NodeRecord node;
  try {
    EnsureBackground(pid);
    node = ResolveNodeOwned(env, &context, selector, pid, windowId);
    if (IsSensitiveRole(node.role, node.subrole) && !secret)
      Fail("backgroundUnsafe", "Secure Accessibility fields require an explicit secret boundary.");
    Boolean settable = false;
    AXError settableError = AXUIElementIsAttributeSettable(node.element, kAXValueAttribute, &settable);
    if (settableError != kAXErrorSuccess) FailAX(settableError, "attribute", "The target value attribute could not be inspected.");
    if (!settable) Fail("unsupportedAttribute", "The target Accessibility value is not settable.");
    NSString* string = NSStringFromUTF8(value);
    AXError error = AXUIElementSetAttributeValue(node.element, kAXValueAttribute, (__bridge CFStringRef)string);
    if (error != kAXErrorSuccess) FailAX(error, "attribute", "The target Accessibility value was rejected.");
    EnsureBackground(pid);
    CFRelease(node.element);
    node.element = nullptr;
    ReleaseAXContext(&context);
    return secret ? @{ @"set": @YES,
                       @"redacted": @YES,
                       @"backend": @"macos-accessibility",
                       @"targetBundleId": BundleIdentifierForPID(pid) }
                  : @{ @"set": @YES,
                       @"redacted": @NO,
                       @"backend": @"macos-accessibility",
                       @"targetBundleId": BundleIdentifierForPID(pid) };
  } catch (...) {
    if (node.element) CFRelease(node.element);
    ReleaseAXContext(&context);
    throw;
  }
}

NSDictionary* InvariantState(napi_env env, napi_value input) {
  std::optional<int64_t> target = OptionalInteger(env, input, "targetPid", 0, 10'000'000);
  NSPoint cursor = NSEvent.mouseLocation;
  NSRunningApplication* frontmost = FrontmostApplication();
  double secondsSinceInput = CGEventSourceSecondsSinceLastEventType(
      kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
  NSString* activity = secondsSinceInput >= 0 && secondsSinceInput < 1.0 ? @"active" :
                       (secondsSinceInput >= 0 ? @"idle" : @"unknown");
  NSMutableDictionary* result = [@{
    @"cursorX": @(cursor.x),
    @"cursorY": @(cursor.y),
    @"frontmostPid": @(frontmost ? frontmost.processIdentifier : 0),
    @"targetPid": @(target.value_or(0)),
    @"kestrelPid": @(getpid()),
    @"userActivity": activity,
    @"sampledAt": NSStringFromUTF8(NowISO8601()),
    @"backend": @"none",
    @"activationAttempted": @NO,
  } mutableCopy];
  if (frontmost.bundleIdentifier) result[@"frontmostBundleId"] = frontmost.bundleIdentifier;
  return result;
}

napi_value HealthCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 0, &args);
      return JSON(env, @{
        @"status": @"healthy",
        @"protocolVersion": @(kProtocolVersion),
        @"platform": @"darwin",
        @"architecture": NSStringFromUTF8(Architecture()),
        @"bridge": @"in-process-node-api",
        @"publicAPIs": @YES,
      });
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native health probe failed.");
    }
  }
}

napi_value CapabilitiesCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 0, &args);
      bool screenCaptureKit = false;
      if (@available(macOS 12.3, *)) screenCaptureKit = true;
      return JSON(env, @{
        @"protocolVersion": @(kProtocolVersion),
        @"platform": @"darwin",
        @"architecture": NSStringFromUTF8(Architecture()),
        @"bridge": @"in-process-node-api",
        @"accessibility": AXIsProcessTrusted() ? @YES : @NO,
        @"screenCaptureKit": screenCaptureKit ? @YES : @NO,
        @"screenRecordingPermission": ScreenCapturePermission() ? @YES : @NO,
        @"targetedEvents": @NO,
        @"backgroundSafeOnly": @YES,
        @"maxTreeNodes": @(kMaxTreeNodes),
        @"maxCaptureWidth": @3840,
        @"maxCaptureHeight": @2160,
      });
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native capability probe failed.");
    }
  }
}

napi_value ListApplicationsCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 0, &args);
      bool accessibility = AXIsProcessTrusted();
      bool capture = ScreenCapturePermission();
      NSMutableArray* applications = [NSMutableArray array];
      for (NSRunningApplication* application in NSWorkspace.sharedWorkspace.runningApplications) {
        if (application.processIdentifier <= 0 || application.processIdentifier == getpid() || application.isTerminated)
          continue;
        if (IsKestrelBundle(UTF8(application.bundleIdentifier))) continue;
        if (applications.count >= kMaxTreeNodes) break;
        [applications addObject:ApplicationDictionary(application, accessibility, capture)];
      }
      return JSON(env, applications);
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native application listing failed.");
    }
  }
}

napi_value ListWindowsCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 0, &args);
      bool accessibility = AXIsProcessTrusted();
      bool capture = ScreenCapturePermission();
      NSMutableArray* windows = [NSMutableArray array];
      for (const WindowSnapshot& window : EnumerateCGWindows())
        [windows addObject:WindowDictionary(window, accessibility, capture)];
      return JSON(env, windows);
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native window listing failed.");
    }
  }
}

napi_value DescribeWindowCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      if (!args[0]) Fail("invalidRequest", "The native window identifier is missing.");
      double value = RequiredNumber(env, args[0], "windowId");
      if (value < 1 || value > 0x7fffffff) Fail("invalidRequest", "The native window identifier is out of bounds.");
      std::optional<WindowSnapshot> window = FindWindow(static_cast<uint32_t>(value));
      if (!window) Fail("windowDisappeared", "The selected background window no longer exists.");
      return JSON(env, WindowDictionary(window.value(), AXIsProcessTrusted(), ScreenCapturePermission()));
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native window description failed.");
    }
  }
}

napi_value CaptureWindowCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 2, &args);
      double windowNumber = RequiredNumber(env, args[0], "windowId");
      if (windowNumber < 1 || windowNumber > 0x7fffffff)
        Fail("invalidRequest", "The native window identifier is out of bounds.");
      napi_value options = args[1];
      if (!IsObject(env, options)) Fail("invalidRequest", "Capture options must be an object.");
      size_t maxWidth = static_cast<size_t>(RequiredInteger(env, options, "maxWidth", 1, 3840));
      size_t maxHeight = static_cast<size_t>(RequiredInteger(env, options, "maxHeight", 1, 2160));
      SCShareableContent* shareableContent = nil;
      SCWindow* window = ShareableWindow(static_cast<uint32_t>(windowNumber), &shareableContent);
      if (window.owningApplication.processID == FrontmostPID())
        Fail("backgroundUnsafe", "The selected application is foreground; background capture will not inspect it.");
      if (!window.isOnScreen) Fail("captureUnavailable", "The selected window is minimized or not on screen.");
      CGImageRef captured = CaptureImage(window, maxWidth, maxHeight);
      if (!captured) Fail("captureUnavailable", "The selected window returned no image.");
      if (CGImageGetWidth(captured) == 0 || CGImageGetHeight(captured) == 0) {
        CGImageRelease(captured);
        Fail("captureUnavailable", "The selected window returned an empty image.");
      }
      if (IsBlank(captured)) {
        CGImageRelease(captured);
        Fail("protectedContent", "The selected window returned blank protected content.");
      }
      CGImageRef bounded = BoundedImage(captured, maxWidth, maxHeight);
      CGImageRelease(captured);
      NSData* png = EncodePNG(bounded);
      size_t width = CGImageGetWidth(bounded);
      size_t height = CGImageGetHeight(bounded);
      CGImageRelease(bounded);
      napi_value result = nullptr;
      napi_create_object(env, &result);
      napi_value widthValue = nullptr;
      napi_value heightValue = nullptr;
      napi_create_int64(env, static_cast<int64_t>(width), &widthValue);
      napi_create_int64(env, static_cast<int64_t>(height), &heightValue);
      napi_set_named_property(env, result, "width", widthValue);
      napi_set_named_property(env, result, "height", heightValue);
      napi_value buffer = nullptr;
      napi_create_buffer_copy(env, png.length, png.bytes, nullptr, &buffer);
      napi_set_named_property(env, result, "png", buffer);
      return result;
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "captureUnavailable", "The native window capture failed.");
    }
  }
}

napi_value InspectTreeCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      napi_value input = args[0];
      if (!IsObject(env, input)) Fail("invalidRequest", "The Accessibility tree request must be an object.");
      pid_t pid = static_cast<pid_t>(RequiredInteger(env, input, "pid", 1, 10'000'000));
      std::optional<int64_t> windowNumber = OptionalInteger(env, input, "windowId", 1, 0x7fffffff);
      std::optional<uint32_t> windowId = windowNumber ? std::optional<uint32_t>(static_cast<uint32_t>(*windowNumber)) : std::nullopt;
      size_t maxNodes = static_cast<size_t>(OptionalInteger(env, input, "maxNodes", 1, kMaxTreeNodes).value_or(400));
      size_t maxDepth = static_cast<size_t>(OptionalInteger(env, input, "maxDepth", 1, kMaxTreeDepth).value_or(16));
      AXContext context = MakeAXContext(pid, windowId);
      try {
        CollectedTree tree = CollectTree(context, pid, windowId, maxNodes, maxDepth);
        NSDictionary* result = TreeDictionary(tree, pid, windowId);
        ReleaseNodes(&tree.nodes);
        ReleaseAXContext(&context);
        return JSON(env, result);
      } catch (...) {
        ReleaseAXContext(&context);
        throw;
      }
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The Accessibility tree inspection failed.");
    }
  }
}

napi_value ResolveElementCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      napi_value input = args[0];
      if (!IsObject(env, input)) Fail("invalidRequest", "The Accessibility resolve request must be an object.");
      pid_t pid = static_cast<pid_t>(RequiredInteger(env, input, "pid", 1, 10'000'000));
      std::optional<int64_t> windowNumber = OptionalInteger(env, input, "windowId", 1, 0x7fffffff);
      std::optional<uint32_t> windowId = windowNumber ? std::optional<uint32_t>(static_cast<uint32_t>(*windowNumber)) : std::nullopt;
      Selector selector = ParseSelector(env, RequiredObject(env, input, "selector"));
      AXContext context = MakeAXContext(pid, windowId);
      try {
        NodeRecord node = ResolveNodeOwned(env, &context, selector, pid, windowId);
        NSDictionary* result = node.object;
        if (node.element) CFRelease(node.element);
        ReleaseAXContext(&context);
        return JSON(env, result);
      } catch (...) {
        ReleaseAXContext(&context);
        throw;
      }
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The Accessibility element resolution failed.");
    }
  }
}

napi_value PerformActionCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      if (!IsObject(env, args[0])) Fail("invalidRequest", "The Accessibility action request must be an object.");
      return JSON(env, PerformAction(env, args[0]));
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The Accessibility action failed.");
    }
  }
}

napi_value SetValueCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      if (!IsObject(env, args[0])) Fail("invalidRequest", "The Accessibility value request must be an object.");
      return JSON(env, SetValue(env, args[0]));
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The Accessibility value mutation failed.");
    }
  }
}

napi_value ReadValueCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      if (!IsObject(env, args[0])) Fail("invalidRequest", "The Accessibility read request must be an object.");
      return JSON(env, ReadValue(env, args[0]));
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The Accessibility value read failed.");
    }
  }
}

napi_value InvariantCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      if (!IsObject(env, args[0])) Fail("invalidRequest", "The invariant request must be an object.");
      return JSON(env, InvariantState(env, args[0]));
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The invariant sample failed.");
    }
  }
}

napi_value ProbeTargetedEventsCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 1, &args);
      napi_value input = args[0];
      if (!IsObject(env, input)) Fail("invalidRequest", "The targeted-event probe request must be an object.");
      int64_t pid = RequiredInteger(env, input, "pid", 1, 10'000'000);
      std::string eventClass = RequiredString(env, input, "eventClass", 16);
      if (eventClass != "mouse" && eventClass != "keyboard" && eventClass != "scroll")
        Fail("invalidRequest", "The targeted-event class is invalid.");
      if (pid == getpid()) Fail("backgroundUnsafe", "Kestrel cannot probe its own browser as a native target.");
      return JSON(env, @{
        @"state": @"unverified",
        @"eventClass": NSStringFromUTF8(eventClass),
        @"backgroundSafe": @NO,
        @"reason": @"Process-targeted input is disabled until an application-specific live proof exists.",
      });
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The targeted-event probe failed.");
    }
  }
}

napi_value ShutdownCallback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      std::vector<napi_value> args;
      CallArguments(env, info, 0, &args);
      return JSON(env, @{ @"shutdown": @YES });
    } catch (const NativeError& error) {
      return ThrowTyped(env, error.code().c_str(), error.message());
    } catch (...) {
      return ThrowTyped(env, "nativeBridgeUnavailable", "The native bridge could not shut down cleanly.");
    }
  }
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"health", nullptr, HealthCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"capabilities", nullptr, CapabilitiesCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listApplications", nullptr, ListApplicationsCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listWindows", nullptr, ListWindowsCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"describeWindow", nullptr, DescribeWindowCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"captureWindow", nullptr, CaptureWindowCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectAccessibilityTree", nullptr, InspectTreeCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resolveElement", nullptr, ResolveElementCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"performAccessibilityAction", nullptr, PerformActionCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setAccessibilityValue", nullptr, SetValueCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readAccessibilityValue", nullptr, ReadValueCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getInvariantState", nullptr, InvariantCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"probeTargetedEventSupport", nullptr, ProbeTargetedEventsCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"shutdown", nullptr, ShutdownCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
