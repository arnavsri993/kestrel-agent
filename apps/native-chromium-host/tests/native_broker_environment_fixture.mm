#import <Foundation/Foundation.h>
#include <cstdio>
#include <cstring>
#include "native_broker_environment.h"

static bool Check(BOOL condition) {
  if (!condition) std::fputs("Broker environment fixture assertion failed.\n", stderr);
  return condition;
}

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSDictionary* base = @{@"HOME": @"/fixture/home", @"PATH": @"/usr/bin:/bin",
                            @"LANG": @"en_US.UTF-8", @"TMPDIR": @"/fixture/tmp"};
    NSArray<NSString*>* flags = @[@"KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY",
                                  @"KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY"];
    if (std::strcmp(argv[1], "whitelist") == 0) {
      NSMutableDictionary* input = [base mutableCopy];
      for (NSString* name in flags) input[name] = @"1";
      NSDictionary* expected = [input copy];
      [input addEntriesFromDictionary:@{
        @"OPENAI_API_KEY": @"fixture-secret", @"ANTHROPIC_API_KEY": @"fixture-secret",
        @"CODEX_HOME": @"/fixture/vendor", @"KESTREL_NATIVE_TEST_PROFILE_KEY": @"fixture-key",
        @"KESTREL_DISABLE_ARBITRARY_DISCOVERY": @"1", @"UNRELATED": @"fixture-value"
      }];
      NSDictionary* actual = KestrelNativeBrokerEnvironment(input);
      return Check(actual.count == 6 && [actual isEqualToDictionary:expected]) ? 0 : 1;
    }
    if (std::strcmp(argv[1], "normal") == 0)
      return Check([KestrelNativeBrokerEnvironment(base) isEqualToDictionary:base] &&
                   KestrelNativeBrokerEnvironment(@{}).count == 0 &&
                   KestrelNativeBrokerEnvironment(nil).count == 0) ? 0 : 1;
    if (std::strcmp(argv[1], "invalid-flags") == 0) {
      NSArray* rejected = @[@"", @"0", @"false", @"true", @"yes", @"01", @" 1", @"1 ",
                            @"1\n", @0, @1, @YES, @NO, NSNull.null, @[], @{}];
      for (NSString* name in flags) {
        for (id value in rejected) {
          NSMutableDictionary* input = [base mutableCopy];
          input[name] = value;
          if (!Check([KestrelNativeBrokerEnvironment(input) isEqualToDictionary:base])) return 1;
        }
        NSMutableDictionary* input = [base mutableCopy];
        input[name] = [NSMutableString stringWithString:@"1"];
        NSDictionary* actual = KestrelNativeBrokerEnvironment(input);
        if (!Check(actual.count == 5 && [actual[name] isEqualToString:@"1"])) return 1;
        [input[name] appendString:@"0"];
        if (!Check([actual[name] isEqualToString:@"1"])) return 1;
      }
      return 0;
    }
    if (std::strcmp(argv[1], "invalid-base") == 0) {
      NSArray* rejected = @[@0, @1, @YES, NSNull.null, @[], @{}];
      for (NSString* name in base) {
        NSMutableDictionary* expected = [base mutableCopy];
        [expected removeObjectForKey:name];
        for (id value in rejected) {
          NSMutableDictionary* input = [base mutableCopy];
          input[name] = value;
          if (!Check([KestrelNativeBrokerEnvironment(input) isEqualToDictionary:expected])) return 1;
        }
      }
      return 0;
    }
    return 2;
  }
}
