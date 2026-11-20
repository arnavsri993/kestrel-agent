#ifndef KESTREL_NATIVE_DIALOG_PATHS_H_
#define KESTREL_NATIVE_DIALOG_PATHS_H_
#import <Foundation/Foundation.h>
#include <limits.h>
#include <stdlib.h>

static inline bool ValidNativeDialogPath(id path) {
  return [path isKindOfClass:NSString.class] && [path length] > 0 && [path length] <= 4096 &&
      [path isAbsolutePath] && [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}

// Node/Core grants use POSIX realpath. Foundation intentionally rewrites some
// canonical paths (notably /private/var to /var), so its display-path resolver
// cannot be used for the grant boundary or for selected-file attestations.
static inline NSString* CanonicalNativeDialogPath(id path) {
  if (!ValidNativeDialogPath(path)) return nil;
  char resolved[PATH_MAX]{};
  if (!realpath([path fileSystemRepresentation], resolved)) return nil;
  NSString* canonical = [NSString stringWithUTF8String:resolved];
  return ValidNativeDialogPath(canonical) ? canonical : nil;
}
#endif
