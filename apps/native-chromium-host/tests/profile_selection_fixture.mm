#import <Foundation/Foundation.h>
#include "kestrel_native_profile_transfer.h"
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <unistd.h>

// Compile the production module below with a fixture-only sync replacement.
// The shipping source and executable have no fault flag or replacement.
static int FixtureFsync(int fd) {
  const char* fault = getenv("KESTREL_SELECTION_FIXTURE_FSYNC_FAULT");
  struct stat info{};
  if (fault && !fstat(fd,&info) && ((!strcmp(fault,"directory") && S_ISDIR(info.st_mode)) || (!strcmp(fault,"file") && S_ISREG(info.st_mode)))) { errno = EIO; return -1; }
  return fsync(fd);
}
#define fsync FixtureFsync
#include "../src/kestrel_native_profile_transfer.mm"
#undef fsync

int main(int argc, char** argv) {
  @autoreleasepool {
    if (argc != 2 && argc != 3 && argc != 5) return 2;
    NSString* root = [NSString stringWithUTF8String:argv[1]];
    KestrelNativeProfileSelectionResult result = KestrelNativeProfileSelectionResult::Unchanged;
    if (argc == 5) result = KestrelSaveNativeCoreProfileSelection(root,[NSString stringWithUTF8String:argv[2]],[NSString stringWithUTF8String:argv[3]],[NSString stringWithUTF8String:argv[4]]);
    NSError* error = nil;
    if (argc == 3 && strcmp(argv[2],"--source")) return 2;
    NSString* selected = argc == 3 ? KestrelCanonicalNativeCoreTransferSource(root) : KestrelResolveNativeCoreProfile(root,&error);
    NSMutableDictionary* response = [@{@"ok":@(selected != nil),@"profile":selected ?: NSNull.null,@"error":@(error != nil)} mutableCopy];
    if (argc == 5) response[@"saved"] = result == KestrelNativeProfileSelectionResult::Selected ? @"selected" : result == KestrelNativeProfileSelectionResult::SelectedDurabilityUnconfirmed ? @"selected-durability-unconfirmed" : @"unchanged";
    NSData* bytes = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    return bytes && fwrite(bytes.bytes,1,bytes.length,stdout) == bytes.length ? 0 : 2;
  }
}
