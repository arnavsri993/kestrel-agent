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
    if (argc != 2 && argc != 3 && argc != 5) return 2;
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
