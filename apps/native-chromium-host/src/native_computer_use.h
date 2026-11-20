#pragma once

#import <Cocoa/Cocoa.h>

#include <functional>
#include <string>

#include "include/cef_values.h"

struct NativeComputerUseIdentity {
  uint32_t display_id = 0;
  CGRect logical_bounds = CGRectZero;
  pid_t foreground_process_id = 0;
  uint32_t frontmost_window_id = 0;
  CGRect frontmost_window_bounds = CGRectZero;
};

class NativeComputerUseService {
 public:
  using CaptureCompletion =
      std::function<void(bool, const std::string&, const std::string&)>;
  using ContinueCheck = std::function<bool()>;

  static std::string PermissionStatusJson();
  static bool CurrentIdentity(NativeComputerUseIdentity* identity,
                              std::string* error);
  static std::string IdentityJson(const NativeComputerUseIdentity& identity);
  static void Capture(CaptureCompletion completion);
  static bool Act(CefRefPtr<CefDictionaryValue> request, std::string* error,
                  ContinueCheck should_continue = {});
  static bool OpenSettings(const std::string& surface, std::string* error);
};
