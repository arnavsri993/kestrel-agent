#import <Foundation/Foundation.h>
#include "kestrel_native_profile_transfer.h"
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <sys/proc.h>
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
    if (argc == 2 && !strcmp(argv[1],"--sleep-child")) {
      signal(SIGTERM,SIG_IGN); write(STDOUT_FILENO,"fixture-ready\n",14);
      for (;;) pause();
    }
    if (argc == 3 && !strcmp(argv[2], "--read-private")) {
      const auto started = std::chrono::steady_clock::now();
      NSData* data = ReadPrivateFile([NSString stringWithUTF8String:argv[1]], 256);
      const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{ @"ok":@(data != nil), @"milliseconds":@(elapsed) } options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if ((argc == 5 || argc == 6) && (!strcmp(argv[2], "--witness") || !strcmp(argv[2], "--input-witness"))) {
      NSString* source = [NSString stringWithUTF8String:argv[1]], *destination = [NSString stringWithUTF8String:argv[3]], *changed = [NSString stringWithUTF8String:argv[4]];
      const bool inputs = !strcmp(argv[2], "--input-witness");
      NSDictionary* before = inputs ? RecoveryInputWitness(source,destination) : RecoveryWitness(source,destination);
      if (before && changed.length) {
        if (argc == 6 && !strcmp(argv[5], "replace") && unlink(changed.fileSystemRepresentation)) return 2;
        int fd = open(changed.fileSystemRepresentation,O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW,0600);
        if (fd < 0 || write(fd,"changed fixture",15) != 15) return 2;
        close(fd);
      }
      NSDictionary* after = inputs ? RecoveryInputWitness(source,destination) : RecoveryWitness(source,destination);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{ @"before":@(before != nil), @"after":@(after != nil), @"same":@(before && after && [before isEqualToDictionary:after]) } options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if (argc == 3 && !strcmp(argv[2], "--review-validation")) {
      NSString* destination = @"/tmp/destination";
      NSMutableDictionary* preview = [@{ @"state":@"staged", @"destinationDatabasePath":destination, @"sourceDatabasePath":@"/tmp/source", @"recoverySha256":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"counts":@{@"memories":@1}, @"excluded":@{} } mutableCopy];
      NSMutableDictionary* response = [@{ @"ok":@YES, @"reviewId":NSUUID.UUID.UUIDString, @"preview":preview } mutableCopy];
      BOOL valid = ValidInterruptedReview(response,destination);
      preview[@"counts"] = @{@"memories":@YES}; BOOL badCount = !ValidInterruptedReview(response,destination);
      preview[@"counts"] = @{}; preview[@"sourceDatabasePath"] = @"relative"; BOOL badPath = !ValidInterruptedReview(response,destination);
      preview[@"sourceDatabasePath"] = @"/tmp/source"; preview[@"recoverySha256"] = [@"g" stringByPaddingToLength:64 withString:@"g" startingAtIndex:0]; BOOL badDigest = !ValidInterruptedReview(response,destination);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{ @"valid":@(valid), @"badCount":@(badCount), @"badPath":@(badPath), @"badDigest":@(badDigest) } options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if (argc == 3 && !strcmp(argv[2], "--legacy-review-validation")) {
      NSMutableDictionary* value = [@{@"sourceSchemaVersion":@19,@"jobAliases":@1,@"archivedDiagnosticEvents":@2} mutableCopy];
      BOOL valid = SafeLegacyCounts(value);
      value[@"jobAliases"] = @YES; BOOL badBool = !SafeLegacyCounts(value);
      value[@"jobAliases"] = @100001; BOOL badLimit = !SafeLegacyCounts(value);
      value[@"jobAliases"] = @1; value[@"sourceSchemaVersion"] = @20; BOOL badVersion = !SafeLegacyCounts(value);
      value[@"sourceSchemaVersion"] = @19; value[@"unknown"] = @0; BOOL badFields = !SafeLegacyCounts(value);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"valid":@(valid),@"badBool":@(badBool),@"badLimit":@(badLimit),@"badVersion":@(badVersion),@"badFields":@(badFields)} options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if (argc != 2 && argc != 3 && argc != 5 && argc != 6) return 2;
    if (argc == 3 && !strncmp(argv[2],"--stop-",7)) {
      const bool paused = strcmp(argv[2],"--stop-worker") != 0;
      const bool mismatched = !strcmp(argv[2],"--stop-mismatched-worker");
      if (strcmp(argv[2],"--stop-worker") && strcmp(argv[2],"--stop-paused-worker") && !mismatched) return 2;
      NSTask* task = [[NSTask alloc] init];
      task.executableURL = [NSURL fileURLWithPath:paused ? NSProcessInfo.processInfo.arguments.firstObject : @"/bin/sleep"];
      task.arguments = paused ? @[@"--sleep-child"] : @[@"60"];
      NSPipe* ready = paused ? NSPipe.pipe : nil;
      task.standardInput = NSFileHandle.fileHandleWithNullDevice; task.standardOutput = paused ? (id)ready : NSFileHandle.fileHandleWithNullDevice; task.standardError = NSFileHandle.fileHandleWithNullDevice;
      if (![task launchAndReturnError:nil]) return 2;
      if (paused && ![[ready.fileHandleForReading readDataOfLength:14] isEqualToData:[@"fixture-ready\n" dataUsingEncoding:NSUTF8StringEncoding]]) { kill(task.processIdentifier,SIGKILL); [task waitUntilExit]; return 2; }
      KestrelCoreTransferPipe* pipe = [[KestrelCoreTransferPipe alloc] init]; pipe.task = task; [pipe recordTaskIdentity];
      if (paused) {
        kill(task.processIdentifier,SIGSTOP); bool confirmed = false;
        for (int count = 0; count < 1000; count++) {
          struct proc_bsdinfo info{};
          if (proc_pidinfo(task.processIdentifier,PROC_PIDTBSDINFO,0,&info,sizeof(info)) == sizeof(info) && info.pbi_status == SSTOP) { confirmed = true; break; }
          usleep(1000);
        }
        if (!confirmed) { kill(task.processIdentifier,SIGKILL); [task waitUntilExit]; return 2; }
      }
      const BOOL identity = pipe.hasProcessIdentity;
      if (mismatched) pipe.launchedMicroseconds += 1;
      const auto started = std::chrono::steady_clock::now(); const BOOL stopped = [pipe stop];
      const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
      const BOOL preserved = task.running;
      NSNumber* stop_signal = stopped && task.terminationReason == NSTaskTerminationReasonUncaughtSignal ? @(task.terminationStatus) : nil;
      if (task.running) kill(task.processIdentifier,SIGKILL);
      [task waitUntilExit]; [pipe stop];
      NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"stopped":@(stopped),@"identity":@(identity),@"preservedBeforeFixtureCleanup":@(preserved),@"signal":stop_signal ?: NSNull.null,@"milliseconds":@(elapsed)} options:0 error:nil];
      return bytes && fwrite(bytes.bytes,1,bytes.length,stdout) == bytes.length ? 0 : 2;
    }
    NSString* root = [NSString stringWithUTF8String:argv[1]];
    KestrelNativeProfileSelectionResult result = KestrelNativeProfileSelectionResult::Unchanged;
    if (argc == 5 || argc == 6) result = KestrelSaveNativeCoreProfileSelection(root,[NSString stringWithUTF8String:argv[2]],[NSString stringWithUTF8String:argv[3]],[NSString stringWithUTF8String:argv[4]], argc == 6 ? [NSString stringWithUTF8String:argv[5]] : nil);
    NSError* error = nil;
    if (argc == 3 && strcmp(argv[2],"--source")) return 2;
    NSString* selected = argc == 3 ? KestrelCanonicalNativeCoreTransferSource(root) : KestrelResolveNativeCoreProfile(root,&error);
    NSMutableDictionary* response = [@{@"ok":@(selected != nil),@"profile":selected ?: NSNull.null,@"error":@(error != nil)} mutableCopy];
    if (argc == 5 || argc == 6) response[@"saved"] = result == KestrelNativeProfileSelectionResult::Selected ? @"selected" : result == KestrelNativeProfileSelectionResult::SelectedDurabilityUnconfirmed ? @"selected-durability-unconfirmed" : @"unchanged";
    NSData* bytes = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    return bytes && fwrite(bytes.bytes,1,bytes.length,stdout) == bytes.length ? 0 : 2;
  }
}
