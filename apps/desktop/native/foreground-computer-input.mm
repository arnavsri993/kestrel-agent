// Kestrel foreground computer input
//
// Posts bounded input only after the requested application and window are
// confirmed to be the current foreground target. Delivery cannot be observed
// through CGEventPost, so successful results are intentionally "unverified".

#define NAPI_VERSION 8

#include <node_api.h>

#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <Carbon/Carbon.h>
#include <CoreGraphics/CoreGraphics.h>
#include <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

constexpr size_t kMaxOperationIdLength = 128;
constexpr size_t kMaxBundleIdLength = 255;
constexpr size_t kMaxTextLength = 4096;
constexpr double kMaxCoordinate = 100000.0;
constexpr double kMaxDimension = 100000.0;
constexpr int32_t kMaxScrollDelta = 10000;
constexpr int64_t kMaxDragDurationMs = 10000;
constexpr double kBoundsTolerance = 1.0;

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

bool IsObject(napi_env env, napi_value value) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object;
}

napi_value GetNamed(napi_env env, napi_value object, const char* name,
                    bool* present = nullptr) {
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok)
    Fail("invalidRequest", "The native bridge could not inspect the request.");
  if (present) *present = has;
  if (!has) return nullptr;
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok)
    Fail("invalidRequest", "The native bridge could not read the request.");
  return value;
}

std::string StringValue(napi_env env, napi_value value, const char* name,
                        size_t maxLength) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
    Fail("invalidRequest", std::string(name) + " must be a string.");
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > maxLength)
    Fail("invalidRequest", std::string(name) + " is empty or too long.");
  std::string result(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, result.data(), length + 1,
                                 &length) != napi_ok)
    Fail("invalidRequest", std::string(name) + " is not valid UTF-8.");
  result.resize(length);
  return result;
}

std::string RequiredString(napi_env env, napi_value object, const char* name,
                           size_t maxLength) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) Fail("invalidRequest", std::string("Missing ") + name + ".");
  return StringValue(env, value, name, maxLength);
}

double RequiredNumber(napi_env env, napi_value object, const char* name,
                      double minimum, double maximum, bool integer = false) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) Fail("invalidRequest", std::string("Missing ") + name + ".");
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number < minimum || number > maximum ||
      (integer && std::trunc(number) != number))
    Fail("invalidRequest", std::string(name) + " is out of bounds.");
  return number;
}

double OptionalNumber(napi_env env, napi_value object, const char* name,
                      double fallback, double minimum, double maximum,
                      bool integer = false) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) return fallback;
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number < minimum || number > maximum ||
      (integer && std::trunc(number) != number))
    Fail("invalidRequest", std::string(name) + " is out of bounds.");
  return number;
}

napi_value RequiredObject(napi_env env, napi_value object, const char* name) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present || !IsObject(env, value))
    Fail("invalidRequest", std::string(name) + " must be an object.");
  return value;
}

std::vector<std::string> OptionalStringArray(napi_env env, napi_value object,
                                             const char* name) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) return {};
  bool isArray = false;
  if (napi_is_array(env, value, &isArray) != napi_ok || !isArray)
    Fail("invalidRequest", std::string(name) + " must be an array.");
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok || length > 5)
    Fail("invalidRequest", std::string(name) + " has too many entries.");
  std::vector<std::string> result;
  std::unordered_set<std::string> seen;
  for (uint32_t index = 0; index < length; index++) {
    napi_value item = nullptr;
    if (napi_get_element(env, value, index, &item) != napi_ok)
      Fail("invalidRequest", "A modifier could not be read.");
    std::string modifier = StringValue(env, item, "modifier", 16);
    if (!seen.insert(modifier).second)
      Fail("invalidRequest", "Modifiers must not be repeated.");
    result.push_back(std::move(modifier));
  }
  return result;
}

struct Target {
  pid_t pid = 0;
  uint32_t windowId = 0;
  std::string bundleId;
  CGRect expectedBounds = CGRectZero;
};

enum class ActionKind { Activate, Click, Drag, Scroll, Type, Key };

struct Request {
  std::string operationId;
  Target target;
  ActionKind kind = ActionKind::Click;
  CGPoint start = CGPointZero;
  CGPoint end = CGPointZero;
  CGMouseButton button = kCGMouseButtonLeft;
  int clickCount = 1;
  int64_t durationMs = 350;
  int32_t deltaX = 0;
  int32_t deltaY = 0;
  std::u16string text;
  std::string key;
  CGEventFlags flags = 0;
};

CGPoint ParsePoint(napi_env env, napi_value object, const char* name) {
  napi_value point = RequiredObject(env, object, name);
  return CGPointMake(
      RequiredNumber(env, point, "x", -kMaxCoordinate, kMaxCoordinate),
      RequiredNumber(env, point, "y", -kMaxCoordinate, kMaxCoordinate));
}

CGMouseButton ParseButton(const std::string& value) {
  if (value == "left") return kCGMouseButtonLeft;
  if (value == "right") return kCGMouseButtonRight;
  if (value == "middle") return kCGMouseButtonCenter;
  Fail("invalidRequest", "button must be left, right, or middle.");
}

CGEventFlags ParseModifiers(const std::vector<std::string>& modifiers) {
  CGEventFlags flags = 0;
  for (const std::string& modifier : modifiers) {
    if (modifier == "command") flags |= kCGEventFlagMaskCommand;
    else if (modifier == "control") flags |= kCGEventFlagMaskControl;
    else if (modifier == "option") flags |= kCGEventFlagMaskAlternate;
    else if (modifier == "shift") flags |= kCGEventFlagMaskShift;
    else if (modifier == "function") flags |= kCGEventFlagMaskSecondaryFn;
    else Fail("invalidRequest", "A modifier name is unsupported.");
  }
  return flags;
}

std::u16string ParseUTF16(napi_env env, napi_value object, const char* name) {
  bool present = false;
  napi_value value = GetNamed(env, object, name, &present);
  if (!present) Fail("invalidRequest", std::string("Missing ") + name + ".");
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
    Fail("invalidRequest", std::string(name) + " must be a string.");
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > kMaxTextLength)
    Fail("invalidRequest", std::string(name) + " is empty or too long.");
  std::u16string result(length + 1, u'\0');
  if (napi_get_value_string_utf16(env, value,
                                  reinterpret_cast<char16_t*>(result.data()),
                                  length + 1, &length) != napi_ok)
    Fail("invalidRequest", std::string(name) + " is not valid text.");
  result.resize(length);
  return result;
}

Request ParseRequest(napi_env env, napi_value input) {
  if (!IsObject(env, input)) Fail("invalidRequest", "The request must be an object.");
  Request request;
  request.operationId = RequiredString(env, input, "operationId", kMaxOperationIdLength);
  napi_value target = RequiredObject(env, input, "target");
  request.target.pid = static_cast<pid_t>(RequiredNumber(env, target, "pid", 1, 10000000, true));
  request.target.windowId = static_cast<uint32_t>(RequiredNumber(env, target, "windowId", 1, INT32_MAX, true));
  request.target.bundleId = RequiredString(env, target, "bundleId", kMaxBundleIdLength);
  napi_value bounds = RequiredObject(env, target, "bounds");
  request.target.expectedBounds = CGRectMake(
      RequiredNumber(env, bounds, "x", -kMaxCoordinate, kMaxCoordinate),
      RequiredNumber(env, bounds, "y", -kMaxCoordinate, kMaxCoordinate),
      RequiredNumber(env, bounds, "width", 1, kMaxDimension),
      RequiredNumber(env, bounds, "height", 1, kMaxDimension));

  napi_value action = RequiredObject(env, input, "action");
  std::string type = RequiredString(env, action, "type", 16);
  if (type == "activate") {
    request.kind = ActionKind::Activate;
  } else if (type == "click") {
    request.kind = ActionKind::Click;
    request.start = ParsePoint(env, action, "point");
    bool hasButton = false;
    napi_value button = GetNamed(env, action, "button", &hasButton);
    request.button = ParseButton(hasButton ? StringValue(env, button, "button", 8) : "left");
    request.clickCount = static_cast<int>(OptionalNumber(env, action, "clickCount", 1, 1, 3, true));
  } else if (type == "drag") {
    request.kind = ActionKind::Drag;
    request.start = ParsePoint(env, action, "from");
    request.end = ParsePoint(env, action, "to");
    request.durationMs = static_cast<int64_t>(OptionalNumber(
        env, action, "durationMs", 350, 0, kMaxDragDurationMs, true));
    bool hasButton = false;
    napi_value button = GetNamed(env, action, "button", &hasButton);
    request.button = ParseButton(hasButton ? StringValue(env, button, "button", 8) : "left");
  } else if (type == "scroll") {
    request.kind = ActionKind::Scroll;
    bool hasPoint = false;
    GetNamed(env, action, "point", &hasPoint);
    request.start = hasPoint ? ParsePoint(env, action, "point")
                             : CGPointMake(CGRectGetMidX(request.target.expectedBounds),
                                           CGRectGetMidY(request.target.expectedBounds));
    request.deltaX = static_cast<int32_t>(RequiredNumber(
        env, action, "deltaX", -kMaxScrollDelta, kMaxScrollDelta, true));
    request.deltaY = static_cast<int32_t>(RequiredNumber(
        env, action, "deltaY", -kMaxScrollDelta, kMaxScrollDelta, true));
    if (request.deltaX == 0 && request.deltaY == 0)
      Fail("invalidRequest", "At least one scroll delta must be nonzero.");
  } else if (type == "type") {
    request.kind = ActionKind::Type;
    request.text = ParseUTF16(env, action, "text");
  } else if (type == "key") {
    request.kind = ActionKind::Key;
    request.key = RequiredString(env, action, "key", 32);
    request.flags = ParseModifiers(OptionalStringArray(env, action, "modifiers"));
  } else {
    Fail("invalidRequest", "The foreground input action is unsupported.");
  }
  return request;
}

bool Near(double first, double second) {
  return std::abs(first - second) <= kBoundsTolerance;
}

bool BoundsMatch(CGRect first, CGRect second) {
  return Near(first.origin.x, second.origin.x) &&
         Near(first.origin.y, second.origin.y) &&
         Near(first.size.width, second.size.width) &&
         Near(first.size.height, second.size.height);
}

bool PointInBounds(CGPoint point, CGRect bounds) {
  return point.x >= CGRectGetMinX(bounds) && point.x <= CGRectGetMaxX(bounds) &&
         point.y >= CGRectGetMinY(bounds) && point.y <= CGRectGetMaxY(bounds);
}

bool DictionaryInt(CFDictionaryRef dictionary, CFStringRef key, int64_t* output) {
  if (!dictionary || !output) return false;
  CFNumberRef number = static_cast<CFNumberRef>(CFDictionaryGetValue(dictionary, key));
  return number && CFGetTypeID(number) == CFNumberGetTypeID() &&
         CFNumberGetValue(number, kCFNumberSInt64Type, output);
}

void ValidateTarget(const Target& target, bool requireForeground = true) {
  if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess())
    Fail("permissionDenied", "Accessibility permission is required to post foreground input.");
  NSRunningApplication* application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:target.pid];
  if (!application || application.terminated)
    Fail("targetUnavailable", "The target application is no longer running.");
  std::string actualBundle = application.bundleIdentifier.UTF8String ?: "";
  if (actualBundle != target.bundleId)
    Fail("targetChanged", "The target PID no longer belongs to the expected application.");
  NSRunningApplication* frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (requireForeground && (!frontmost || frontmost.processIdentifier != target.pid))
    Fail("foregroundChanged", "The expected application is no longer foreground.");

  CFArrayRef raw = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!raw) Fail("targetUnavailable", "macOS did not return the visible window list.");
  bool found = false;
  bool topmostOwnedWindow = false;
  CGRect actualBounds = CGRectZero;
  CFIndex count = CFArrayGetCount(raw);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef dictionary = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(raw, index));
    int64_t pid = 0, windowId = 0, layer = 0;
    if (!DictionaryInt(dictionary, kCGWindowOwnerPID, &pid) ||
        !DictionaryInt(dictionary, kCGWindowNumber, &windowId) || pid != target.pid)
      continue;
    DictionaryInt(dictionary, kCGWindowLayer, &layer);
    if (layer != 0) continue;
    if (!topmostOwnedWindow) {
      topmostOwnedWindow = true;
      if (static_cast<uint32_t>(windowId) != target.windowId) {
        CFRelease(raw);
        Fail("foregroundWindowChanged", "A different target window is now foreground.");
      }
    }
    if (static_cast<uint32_t>(windowId) == target.windowId) {
      CFDictionaryRef bounds = static_cast<CFDictionaryRef>(
          CFDictionaryGetValue(dictionary, kCGWindowBounds));
      found = bounds && CGRectMakeWithDictionaryRepresentation(bounds, &actualBounds);
      break;
    }
  }
  CFRelease(raw);
  if (!found) Fail("targetUnavailable", "The expected foreground window is no longer visible.");
  if (!BoundsMatch(actualBounds, target.expectedBounds))
    Fail("staleTarget", "The foreground window moved or resized after it was selected.");
}

void ValidatePointHitTarget(const Target& target, CGPoint point) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!windows) Fail("targetUnavailable", "macOS did not return the visible window list.");
  bool found = false;
  uint32_t hitWindowId = 0;
  const CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, index));
    int64_t windowId = 0;
    if (!DictionaryInt(window, kCGWindowNumber, &windowId)) continue;
    CFDictionaryRef bounds = static_cast<CFDictionaryRef>(
        CFDictionaryGetValue(window, kCGWindowBounds));
    CGRect frame = CGRectZero;
    if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, &frame) ||
        !CGRectContainsPoint(frame, point)) continue;
    CFNumberRef alpha = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowAlpha));
    double opacity = 1.0;
    if (alpha && CFGetTypeID(alpha) == CFNumberGetTypeID())
      CFNumberGetValue(alpha, kCFNumberDoubleType, &opacity);
    if (opacity <= 0.01) continue;
    hitWindowId = static_cast<uint32_t>(windowId);
    found = true;
    break;
  }
  CFRelease(windows);
  if (!found || hitWindowId != target.windowId)
    Fail("targetChanged", "Another visible window covers the requested input point.");
}

CGEventType MouseDownType(CGMouseButton button) {
  return button == kCGMouseButtonRight ? kCGEventRightMouseDown
       : button == kCGMouseButtonCenter ? kCGEventOtherMouseDown
                                        : kCGEventLeftMouseDown;
}

CGEventType MouseUpType(CGMouseButton button) {
  return button == kCGMouseButtonRight ? kCGEventRightMouseUp
       : button == kCGMouseButtonCenter ? kCGEventOtherMouseUp
                                        : kCGEventLeftMouseUp;
}

CGEventType MouseDragType(CGMouseButton button) {
  return button == kCGMouseButtonRight ? kCGEventRightMouseDragged
       : button == kCGMouseButtonCenter ? kCGEventOtherMouseDragged
                                        : kCGEventLeftMouseDragged;
}

void PostMouse(CGEventType type, CGPoint point, CGMouseButton button,
               int clickCount, size_t* eventCount) {
  CGEventRef event = CGEventCreateMouseEvent(nullptr, type, point, button);
  if (!event) Fail("eventCreationFailed", "macOS could not create a mouse event.");
  if (clickCount > 0)
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickCount);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  (*eventCount)++;
}

void PostKey(CGKeyCode code, bool down, CGEventFlags flags, size_t* eventCount,
             const UniChar* text = nullptr, size_t textLength = 0) {
  CGEventRef event = CGEventCreateKeyboardEvent(nullptr, code, down);
  if (!event) Fail("eventCreationFailed", "macOS could not create a keyboard event.");
  CGEventSetFlags(event, flags);
  if (text && textLength > 0)
    CGEventKeyboardSetUnicodeString(event, textLength, text);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  (*eventCount)++;
}

std::optional<CGKeyCode> NamedKeyCode(const std::string& key) {
  static const std::unordered_map<std::string, CGKeyCode> keys = {
      {"a", kVK_ANSI_A}, {"b", kVK_ANSI_B}, {"c", kVK_ANSI_C},
      {"d", kVK_ANSI_D}, {"e", kVK_ANSI_E}, {"f", kVK_ANSI_F},
      {"g", kVK_ANSI_G}, {"h", kVK_ANSI_H}, {"i", kVK_ANSI_I},
      {"j", kVK_ANSI_J}, {"k", kVK_ANSI_K}, {"l", kVK_ANSI_L},
      {"m", kVK_ANSI_M}, {"n", kVK_ANSI_N}, {"o", kVK_ANSI_O},
      {"p", kVK_ANSI_P}, {"q", kVK_ANSI_Q}, {"r", kVK_ANSI_R},
      {"s", kVK_ANSI_S}, {"t", kVK_ANSI_T}, {"u", kVK_ANSI_U},
      {"v", kVK_ANSI_V}, {"w", kVK_ANSI_W}, {"x", kVK_ANSI_X},
      {"y", kVK_ANSI_Y}, {"z", kVK_ANSI_Z},
      {"0", kVK_ANSI_0}, {"1", kVK_ANSI_1}, {"2", kVK_ANSI_2},
      {"3", kVK_ANSI_3}, {"4", kVK_ANSI_4}, {"5", kVK_ANSI_5},
      {"6", kVK_ANSI_6}, {"7", kVK_ANSI_7}, {"8", kVK_ANSI_8},
      {"9", kVK_ANSI_9},
      {"space", kVK_Space}, {"tab", kVK_Tab}, {"enter", kVK_Return},
      {"return", kVK_Return}, {"escape", kVK_Escape}, {"backspace", kVK_Delete},
      {"delete", kVK_Delete}, {"forwardDelete", kVK_ForwardDelete},
      {"left", kVK_LeftArrow}, {"right", kVK_RightArrow},
      {"up", kVK_UpArrow}, {"down", kVK_DownArrow},
      {"home", kVK_Home}, {"end", kVK_End},
      {"pageUp", kVK_PageUp}, {"pageDown", kVK_PageDown},
      {"f1", kVK_F1}, {"f2", kVK_F2}, {"f3", kVK_F3}, {"f4", kVK_F4},
      {"f5", kVK_F5}, {"f6", kVK_F6}, {"f7", kVK_F7}, {"f8", kVK_F8},
      {"f9", kVK_F9}, {"f10", kVK_F10}, {"f11", kVK_F11}, {"f12", kVK_F12},
      {"f13", kVK_F13}, {"f14", kVK_F14}, {"f15", kVK_F15},
      {"f16", kVK_F16}, {"f17", kVK_F17}, {"f18", kVK_F18},
      {"f19", kVK_F19}, {"f20", kVK_F20},
      {"minus", kVK_ANSI_Minus}, {"equal", kVK_ANSI_Equal},
      {"comma", kVK_ANSI_Comma}, {"period", kVK_ANSI_Period},
      {"slash", kVK_ANSI_Slash}, {"semicolon", kVK_ANSI_Semicolon},
      {"quote", kVK_ANSI_Quote}, {"backslash", kVK_ANSI_Backslash},
      {"leftBracket", kVK_ANSI_LeftBracket}, {"rightBracket", kVK_ANSI_RightBracket},
      {"grave", kVK_ANSI_Grave},
  };
  auto found = keys.find(key);
  return found == keys.end() ? std::nullopt : std::optional<CGKeyCode>(found->second);
}

struct ActionResult {
  std::string outcome = "sent";
  std::string delivery = "unverified";
  std::string targetState = "retained";
  size_t eventsPosted = 0;
  std::string reason;
};

bool CheckCancelled(const std::shared_ptr<std::atomic_bool>& cancelled,
                    ActionResult* result) {
  if (!cancelled->load(std::memory_order_relaxed)) return false;
  result->outcome = "cancelled";
  result->delivery = result->eventsPosted == 0 ? "not-sent" : "partial";
  result->reason = result->eventsPosted == 0
      ? "Cancelled before an input event was posted."
      : "Cancelled after one or more input events were posted.";
  return true;
}

void ValidateActionPoints(const Request& request) {
  if (request.kind == ActionKind::Click &&
      !PointInBounds(request.start, request.target.expectedBounds))
    Fail("invalidRequest", "The click point is outside the expected window bounds.");
  if (request.kind == ActionKind::Drag &&
      (!PointInBounds(request.start, request.target.expectedBounds) ||
       !PointInBounds(request.end, request.target.expectedBounds)))
    Fail("invalidRequest", "The drag path endpoints must be inside the expected window bounds.");
  if (request.kind == ActionKind::Scroll &&
      !PointInBounds(request.start, request.target.expectedBounds))
    Fail("invalidRequest", "The scroll point is outside the expected window bounds.");
}

ActionResult ExecuteAction(const Request& request,
                           const std::shared_ptr<std::atomic_bool>& cancelled) {
  ActionResult result;
  ValidateActionPoints(request);
  if (CheckCancelled(cancelled, &result)) return result;
  ValidateTarget(request.target, request.kind != ActionKind::Activate);

  bool mouseDown = false;
  CGPoint currentPoint = request.start;
  try {
    if (request.kind == ActionKind::Activate) {
      NSRunningApplication* application =
          [NSRunningApplication runningApplicationWithProcessIdentifier:request.target.pid];
      if (!application || ![application activateWithOptions:NSApplicationActivateIgnoringOtherApps])
        Fail("targetUnavailable", "macOS could not activate the requested application.");
      bool activated = false;
      for (int attempt = 0; attempt < 20; attempt++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        try {
          ValidateTarget(request.target);
          activated = true;
          break;
        } catch (const NativeError& error) {
          if (error.code() != "foregroundChanged") throw;
        }
      }
      if (!activated) Fail("foregroundChanged", "The requested application did not become foreground.");
    } else if (request.kind == ActionKind::Click) {
      for (int click = 1; click <= request.clickCount; click++) {
        if (CheckCancelled(cancelled, &result)) break;
        ValidateTarget(request.target);
        ValidatePointHitTarget(request.target, request.start);
        PostMouse(MouseDownType(request.button), request.start, request.button,
                  click, &result.eventsPosted);
        mouseDown = true;
        PostMouse(MouseUpType(request.button), request.start, request.button,
                  click, &result.eventsPosted);
        mouseDown = false;
        if (click < request.clickCount)
          std::this_thread::sleep_for(std::chrono::milliseconds(40));
      }
    } else if (request.kind == ActionKind::Drag) {
      ValidatePointHitTarget(request.target, request.start);
      PostMouse(MouseDownType(request.button), request.start, request.button, 1,
                &result.eventsPosted);
      mouseDown = true;
      int steps = std::clamp(static_cast<int>(request.durationMs / 16), 1, 600);
      for (int step = 1; step <= steps; step++) {
        if (CheckCancelled(cancelled, &result)) break;
        ValidateTarget(request.target);
        double progress = static_cast<double>(step) / steps;
        currentPoint = CGPointMake(
            request.start.x + (request.end.x - request.start.x) * progress,
            request.start.y + (request.end.y - request.start.y) * progress);
        ValidatePointHitTarget(request.target, currentPoint);
        PostMouse(MouseDragType(request.button), currentPoint, request.button, 1,
                  &result.eventsPosted);
        if (request.durationMs > 0)
          std::this_thread::sleep_for(
              std::chrono::milliseconds(request.durationMs / steps));
      }
      PostMouse(MouseUpType(request.button), currentPoint, request.button, 1,
                &result.eventsPosted);
      mouseDown = false;
    } else if (request.kind == ActionKind::Scroll) {
      if (!CheckCancelled(cancelled, &result)) {
        ValidateTarget(request.target);
        ValidatePointHitTarget(request.target, request.start);
        CGEventRef event = CGEventCreateScrollWheelEvent(
            nullptr, kCGScrollEventUnitPixel, 2, request.deltaY, request.deltaX);
        if (!event) Fail("eventCreationFailed", "macOS could not create a scroll event.");
        CGEventSetLocation(event, request.start);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
        result.eventsPosted++;
      }
    } else if (request.kind == ActionKind::Type) {
      size_t offset = 0;
      while (offset < request.text.size()) {
        if (CheckCancelled(cancelled, &result)) break;
        ValidateTarget(request.target);
        size_t length = std::min<size_t>(16, request.text.size() - offset);
        if (offset + length < request.text.size() && length > 0) {
          char16_t tail = request.text[offset + length - 1];
          if (tail >= 0xD800 && tail <= 0xDBFF) length--;
        }
        if (length == 0) length = std::min<size_t>(2, request.text.size() - offset);
        const UniChar* characters = reinterpret_cast<const UniChar*>(request.text.data() + offset);
        PostKey(0, true, 0, &result.eventsPosted, characters, length);
        PostKey(0, false, 0, &result.eventsPosted, characters, length);
        offset += length;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      }
    } else if (request.kind == ActionKind::Key) {
      std::optional<CGKeyCode> code = NamedKeyCode(request.key);
      if (!code) Fail("unsupportedKey", "The requested named key is unsupported.");
      if (!CheckCancelled(cancelled, &result)) {
        ValidateTarget(request.target);
        PostKey(*code, true, request.flags, &result.eventsPosted);
        PostKey(*code, false, request.flags, &result.eventsPosted);
      }
    }
  } catch (const NativeError& error) {
    if (mouseDown) {
      PostMouse(MouseUpType(request.button), currentPoint, request.button, 1,
                &result.eventsPosted);
      mouseDown = false;
    }
    if (result.eventsPosted == 0) throw;
    result.outcome = "interrupted";
    result.delivery = "partial";
    result.targetState = "changed";
    result.reason = error.message();
    return result;
  }

  if (result.eventsPosted > 0 && result.outcome == "sent") {
    try {
      ValidateTarget(request.target);
    } catch (const NativeError& error) {
      result.targetState = "changed";
      result.reason = "Input events were posted, but " + error.message();
    }
  }
  return result;
}

struct Work {
  napi_env env = nullptr;
  napi_async_work async = nullptr;
  napi_deferred deferred = nullptr;
  Request request;
  std::shared_ptr<std::atomic_bool> cancelled;
  ActionResult result;
  std::string errorCode;
  std::string errorMessage;
};

std::mutex gOperationsMutex;
std::unordered_map<std::string, std::weak_ptr<std::atomic_bool>> gOperations;

void ExecuteWork(napi_env, void* data) {
  Work* work = static_cast<Work*>(data);
  @autoreleasepool {
    try {
      work->result = ExecuteAction(work->request, work->cancelled);
    } catch (const NativeError& error) {
      work->errorCode = error.code();
      work->errorMessage = error.message();
    } catch (...) {
      work->errorCode = "nativeBridgeUnavailable";
      work->errorMessage = "The foreground input operation failed unexpectedly.";
    }
  }
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

void CompleteWork(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Work> work(static_cast<Work*>(data));
  {
    std::lock_guard<std::mutex> lock(gOperationsMutex);
    gOperations.erase(work->request.operationId);
  }
  if (status != napi_ok && work->errorCode.empty()) {
    work->errorCode = "nativeBridgeUnavailable";
    work->errorMessage = "The foreground input worker did not complete.";
  }
  if (!work->errorCode.empty()) {
    napi_value message = String(env, work->errorMessage);
    napi_value error = nullptr;
    napi_create_error(env, nullptr, message, &error);
    Set(env, error, "code", String(env, work->errorCode));
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value result = nullptr;
    napi_create_object(env, &result);
    Set(env, result, "operationId", String(env, work->request.operationId));
    Set(env, result, "outcome", String(env, work->result.outcome));
    Set(env, result, "delivery", String(env, work->result.delivery));
    Set(env, result, "targetState", String(env, work->result.targetState));
    napi_value count = nullptr;
    napi_create_uint32(env, static_cast<uint32_t>(work->result.eventsPosted), &count);
    Set(env, result, "eventsPosted", count);
    if (!work->result.reason.empty())
      Set(env, result, "reason", String(env, work->result.reason));
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->async);
}

napi_value PerformCallback(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value args[1] = {};
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1)
      Fail("invalidRequest", "performForegroundInput expects one request.");
    std::unique_ptr<Work> work = std::make_unique<Work>();
    work->env = env;
    work->request = ParseRequest(env, args[0]);
    work->cancelled = std::make_shared<std::atomic_bool>(false);
    {
      std::lock_guard<std::mutex> lock(gOperationsMutex);
      auto existing = gOperations.find(work->request.operationId);
      if (existing != gOperations.end() && !existing->second.expired())
        Fail("operationConflict", "The operation ID is already active.");
      gOperations[work->request.operationId] = work->cancelled;
    }
    napi_value promise = nullptr;
    napi_create_promise(env, &work->deferred, &promise);
    napi_value name = String(env, "KestrelForegroundComputerInput");
    if (napi_create_async_work(env, nullptr, name, ExecuteWork, CompleteWork,
                               work.get(), &work->async) != napi_ok ||
        napi_queue_async_work(env, work->async) != napi_ok) {
      std::lock_guard<std::mutex> lock(gOperationsMutex);
      gOperations.erase(work->request.operationId);
      Fail("nativeBridgeUnavailable", "The foreground input worker could not start.");
    }
    work.release();
    return promise;
  } catch (const NativeError& error) {
    napi_value message = String(env, error.message());
    napi_value nativeError = nullptr;
    napi_create_error(env, nullptr, message, &nativeError);
    Set(env, nativeError, "code", String(env, error.code()));
    napi_throw(env, nativeError);
    return nullptr;
  }
}

napi_value CancelCallback(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value args[1] = {};
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1)
      Fail("invalidRequest", "cancelForegroundInput expects one operation ID.");
    std::string operationId = StringValue(env, args[0], "operationId", kMaxOperationIdLength);
    bool cancelled = false;
    {
      std::lock_guard<std::mutex> lock(gOperationsMutex);
      auto found = gOperations.find(operationId);
      if (found != gOperations.end()) {
        if (auto flag = found->second.lock()) {
          flag->store(true, std::memory_order_relaxed);
          cancelled = true;
        }
      }
    }
    napi_value result = nullptr;
    napi_get_boolean(env, cancelled, &result);
    return result;
  } catch (const NativeError& error) {
    napi_value message = String(env, error.message());
    napi_value nativeError = nullptr;
    napi_create_error(env, nullptr, message, &nativeError);
    Set(env, nativeError, "code", String(env, error.code()));
    napi_throw(env, nativeError);
    return nullptr;
  }
}

napi_value PreflightCallback(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  napi_get_boolean(env, AXIsProcessTrusted() && CGPreflightPostEventAccess(), &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"performForegroundInput", nullptr, PerformCallback, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"cancelForegroundInput", nullptr, CancelCallback, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"preflightEventAccess", nullptr, PreflightCallback, nullptr, nullptr,
       nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]),
                         properties);
  return exports;
}
