#pragma once

#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <mach-o/dyld.h>

// These functions are deliberately independent of the transport. Call setters
// only in response to the corresponding explicit user action.
typedef void (^KestrelSystemCompletion)(NSDictionary*);
typedef void (^KestrelSchemeSetter)(NSString*, void (^)(NSError*));
typedef BOOL (^KestrelSchemeReader)(NSString*);
typedef SMAppServiceStatus (^KestrelLoginReader)(void);
typedef BOOL (^KestrelLoginWriter)(BOOL, NSError**);

static inline BOOL KestrelSystemIdentityAllowed(NSString* path, NSString* resolvedPath,
                                                 NSString* bundleID, NSString* executablePath, BOOL nativeRuntimeLoaded) {
  return nativeRuntimeLoaded && [path isEqualToString:@"/Applications/Kestrel.app"] &&
      [resolvedPath isEqualToString:@"/Applications/Kestrel.app"] &&
      [bundleID isEqualToString:@"com.kestrel.desktop"] &&
      [executablePath isEqualToString:@"/Applications/Kestrel.app/Contents/MacOS/Kestrel"];
}

static inline BOOL KestrelSystemCurrentIdentityAllowed(void) {
  NSBundle* bundle = NSBundle.mainBundle;
  BOOL nativeRuntimeLoaded = NO;
  NSString* frameworkRoot = @"/Applications/Kestrel.app/Contents/Frameworks/Chromium Embedded Framework.framework/";
  for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
    const char* image = _dyld_get_image_name(i);
    if (!image) continue;
    NSString* path = [[NSString stringWithUTF8String:image] stringByResolvingSymlinksInPath];
    if ([path hasPrefix:frameworkRoot] && [path.lastPathComponent isEqualToString:@"Chromium Embedded Framework"]) { nativeRuntimeLoaded = YES; break; }
  }
  return KestrelSystemIdentityAllowed(bundle.bundlePath,
      bundle.bundleURL.URLByResolvingSymlinksInPath.path, bundle.bundleIdentifier,
      bundle.executableURL.URLByResolvingSymlinksInPath.path, nativeRuntimeLoaded);
}

static inline NSString* KestrelLoginStatusLabel(SMAppServiceStatus status) {
  switch (status) {
    case SMAppServiceStatusEnabled: return @"enabled";
    case SMAppServiceStatusRequiresApproval: return @"requires-approval";
    case SMAppServiceStatusNotFound: return @"not-found";
    case SMAppServiceStatusNotRegistered: return @"not-registered";
  }
  return @"unknown";
}

static inline NSDictionary* KestrelDefaultBrowserReadback(BOOL allowed, KestrelSchemeReader reader) {
  BOOL isDefault = reader(@"http") && reader(@"https");
  return @{@"ok": @YES, @"isDefault": @(isDefault), @"canSetAsDefault": @(allowed)};
}

// Both schemes are attempted in order, even if the first fails. Only the
// subsequent readback establishes whether Kestrel is actually the default.
static inline void KestrelSetDefaultBrowserWith(BOOL allowed, KestrelSchemeSetter setter,
                                                KestrelSchemeReader reader, KestrelSystemCompletion done) {
  if (!allowed) { done(@{@"ok": @NO, @"error": @"Install the production Kestrel app in /Applications before changing system settings."}); return; }
  setter(@"http", ^(NSError* httpError) {
    setter(@"https", ^(NSError* httpsError) {
      BOOL isDefault = reader(@"http") && reader(@"https");
      if (httpError || httpsError || !isDefault) {
        done(@{@"ok": @NO, @"isDefault": @(isDefault), @"canSetAsDefault": @YES,
               @"error": @"macOS did not confirm Kestrel as the default for both HTTP and HTTPS. Check Default web browser in System Settings."});
      } else {
        done(@{@"ok": @YES, @"success": @YES, @"isDefault": @YES, @"canSetAsDefault": @YES});
      }
    });
  });
}

static inline NSDictionary* KestrelSetLaunchAtLoginWith(BOOL allowed, BOOL enabled,
                                                         KestrelLoginWriter writer, KestrelLoginReader reader) {
  if (!allowed) return @{@"ok": @NO, @"error": @"Install the production Kestrel app in /Applications before changing system settings."};
  NSError* error = nil;
  BOOL changed = writer(enabled, &error);
  SMAppServiceStatus status = reader();
  BOOL actual = status == SMAppServiceStatusEnabled;
  BOOL confirmed = changed && !error && (enabled ? actual : status == SMAppServiceStatusNotRegistered);
  if (!confirmed) return @{@"ok": @NO, @"launchAtLogin": @(actual), @"launchStatus": KestrelLoginStatusLabel(status),
      @"error": status == SMAppServiceStatusRequiresApproval ? @"Approve Kestrel in System Settings to finish changing launch at login." : @"macOS did not confirm the requested launch-at-login setting."};
  return @{@"ok": @YES, @"launchAtLogin": @(actual), @"launchStatus": KestrelLoginStatusLabel(status)};
}

static inline KestrelSchemeReader KestrelDefaultBrowserReader(void) {
  NSURL* bundleURL = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath;
  return ^BOOL(NSString* scheme) {
    NSURL* probe = [NSURL URLWithString:[NSString stringWithFormat:@"%@://kestrel.invalid/", scheme]];
    NSURL* handler = [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:probe];
    return handler && [handler.URLByResolvingSymlinksInPath isEqual:bundleURL];
  };
}

static inline void KestrelSetDefaultBrowser(KestrelSystemCompletion done) {
  NSURL* bundleURL = NSBundle.mainBundle.bundleURL;
  KestrelSetDefaultBrowserWith(KestrelSystemCurrentIdentityAllowed(), ^(NSString* scheme, void (^completion)(NSError*)) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:bundleURL toOpenURLsWithScheme:scheme completionHandler:^(NSError* error) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(error); });
      }];
    });
  }, KestrelDefaultBrowserReader(), done);
}

static inline NSDictionary* KestrelSetLaunchAtLogin(BOOL enabled) {
  return KestrelSetLaunchAtLoginWith(KestrelSystemCurrentIdentityAllowed(), enabled, ^BOOL(BOOL desired, NSError** error) {
    return desired ? [SMAppService.mainAppService registerAndReturnError:error] : [SMAppService.mainAppService unregisterAndReturnError:error];
  }, ^SMAppServiceStatus { return SMAppService.mainAppService.status; });
}
