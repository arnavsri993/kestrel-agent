#import <Foundation/Foundation.h>
#import "kestrel_native_prepared_profiles.h"
#include <cstdio>
int main(int argc, char** argv) {
 @autoreleasepool {
  if (argc != 4 && argc != 5) return 2;
  NSString* root = [NSString stringWithUTF8String:argv[1]], *active = [NSString stringWithUTF8String:argv[2]], *previous = [NSString stringWithUTF8String:argv[3]];
  NSError* error = nil; NSArray* rows = KestrelInspectPreparedCoreProfiles(root, active, previous, &error);
  NSMutableDictionary* result = [@{ @"ok":@(rows != nil), @"error":@(error != nil), @"rows":rows ?: @[] } mutableCopy];
  if (argc == 5) {
   NSData* input = [[NSString stringWithUTF8String:argv[4]] dataUsingEncoding:NSUTF8StringEncoding];
   id row = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
   result[@"current"] = @(KestrelPreparedCoreProfileIsCurrent(root, row, active, previous));
  }
  NSData* output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  return output && fwrite(output.bytes, 1, output.length, stdout) == output.length ? 0 : 2;
 }
}
