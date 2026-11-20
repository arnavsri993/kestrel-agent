#import <Foundation/Foundation.h>
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <limits.h>
#include <unistd.h>
#include "../src/native_dialog_paths.h"

int main() { @autoreleasepool {
  NSString* base = NSTemporaryDirectory();
  NSString* folder = [base stringByAppendingPathComponent:@"kestrel-path-canary-XXXXXX"];
  char* buffer = strdup(folder.fileSystemRepresentation);
  assert(buffer && mkdtemp(buffer));
  NSString* raw = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:buffer length:strlen(buffer)];
  free(buffer);
  NSString* file = [raw stringByAppendingPathComponent:@"owned.txt"];
  assert([[NSData data] writeToFile:file atomically:YES]);
  char resolved[PATH_MAX]{};
  assert(realpath(raw.fileSystemRepresentation, resolved));
  NSString* canonical = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:resolved length:strlen(resolved)];
  NSString* foundation = canonical.stringByResolvingSymlinksInPath;
  NSString* foundationFile = [NSURL fileURLWithPath:file].URLByResolvingSymlinksInPath.path;
  char resolvedFile[PATH_MAX]{};
  assert(realpath(file.fileSystemRepresentation, resolvedFile));
  NSString* canonicalFile = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:resolvedFile length:strlen(resolvedFile)];
  assert([CanonicalNativeDialogPath(canonical) isEqualToString:canonical]);
  assert([CanonicalNativeDialogPath(foundation) isEqualToString:canonical]);
  assert([CanonicalNativeDialogPath(foundationFile) isEqualToString:canonicalFile]);
  assert([CanonicalNativeDialogPath(foundationFile) hasPrefix:[canonical stringByAppendingString:@"/"]]);
  assert(!CanonicalNativeDialogPath(@"relative.txt"));
  assert(!CanonicalNativeDialogPath([raw stringByAppendingPathComponent:@"missing.txt"]));
  assert(!CanonicalNativeDialogPath([raw stringByAppendingString:@"\n"]));
  NSString* link = [raw stringByAppendingPathComponent:@"link.txt"];
  assert(symlink(file.fileSystemRepresentation, link.fileSystemRepresentation) == 0);
  assert([CanonicalNativeDialogPath(link) isEqualToString:canonicalFile]);
  assert(![canonicalFile hasPrefix:[[canonical stringByAppendingString:@"-other"] stringByAppendingString:@"/"]]);
  assert([[NSFileManager defaultManager] removeItemAtPath:raw error:nil]);
} }
