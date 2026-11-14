#pragma once
#import <Foundation/Foundation.h>

// The broker receives only its existing runtime fields and explicit discovery
// opt-outs. Never inherit provider credentials or other ambient configuration.
inline NSDictionary<NSString*, NSString*>* KestrelNativeBrokerEnvironment(
    NSDictionary<NSString*, id>* inherited) {
  NSMutableDictionary<NSString*, NSString*>* environment =
      [NSMutableDictionary dictionary];
  for (NSString* name in @[@"HOME", @"PATH", @"LANG", @"TMPDIR"]) {
    id value = inherited[name];
    if ([value isKindOfClass:NSString.class]) environment[name] = value;
  }
  for (NSString* name in @[@"KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY",
                           @"KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY"]) {
    id value = inherited[name];
    if ([value isKindOfClass:NSString.class] && [value isEqualToString:@"1"])
      environment[name] = @"1";
  }
  return [environment copy];
}
