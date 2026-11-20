#import <Foundation/Foundation.h>
#include <cassert>
#include "../src/native_system_integration.h"

int main() { @autoreleasepool {
  NSString* path = @"/Applications/Kestrel.app";
  NSString* executable = @"/Applications/Kestrel.app/Contents/MacOS/Kestrel";
  assert(KestrelSystemIdentityAllowed(path, path, @"com.kestrel.desktop", executable, YES));
  assert(!KestrelSystemIdentityAllowed(path, path, @"com.kestrel.native-chromium-host.dev", executable, YES));
  assert(!KestrelSystemIdentityAllowed(@"/tmp/Kestrel.app", path, @"com.kestrel.desktop", executable, YES));
  assert(!KestrelSystemIdentityAllowed(path, @"/tmp/Kestrel.app", @"com.kestrel.desktop", executable, YES));
  assert(!KestrelSystemIdentityAllowed(path, path, @"com.kestrel.desktop", @"/tmp/Kestrel", YES));
  assert(!KestrelSystemIdentityAllowed(path, path, @"com.kestrel.desktop", executable, NO));
  __block int calls = 0;
  __block NSDictionary* result = nil;
  KestrelSchemeSetter setter = ^(NSString* scheme, void (^done)(NSError*)) {
    ++calls;
    assert([scheme isEqualToString:calls == 1 ? @"http" : @"https"]);
    done(nil);
  };
  KestrelSchemeReader both = ^BOOL(NSString*) { return YES; };
  KestrelSetDefaultBrowserWith(NO, setter, both, ^(NSDictionary* value) { result = value; });
  assert(calls == 0 && ![result[@"ok"] boolValue]);
  KestrelSetDefaultBrowserWith(YES, setter, both, ^(NSDictionary* value) { result = value; });
  assert(calls == 2 && [result[@"success"] boolValue]);
  calls = 0;
  KestrelSetDefaultBrowserWith(YES, setter, ^BOOL(NSString* scheme) { return [scheme isEqualToString:@"http"]; }, ^(NSDictionary* value) { result = value; });
  assert(calls == 2 && ![result[@"ok"] boolValue] && ![result[@"isDefault"] boolValue]);
  calls = 0;
  KestrelSetDefaultBrowserWith(YES, ^(NSString*, void (^done)(NSError*)) {
    ++calls; done(calls == 1 ? [NSError errorWithDomain:@"test" code:1 userInfo:nil] : nil);
  }, both, ^(NSDictionary* value) { result = value; });
  assert(calls == 2 && ![result[@"ok"] boolValue] && [result[@"isDefault"] boolValue]);
  __block int writes = 0;
  KestrelLoginWriter writer = ^BOOL(BOOL, NSError**) { ++writes; return YES; };
  KestrelLoginReader enabled = ^SMAppServiceStatus { return SMAppServiceStatusEnabled; };
  result = KestrelSetLaunchAtLoginWith(NO, YES, writer, enabled);
  assert(writes == 0 && ![result[@"ok"] boolValue]);
  result = KestrelSetLaunchAtLoginWith(YES, YES, writer, enabled);
  assert(writes == 1 && [result[@"ok"] boolValue] && [result[@"launchAtLogin"] boolValue]);
  result = KestrelSetLaunchAtLoginWith(YES, YES, writer, ^SMAppServiceStatus { return SMAppServiceStatusRequiresApproval; });
  assert(![result[@"ok"] boolValue] && [result[@"launchStatus"] isEqualToString:@"requires-approval"]);
  result = KestrelSetLaunchAtLoginWith(YES, NO, writer, ^SMAppServiceStatus { return SMAppServiceStatusNotRegistered; });
  assert([result[@"ok"] boolValue] && ![result[@"launchAtLogin"] boolValue]);
  result = KestrelSetLaunchAtLoginWith(YES, NO, ^BOOL(BOOL, NSError** error) { *error = [NSError errorWithDomain:@"test" code:1 userInfo:nil]; return NO; }, enabled);
  assert(![result[@"ok"] boolValue] && [result[@"launchAtLogin"] boolValue]);
} }
