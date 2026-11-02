#import "native_computer_use.h"

#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <map>
#include <sstream>
#include <vector>

namespace {
constexpr size_t kMaxPngBytes = 700'000;
constexpr size_t kMaxPixels = 8'000'000;
constexpr NSInteger kMaxCaptureWidth = 1280;
constexpr NSInteger kMaxCaptureHeight = 720;
constexpr CFTimeInterval kCaptureMaxAgeSeconds = 30.0;

std::string JsonEscape(const std::string& input) {
  std::string output;
  output.reserve(input.size() + 8);
  for (unsigned char value : input) {
    switch (value) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (value < 0x20) {
          char escaped[7];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", value);
          output += escaped;
        } else {
          output.push_back(static_cast<char>(value));
        }
    }
  }
  return output;
}

std::string Base64(NSData* data) {
  if (!data) return {};
  return std::string([[data base64EncodedStringWithOptions:0] UTF8String] ?: "");
}

bool EncodePng(CGImageRef image, NSData** output) {
  if (!image || !output) return false;
  NSMutableData* data = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, CFSTR("public.png"), 1, nullptr);
  if (!destination) return false;
  CGImageDestinationAddImage(destination, image, nullptr);
  const bool finalized = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  if (!finalized || data.length < 44 || data.length > kMaxPngBytes) return false;
  *output = [data copy];
  return true;
}

bool RectFromWindowInfo(NSDictionary* info, CGRect* bounds) {
  id raw = info[(NSString*)kCGWindowBounds];
  if (![raw isKindOfClass:[NSDictionary class]]) return false;
  CGRect result = CGRectZero;
  if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)raw,
                                               &result)) return false;
  if (!std::isfinite(result.origin.x) || !std::isfinite(result.origin.y) ||
      !std::isfinite(result.size.width) || !std::isfinite(result.size.height) ||
      result.size.width <= 0 || result.size.height <= 0) return false;
  *bounds = result;
  return true;
}

bool NearlyEqual(double left, double right) {
  return std::isfinite(left) && std::isfinite(right) && std::abs(left - right) <= 0.5;
}

bool SameRect(CGRect left, CGRect right) {
  return NearlyEqual(left.origin.x, right.origin.x) &&
         NearlyEqual(left.origin.y, right.origin.y) &&
         NearlyEqual(left.size.width, right.size.width) &&
         NearlyEqual(left.size.height, right.size.height);
}

bool SameIdentity(const NativeComputerUseIdentity& left,
                  const NativeComputerUseIdentity& right) {
  return left.display_id == right.display_id &&
         left.foreground_process_id == right.foreground_process_id &&
         left.frontmost_window_id == right.frontmost_window_id &&
         SameRect(left.logical_bounds, right.logical_bounds) &&
         SameRect(left.frontmost_window_bounds, right.frontmost_window_bounds);
}

bool ReadRect(CefRefPtr<CefDictionaryValue> dictionary, const char* key,
              CGRect* rect) {
  CefRefPtr<CefDictionaryValue> value = dictionary->GetDictionary(key);
  if (!value) return false;
  auto number = [&](const char* field, double* result) {
    if (value->GetType(field) == VTYPE_DOUBLE) *result = value->GetDouble(field);
    else if (value->GetType(field) == VTYPE_INT) *result = value->GetInt(field);
    else return false;
    return std::isfinite(*result);
  };
  double x, y, width, height;
  if (!number("x", &x) || !number("y", &y) || !number("width", &width) || !number("height", &height)) return false;
  *rect = CGRectMake(x, y, width, height);
  return std::isfinite(rect->origin.x) && std::isfinite(rect->origin.y) &&
         std::isfinite(rect->size.width) && std::isfinite(rect->size.height) &&
         rect->size.width > 0 && rect->size.height > 0;
}

bool ReadIdentity(CefRefPtr<CefDictionaryValue> dictionary,
                  NativeComputerUseIdentity* identity) {
  if (!dictionary || !identity ||
      dictionary->GetType("displayId") != VTYPE_INT ||
      dictionary->GetType("foregroundProcessId") != VTYPE_INT ||
      dictionary->GetType("frontmostWindowId") != VTYPE_INT ||
      !ReadRect(dictionary, "logicalBounds", &identity->logical_bounds) ||
      !ReadRect(dictionary, "frontmostWindowBounds",
                &identity->frontmost_window_bounds)) return false;
  const int display = dictionary->GetInt("displayId");
  const int pid = dictionary->GetInt("foregroundProcessId");
  const int window = dictionary->GetInt("frontmostWindowId");
  if (display <= 0 || pid <= 0 || window <= 0) return false;
  identity->display_id = static_cast<uint32_t>(display);
  identity->foreground_process_id = static_cast<pid_t>(pid);
  identity->frontmost_window_id = static_cast<uint32_t>(window);
  return true;
}

std::string Iso8601Now() {
  NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return std::string([[formatter stringFromDate:[NSDate date]] UTF8String] ?: "");
}

bool IsFreshTimestamp(const std::string& value) {
  NSString* text = [NSString stringWithUTF8String:value.c_str()];
  if (!text) return false;
  NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate* date = [formatter dateFromString:text];
  if (!date) {
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    date = [formatter dateFromString:text];
  }
  if (!date) return false;
  const NSTimeInterval age = [[NSDate date] timeIntervalSinceDate:date];
  return age >= -1.0 && age <= kCaptureMaxAgeSeconds;
}

std::string PermissionValue(bool granted) { return granted ? "granted" : "not-granted"; }

NSString* PermissionUrl(const std::string& surface) {
  if (surface == "screen-recording")
    return @"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  if (surface == "accessibility")
    return @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  return nil;
}
}  // namespace

std::string NativeComputerUseService::PermissionStatusJson() {
  if (@available(macOS 14.0, *)) {
    return "{\"screenRecording\":\"" +
           PermissionValue(CGPreflightScreenCaptureAccess()) +
           "\",\"accessibility\":\"" +
           PermissionValue(AXIsProcessTrusted()) + "\"}";
  }
  return "{\"screenRecording\":\"unavailable\",\"accessibility\":\"" +
         PermissionValue(AXIsProcessTrusted()) + "\"}";
}

bool NativeComputerUseService::CurrentIdentity(
    NativeComputerUseIdentity* identity, std::string* error) {
  if (!identity) {
    if (error) *error = "Native desktop identity is unavailable.";
    return false;
  }
  NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (!app || app.processIdentifier <= 0) {
    if (error) *error = "There is no frontmost application to bind desktop input.";
    return false;
  }
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!rawWindows) {
    if (error) *error = "The frontmost desktop window could not be identified.";
    return false;
  }
  NSDictionary* frontmost = nil;
  CGRect windowBounds = CGRectZero;
  const CFIndex count = CFArrayGetCount(rawWindows);
  for (CFIndex index = 0; index < count; ++index) {
    id item = (__bridge id)CFArrayGetValueAtIndex(rawWindows, index);
    if (![item isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary* info = item;
    NSNumber* ownerPid = info[(NSString*)kCGWindowOwnerPID];
    NSNumber* layer = info[(NSString*)kCGWindowLayer];
    NSNumber* windowId = info[(NSString*)kCGWindowNumber];
    if (![ownerPid isKindOfClass:[NSNumber class]] || ownerPid.intValue != app.processIdentifier ||
        ![layer isKindOfClass:[NSNumber class]] || layer.intValue != 0 ||
        ![windowId isKindOfClass:[NSNumber class]] || windowId.unsignedIntValue == 0 ||
        !RectFromWindowInfo(info, &windowBounds)) continue;
    NSNumber* alpha = info[(NSString*)kCGWindowAlpha];
    if ([alpha isKindOfClass:[NSNumber class]] && alpha.doubleValue <= 0.01) continue;
    frontmost = info;
    identity->frontmost_window_id = windowId.unsignedIntValue;
    break;
  }
  CFRelease(rawWindows);
  if (!frontmost) {
    if (error) *error = "The frontmost application has no visible window to bind desktop input.";
    return false;
  }
  identity->foreground_process_id = app.processIdentifier;
  identity->frontmost_window_bounds = windowBounds;

  CGDirectDisplayID selected = kCGNullDirectDisplay;
  const CGPoint center = CGPointMake(CGRectGetMidX(windowBounds), CGRectGetMidY(windowBounds));
  const uint32_t maxDisplays = 32;
  CGDirectDisplayID displays[maxDisplays] = {};
  uint32_t displayCount = maxDisplays;
  if (CGGetOnlineDisplayList(maxDisplays, displays, &displayCount) != kCGErrorSuccess) {
    if (error) *error = "The desktop display could not be identified.";
    return false;
  }
  double bestArea = 0;
  CGRect selectedBounds = CGRectZero;
  for (uint32_t index = 0; index < displayCount; ++index) {
    const CGRect bounds = CGDisplayBounds(displays[index]);
    if (CGRectContainsPoint(bounds, center)) {
      selected = displays[index]; selectedBounds = bounds; break;
    }
    const CGRect intersection = CGRectIntersection(bounds, windowBounds);
    const double area = CGRectIsNull(intersection) ? 0 : intersection.size.width * intersection.size.height;
    if (area > bestArea) { bestArea = area; selected = displays[index]; selectedBounds = bounds; }
  }
  if (selected == kCGNullDirectDisplay || CGRectIsEmpty(selectedBounds)) {
    if (error) *error = "The frontmost window is not on an available display.";
    return false;
  }
  identity->display_id = selected;
  identity->logical_bounds = selectedBounds;
  return true;
}

std::string NativeComputerUseService::IdentityJson(
    const NativeComputerUseIdentity& identity) {
  auto rect = [](CGRect value) {
    return "{\"x\":" + std::to_string(value.origin.x) +
           ",\"y\":" + std::to_string(value.origin.y) +
           ",\"width\":" + std::to_string(value.size.width) +
           ",\"height\":" + std::to_string(value.size.height) + "}";
  };
  return "{\"displayId\":" + std::to_string(identity.display_id) +
         ",\"logicalBounds\":" + rect(identity.logical_bounds) +
         ",\"foregroundProcessId\":" + std::to_string(identity.foreground_process_id) +
         ",\"frontmostWindowId\":" + std::to_string(identity.frontmost_window_id) +
         ",\"frontmostWindowBounds\":" + rect(identity.frontmost_window_bounds) + "}";
}

void NativeComputerUseService::Capture(CaptureCompletion completion) {
  if (!completion) return;
  if (@available(macOS 14.0, *)) {
    if (!CGPreflightScreenCaptureAccess()) {
      completion(false, "macOS Screen Recording permission is not granted.", "");
      return;
    }
    NativeComputerUseIdentity before;
    std::string identityError;
    if (!CurrentIdentity(&before, &identityError)) {
      completion(false, identityError, "");
      return;
    }
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                onScreenWindowsOnly:YES
                                                  completionHandler:^(SCShareableContent* content, NSError* error) {
      if (error || !content) { completion(false, "ScreenCaptureKit could not enumerate the desktop.", ""); return; }
      SCDisplay* selected = nil;
      for (SCDisplay* display in content.displays) {
        if (display.displayID == before.display_id) { selected = display; break; }
      }
      if (!selected) { completion(false, "The selected desktop display is unavailable.", ""); return; }
      SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
      SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
      const double scale = std::min({1.0, static_cast<double>(kMaxCaptureWidth) / std::max<NSInteger>(1, selected.width), static_cast<double>(kMaxCaptureHeight) / std::max<NSInteger>(1, selected.height)});
      configuration.width = std::max<NSInteger>(1, static_cast<NSInteger>(std::floor(selected.width * scale)));
      configuration.height = std::max<NSInteger>(1, static_cast<NSInteger>(std::floor(selected.height * scale)));
      configuration.capturesAudio = NO;
      configuration.showsCursor = YES;
      [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError* captureError) {
        if (captureError || !image) { completion(false, "ScreenCaptureKit could not capture the selected display.", ""); return; }
        NativeComputerUseIdentity after;
        std::string afterError;
        if (!CGPreflightScreenCaptureAccess() || !CurrentIdentity(&after, &afterError) || !SameIdentity(before, after)) {
          completion(false, "The foreground application or display changed during capture. Take a fresh screenshot.", ""); return;
        }
        const size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
        if (!width || !height || width > 4'096 || height > 4'096 || width * height > kMaxPixels) {
          completion(false, "The desktop screenshot exceeded supported dimensions.", ""); return;
        }
        NSData* png = nil;
        if (!EncodePng(image, &png)) {
          completion(false, "The desktop screenshot exceeded the private transport limit.", ""); return;
        }
        const std::string base64 = Base64(png);
        if (base64.size() > kMaxPngBytes) {
          completion(false, "The desktop screenshot exceeded the private transport limit.", ""); return;
        }
        const std::string json = "{\"version\":1,\"encoding\":\"png\",\"width\":" +
            std::to_string(width) + ",\"height\":" + std::to_string(height) +
            ",\"pngBase64\":\"" + base64 + "\",\"capturedAt\":\"" +
            JsonEscape(Iso8601Now()) + "\"," + IdentityJson(after).substr(1);
        completion(true, "", json);
      }];
    }];
  } else {
    completion(false, "Whole-desktop capture requires macOS 14 or newer.", "");
  }
}

bool NativeComputerUseService::Act(CefRefPtr<CefDictionaryValue> request,
                                   std::string* error,
                                   ContinueCheck should_continue) {
  auto fail = [&](const char* message) { if (error) *error = message; return false; };
  auto can_continue = [&]() {
    return request && request->GetType("enabled") == VTYPE_BOOL &&
        request->GetBool("enabled") && request->GetType("enablementGeneration") == VTYPE_INT &&
        request->GetInt("enablementGeneration") > 0 && (!should_continue || should_continue());
  };
  bool submitted = false;
  auto interrupted = [&]() {
    if (error) *error = submitted ? "UNCERTAIN:Desktop action was interrupted after input may have been submitted." : "Desktop action was cancelled before input was submitted.";
    return false;
  };
  if (!can_continue()) return interrupted();
  if (!request || !CGPreflightScreenCaptureAccess()) return fail("macOS Screen Recording permission is not granted.");
  if (!AXIsProcessTrusted()) return fail("macOS Accessibility permission is not granted.");
  const std::string capture_id = request->GetString("captureId").ToString();
  const std::string captured_at = request->GetString("capturedAt").ToString();
  if (capture_id.empty() || !IsFreshTimestamp(captured_at)) return fail("The desktop capture is missing or expired. Take a fresh screenshot.");
  const int width = request->GetInt("width"), height = request->GetInt("height");
  if (width <= 0 || height <= 0 || width > 4'096 || height > 4'096 ||
      static_cast<uint64_t>(width) * static_cast<uint64_t>(height) > kMaxPixels) return fail("The desktop capture dimensions are invalid.");
  NativeComputerUseIdentity expected;
  if (!ReadIdentity(request->GetDictionary("identity"), &expected)) return fail("The desktop capture identity is invalid.");
  NativeComputerUseIdentity current;
  std::string currentError;
  if (!CurrentIdentity(&current, &currentError) || !SameIdentity(expected, current)) return fail("The foreground application, window, or display changed since capture. Take a fresh screenshot.");
  CefRefPtr<CefDictionaryValue> action = request->GetDictionary("action");
  if (!action || action->GetType("type") != VTYPE_STRING) return fail("The desktop action is invalid.");
  const std::string type = action->GetString("type").ToString();
  if (type == "click") {
    if (action->GetType("x") != VTYPE_INT || action->GetType("y") != VTYPE_INT) return fail("The desktop click coordinates are invalid.");
    const int x = action->GetInt("x"), y = action->GetInt("y");
    if (x < 0 || y < 0 || x >= width || y >= height) return fail("Desktop click coordinates must be inside the captured display image.");
    const CGPoint point = CGPointMake(expected.logical_bounds.origin.x +
        static_cast<double>(x) * expected.logical_bounds.size.width / width,
        expected.logical_bounds.origin.y +
        static_cast<double>(y) * expected.logical_bounds.size.height / height);
    CGEventRef move = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, point, kCGMouseButtonLeft);
    CGEventRef down = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
    if (!move || !down || !up) { if (move) CFRelease(move); if (down) CFRelease(down); if (up) CFRelease(up); return fail("The desktop click could not be prepared."); }
    NativeComputerUseIdentity finalIdentity;
    std::string finalError;
    if (!can_continue() || !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() ||
        !CurrentIdentity(&finalIdentity, &finalError) || !SameIdentity(expected, finalIdentity)) {
      CFRelease(move); CFRelease(down); CFRelease(up);
      return fail("Desktop permissions or foreground identity changed before action submission.");
    }
    if (!can_continue()) { CFRelease(move); CFRelease(down); CFRelease(up); return interrupted(); }
    CGEventPost(kCGHIDEventTap, move); submitted = true; CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
    CFRelease(move); CFRelease(down); CFRelease(up);
    return true;
  }
  if (type == "key") {
    if (action->GetType("key") != VTYPE_STRING) return fail("The desktop key action is invalid.");
    const std::string key = action->GetString("key").ToString();
    static const std::map<std::string, CGKeyCode> keys = {
        {"Enter", 36}, {"Escape", 53}, {"Tab", 48}, {"Backspace", 51},
        {"ArrowUp", 126}, {"ArrowDown", 125}, {"ArrowLeft", 123}, {"ArrowRight", 124}};
    const auto found = keys.find(key);
    if (found == keys.end()) return fail("The desktop key is not allowlisted.");
    CGEventRef down = CGEventCreateKeyboardEvent(nullptr, found->second, true);
    CGEventRef up = CGEventCreateKeyboardEvent(nullptr, found->second, false);
    if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); return fail("The desktop key action could not be prepared."); }
    NativeComputerUseIdentity finalIdentity;
    std::string finalError;
    if (!can_continue() || !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() ||
        !CurrentIdentity(&finalIdentity, &finalError) || !SameIdentity(expected, finalIdentity)) {
      CFRelease(down); CFRelease(up);
      return fail("Desktop permissions or foreground identity changed before action submission.");
    }
    if (!can_continue()) { CFRelease(down); CFRelease(up); return interrupted(); }
    CGEventPost(kCGHIDEventTap, down); submitted = true; CGEventPost(kCGHIDEventTap, up);
    CFRelease(down); CFRelease(up);
    return true;
  }
  if (type == "type") {
    if (action->GetType("text") != VTYPE_STRING) return fail("The desktop text action is invalid.");
    NSString* text = [NSString stringWithUTF8String:action->GetString("text").ToString().c_str()];
    if (!text || text.length == 0 || text.length > 20'000) return fail("Desktop typing is limited to 20,000 characters.");
    std::vector<UniChar> characters(text.length);
    [text getCharacters:characters.data() range:NSMakeRange(0, text.length)];
    NativeComputerUseIdentity finalIdentity;
    std::string finalError;
    if (!CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() ||
        !CurrentIdentity(&finalIdentity, &finalError) || !SameIdentity(expected, finalIdentity))
      return fail("Desktop permissions or foreground identity changed before action submission.");
    for (NSUInteger offset = 0; offset < characters.size();) {
      NSUInteger count = std::min<NSUInteger>(32, characters.size() - offset);
      if (offset + count < characters.size() && count > 1 &&
          characters[offset + count - 1] >= 0xD800 && characters[offset + count - 1] <= 0xDBFF) --count;
      CGEventRef event = CGEventCreateKeyboardEvent(nullptr, 0, true);
      CGEventRef release = CGEventCreateKeyboardEvent(nullptr, 0, false);
      if (!event || !release) { if (event) CFRelease(event); if (release) CFRelease(release); return submitted ? interrupted() : fail("The desktop text action could not be prepared."); }
      CGEventKeyboardSetUnicodeString(event, count, characters.data() + offset);
      NativeComputerUseIdentity chunkIdentity;
      std::string chunkError;
      if (!can_continue() || !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() ||
          !CurrentIdentity(&chunkIdentity, &chunkError) || !SameIdentity(expected, chunkIdentity)) {
        CFRelease(event); CFRelease(release); return interrupted();
      }
      CGEventPost(kCGHIDEventTap, event); submitted = true; CGEventPost(kCGHIDEventTap, release);
      CFRelease(event); CFRelease(release);
      offset += count;
    }
    return true;
  }
  return fail("The desktop action type is not supported.");
}

bool NativeComputerUseService::OpenSettings(const std::string& surface,
                                            std::string* error) {
  NSString* value = PermissionUrl(surface);
  if (!value) { if (error) *error = "The requested macOS permission surface is unavailable."; return false; }
  NSURL* url = [NSURL URLWithString:value];
  if (!url || ![[NSWorkspace sharedWorkspace] openURL:url]) {
    if (error) *error = "macOS Privacy & Security settings could not be opened.";
    return false;
  }
  return true;
}
