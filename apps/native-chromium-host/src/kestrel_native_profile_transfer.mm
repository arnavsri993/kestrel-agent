#import <Cocoa/Cocoa.h>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fcntl.h>
#include <limits.h>
#include <libproc.h>
#include <iostream>
#include <poll.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#include "kestrel_native_profile_transfer.h"
#include "kestrel_native_prepared_profiles.h"
#include "kestrel_native_core_keychain.h"
#include "kestrel_legacy_core_key.h"

namespace {
constexpr size_t kFrameLimit = 64 * 1024;
NSString* const kSelectionName = @"native-core-profile.json";
NSError* Failure(NSString* text) { return [NSError errorWithDomain:@"com.kestrel.core-transfer" code:1 userInfo:@{NSLocalizedDescriptionKey:text}]; }
NSString* CanonicalPath(NSString* path) {
  if (!path.isAbsolutePath) return nil;
  char canonical[PATH_MAX]{};
  return realpath(path.fileSystemRepresentation,canonical) ? [NSString stringWithUTF8String:canonical] : nil;
}
bool PrivateDirectory(NSString* path) {
  if (!path.isAbsolutePath) return false;
  char canonical[PATH_MAX]{}; struct stat info{};
  return !lstat(path.fileSystemRepresentation, &info) && S_ISDIR(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0077) &&
      realpath(path.fileSystemRepresentation, canonical) && [path isEqualToString:[NSString stringWithUTF8String:canonical]];
}
bool MakePrivateDirectory(NSString* path) {
  if (mkdir(path.fileSystemRepresentation, 0700) && errno != EEXIST) return false;
  return PrivateDirectory(path);
}
void Clear(void* pointer, size_t size) { volatile uint8_t* bytes = static_cast<volatile uint8_t*>(pointer); while (size--) *bytes++ = 0; }
NSData* ReadPrivateFile(NSString* path, size_t maximum) {
  const int fd = open(path.fileSystemRepresentation, O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
  if (fd < 0) return nil;
  struct stat info{};
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 ||
      (info.st_mode & 0077) || info.st_size <= 0 || static_cast<uint64_t>(info.st_size) > maximum) { close(fd); return nil; }
  NSMutableData* data = [NSMutableData dataWithLength:static_cast<NSUInteger>(info.st_size)];
  size_t offset = 0;
  while (offset < data.length) {
    const ssize_t count = read(fd, static_cast<uint8_t*>(data.mutableBytes) + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { Clear(data.mutableBytes,data.length); close(fd); return nil; } offset += static_cast<size_t>(count);
  }
  uint8_t extra{}; const bool complete = read(fd, &extra, 1) == 0; close(fd);
  if (!complete) Clear(data.mutableBytes,data.length);
  return complete ? data : nil;
}
bool WritePrivateFile(NSString* path, NSData* bytes, bool replace, bool* committed = nullptr) {
  if (committed) *committed = false;
  NSString* staged = replace ? [path stringByAppendingFormat:@".%@.tmp", NSUUID.UUID.UUIDString] : path;
  const int fd = open(staged.fileSystemRepresentation, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
  if (fd < 0) return false;
  size_t offset = 0; bool ok = true;
  while (offset < bytes.length) {
    const ssize_t count = write(fd, static_cast<const uint8_t*>(bytes.bytes) + offset, bytes.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { ok = false; break; } offset += static_cast<size_t>(count);
  }
  ok = ok && fsync(fd) == 0; close(fd);
  if (ok && replace) ok = rename(staged.fileSystemRepresentation, path.fileSystemRepresentation) == 0;
  if (!ok) { if (replace) unlink(staged.fileSystemRepresentation); return false; }
  if (committed) *committed = true;
  const int parent = open(path.stringByDeletingLastPathComponent.fileSystemRepresentation, O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if (parent < 0) return false; ok = fsync(parent) == 0; close(parent); return ok;
}
bool ValidRelative(id value) {
  if (![value isKindOfClass:NSString.class]) return false;
  NSString* text = value;
  if (!text.length) return true;
  NSArray<NSString*>* parts = text.pathComponents;
  return parts.count == 2 && [parts[0] isEqualToString:@"native-core-profiles"] && parts[1].length == 36 && [[NSUUID alloc] initWithUUIDString:parts[1]];
}
NSDictionary* Selection(NSString* root) {
  if (!PrivateDirectory(root)) return nil;
  NSString* path = [root stringByAppendingPathComponent:kSelectionName]; struct stat info{};
  if (lstat(path.fileSystemRepresentation, &info)) return errno == ENOENT ? @{ @"version":@1, @"active":@"", @"previous":@"" } : nil;
  NSData* bytes = ReadPrivateFile(path, 4096);
  id value = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
  if (![value isKindOfClass:NSDictionary.class] || [value count] != 3 || ![value[@"version"] isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value[@"version"]) == CFBooleanGetTypeID() || ![value[@"version"] isEqualToNumber:@1] ||
      !ValidRelative(value[@"active"]) || !ValidRelative(value[@"previous"])) return nil;
  return value;
}
NSString* Profile(NSString* root, NSString* relative) {
  NSString* path = relative.length ? [root stringByAppendingPathComponent:relative] : root;
  if (!PrivateDirectory(path)) return nil;
  if (relative.length && !PrivateDirectory([root stringByAppendingPathComponent:@"native-core-profiles"])) return nil;
  return path;
}
void Alert(NSString* title, NSString* message) { NSAlert* alert = [[NSAlert alloc] init]; alert.messageText = title; alert.informativeText = message; [alert addButtonWithTitle:@"OK"]; [alert runModal]; }
NSString* CountSummary(NSDictionary* preview) {
  NSDictionary* counts = preview[@"counts"], *excluded = preview[@"excluded"];
  NSString* legacy = @"";
  if ([preview[@"legacy"] isKindOfClass:NSDictionary.class]) legacy = [NSString stringWithFormat:@"\n\nOlder job references preserved: %@\nEncrypted error records archived: %@",preview[@"legacy"][@"jobAliases"] ?: @0,preview[@"legacy"][@"archivedDiagnosticEvents"] ?: @0];
  if ([preview[@"legacy"] isKindOfClass:NSDictionary.class] && preview[@"legacy"][@"pausedMemoryJobIdentities"]) {
    legacy = [legacy stringByAppendingFormat:@"\nConflicting job histories kept encrypted: %@\nJob identities kept paused: %@\nThese jobs will not restart automatically.",preview[@"legacy"][@"archivedMemoryJobs"],preview[@"legacy"][@"pausedMemoryJobIdentities"]];
    if (preview[@"legacy"][@"purgedMemoryJobArchives"]) legacy = [legacy stringByAppendingFormat:@"\nPreviously deleted job histories: %@",preview[@"legacy"][@"purgedMemoryJobArchives"]];
  }
  return [NSString stringWithFormat:@"Conversations: %@\nMessages: %@\nMemory records: %@\nTimeline entries: %@\n\nActive tasks to cancel: %@\nApprovals to clear: %@\nScheduled jobs to cancel: %@%@\n\nThis step transfers conversations, memory and task history. Browser data and saved credentials are not included. Connect providers again if needed after restart. Your existing profiles stay available.",
      counts[@"runtime_sessions"] ?: @0, counts[@"runtime_messages"] ?: @0, counts[@"memories"] ?: @0, counts[@"memory_timeline_events"] ?: @0,
      excluded[@"activeAgentRunsCancelled"] ?: @0, excluded[@"unexecutedApprovalsRetired"] ?: @0, excluded[@"scheduledJobsCancelled"] ?: @0,legacy];
}
bool SafeRecoveryPath(id value) {
  if (![value isKindOfClass:NSString.class]) return false;
  NSString* path = value;
  return path.isAbsolutePath && [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 4096 &&
      [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}
bool SafeRecoveryCounts(id value) {
  if (![value isKindOfClass:NSDictionary.class] || [value count] > 100) return false;
  NSCharacterSet* invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"] invertedSet];
  for (id name in value) {
    id number = value[name];
    if (![name isKindOfClass:NSString.class] || ![name length] || [name length] > 64 || [name rangeOfCharacterFromSet:invalid].location != NSNotFound ||
        ![number isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)number) == CFBooleanGetTypeID()) return false;
    const double count = [number doubleValue];
    if (!std::isfinite(count) || count < 0 || count > 9007199254740991.0 || std::floor(count) != count) return false;
  }
  return true;
}
bool SafeLegacyCounts(id value) {
  if (!value) return true;
  if (!SafeRecoveryCounts(value)) return false;
  const bool purged = value[@"purgedMemoryJobArchives"];
  const bool conflicts = value[@"archivedMemoryJobs"] || value[@"pausedMemoryJobIdentities"] || purged;
  return [value count] == (conflicts ? (purged ? 6 : 5) : 3) &&
      ([value[@"sourceSchemaVersion"] isEqual:@18] || [value[@"sourceSchemaVersion"] isEqual:@19]) &&
      value[@"jobAliases"] && value[@"archivedDiagnosticEvents"] &&
      [value[@"jobAliases"] unsignedLongLongValue] <= 250000 && [value[@"archivedDiagnosticEvents"] unsignedLongLongValue] <= 250000 &&
      (!conflicts || (value[@"archivedMemoryJobs"] && value[@"pausedMemoryJobIdentities"] &&
          [value[@"pausedMemoryJobIdentities"] unsignedLongLongValue] > 0 && [value[@"archivedMemoryJobs"] unsignedLongLongValue] <= 250000 &&
          (!purged || ([value[@"purgedMemoryJobArchives"] unsignedLongLongValue] > 0 && [value[@"purgedMemoryJobArchives"] unsignedLongLongValue] <= 250000)) &&
          [value[@"archivedMemoryJobs"] unsignedLongLongValue] + [value[@"purgedMemoryJobArchives"] unsignedLongLongValue] == 2 * [value[@"pausedMemoryJobIdentities"] unsignedLongLongValue]));
}
bool ValidInterruptedReview(NSDictionary* response, NSString* destination) {
  if (![response isKindOfClass:NSDictionary.class] || ![response[@"ok"] isEqual:@YES] ||
      ![response[@"reviewId"] isKindOfClass:NSString.class] || ![[NSUUID alloc] initWithUUIDString:response[@"reviewId"]] ||
      ![response[@"preview"] isKindOfClass:NSDictionary.class]) return false;
  NSDictionary* preview = response[@"preview"];
  NSString* digest = preview[@"recoverySha256"];
  return ([preview[@"state"] isEqual:@"staged"] || [preview[@"state"] isEqual:@"published"]) &&
      [preview[@"destinationDatabasePath"] isEqual:destination] && SafeRecoveryPath(preview[@"sourceDatabasePath"]) &&
      [digest isKindOfClass:NSString.class] && digest.length == 64 &&
      [digest rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound &&
      SafeRecoveryCounts(preview[@"counts"]) && SafeRecoveryCounts(preview[@"excluded"]) && SafeLegacyCounts(preview[@"legacy"]);
}
NSDictionary* RecoveryFileWitness(NSString* path, bool required) {
  if (!SafeRecoveryPath(path) || !PrivateDirectory(path.stringByDeletingLastPathComponent)) return nil;
  struct stat info{};
  if (lstat(path.fileSystemRepresentation,&info)) return !required && errno == ENOENT ? @{@"missing":@YES} : nil;
  if (!S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1) return nil;
  return @{@"device":@((unsigned long long)info.st_dev),@"inode":@((unsigned long long)info.st_ino),@"size":@(info.st_size),@"mode":@(info.st_mode),
      @"modifiedSeconds":@(info.st_mtimespec.tv_sec),@"modifiedNanos":@(info.st_mtimespec.tv_nsec),@"changedSeconds":@(info.st_ctimespec.tv_sec),@"changedNanos":@(info.st_ctimespec.tv_nsec)};
}
NSDictionary* RecoveryInputWitness(NSString* source, NSString* destination) {
  NSMutableDictionary* result = [NSMutableDictionary dictionary];
  for (NSString* path in @[source,[destination stringByAppendingString:@".kestrel-transfer-journal"],
      [[source.stringByDeletingLastPathComponent stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"secure/database-key.bin"]]) {
    NSDictionary* file = RecoveryFileWitness(path,true); if (!file) return nil; result[path] = file;
  }
  for (NSString* suffix in @[@"-wal",@"-shm",@"-journal"]) {
    NSString* path = [source stringByAppendingString:suffix];
    NSDictionary* file = RecoveryFileWitness(path,false); if (!file) return nil; result[path] = file;
  }
  return result;
}
NSDictionary* RecoveryWitness(NSString* source, NSString* destination) {
  NSMutableDictionary* result = [RecoveryInputWitness(source,destination) mutableCopy];
  if (!result) return nil;
  NSDictionary* target = RecoveryFileWitness(destination,true); if (!target) return nil; result[destination] = target;
  for (NSString* suffix in @[@"-wal",@"-shm",@"-journal"]) {
    NSString* path = [destination stringByAppendingString:suffix];
    NSDictionary* file = RecoveryFileWitness(path,false); if (!file) return nil; result[path] = file;
  }
  return result;
}
}

NSString* KestrelResolveNativeCoreProfile(NSString* browser_profile, NSError** error) {
  NSDictionary* selected = Selection(browser_profile);
  NSString* result = selected ? Profile(browser_profile, selected[@"active"]) : nil;
  if (!result && error) *error = Failure(@"Kestrel's data profile selection is unavailable. Existing profiles were preserved.");
  return result;
}

NSString* KestrelCanonicalNativeCoreTransferSource(NSString* selected_path) {
  // NSString's resolvingSymlinksInPath shortens /private/var back to /var on
  // macOS. The file checks and Node worker use realpath's canonical spelling.
  NSString* source = CanonicalPath(selected_path);
  return PrivateDirectory(source) && PrivateDirectory([source stringByAppendingPathComponent:@"secure"]) &&
      PrivateDirectory([source stringByAppendingPathComponent:@"database"]) ? source : nil;
}

KestrelNativeProfileSelectionResult KestrelSaveNativeCoreProfileSelection(NSString* root, NSString* active, NSString* previous, NSString* expected_active, NSString* expected_previous) {
  NSDictionary* current = Selection(root);
  if (!current || ![current[@"active"] isEqual:expected_active] || (expected_previous && ![current[@"previous"] isEqual:expected_previous]) || !ValidRelative(active) || !ValidRelative(previous) || !Profile(root, active) || !Profile(root, previous)) return KestrelNativeProfileSelectionResult::Unchanged;
  NSData* bytes = [NSJSONSerialization dataWithJSONObject:@{@"version":@1,@"active":active,@"previous":previous} options:0 error:nil];
  bool committed = false;
  if (bytes && WritePrivateFile([root stringByAppendingPathComponent:kSelectionName], bytes, true, &committed)) return KestrelNativeProfileSelectionResult::Selected;
  return committed ? KestrelNativeProfileSelectionResult::SelectedDurabilityUnconfirmed : KestrelNativeProfileSelectionResult::Unchanged;
}

@interface KestrelCoreTransferPipe : NSObject
@property(nonatomic,strong) NSTask* task;
@property(nonatomic,strong) NSFileHandle* input;
@property(nonatomic,strong) NSFileHandle* output;
@property(nonatomic,strong) NSMutableData* buffered;
@property(nonatomic) pid_t launchedPid;
@property(nonatomic) uint64_t launchedSeconds;
@property(nonatomic) uint64_t launchedMicroseconds;
@property(nonatomic) BOOL hasProcessIdentity;
- (BOOL)start;
- (void)recordTaskIdentity;
- (BOOL)taskMatchesLaunch;
- (NSDictionary*)request:(NSDictionary*)request;
- (BOOL)stop;
@end
@implementation KestrelCoreTransferPipe
- (BOOL)start {
  NSString* root = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"agent-core"];
  self.task = [[NSTask alloc] init]; self.task.executableURL = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"node/bin/node"]];
  self.task.arguments = @[@"--max-old-space-size=1536", [root stringByAppendingPathComponent:@"service/host-profile-file-transfer.js"], @"--protected-host-pipe"];
  NSMutableDictionary* environment = [NSMutableDictionary dictionary]; NSDictionary* inherited = NSProcessInfo.processInfo.environment;
  for (NSString* name in @[@"HOME",@"PATH",@"LANG",@"TMPDIR"]) if (inherited[name]) environment[name] = inherited[name];
  self.task.environment = environment;
  NSPipe* input = NSPipe.pipe; NSPipe* output = NSPipe.pipe;
  self.task.standardInput = input; self.task.standardOutput = output; self.task.standardError = NSFileHandle.fileHandleWithNullDevice;
  self.input = input.fileHandleForWriting; self.output = output.fileHandleForReading; self.buffered = NSMutableData.data;
  fcntl(self.input.fileDescriptor, F_SETNOSIGPIPE, 1);
  if (![self.task launchAndReturnError:nil]) return NO;
  [self recordTaskIdentity]; return YES;
}
- (void)recordTaskIdentity {
  self.launchedPid = self.task.processIdentifier; struct proc_bsdinfo info{};
  self.hasProcessIdentity = proc_pidinfo(self.launchedPid,PROC_PIDTBSDINFO,0,&info,sizeof(info)) == sizeof(info) && info.pbi_ppid == static_cast<uint32_t>(getpid());
  if (self.hasProcessIdentity) { self.launchedSeconds = info.pbi_start_tvsec; self.launchedMicroseconds = info.pbi_start_tvusec; }
}
- (BOOL)taskMatchesLaunch {
  struct proc_bsdinfo info{};
  return self.hasProcessIdentity && self.task.processIdentifier == self.launchedPid &&
      proc_pidinfo(self.launchedPid,PROC_PIDTBSDINFO,0,&info,sizeof(info)) == sizeof(info) &&
      info.pbi_ppid == static_cast<uint32_t>(getpid()) && info.pbi_start_tvsec == self.launchedSeconds && info.pbi_start_tvusec == self.launchedMicroseconds;
}
- (NSDictionary*)request:(NSDictionary*)request {
  if (!self.task.running || !self.input || !self.output) return nil;
  NSString* request_id = NSUUID.UUID.UUIDString.lowercaseString;
  NSMutableDictionary* body = [request mutableCopy]; body[@"requestId"] = request_id;
  NSMutableData* bytes = [[NSJSONSerialization dataWithJSONObject:body options:0 error:nil] mutableCopy];
  if (!bytes || bytes.length > kFrameLimit) return nil; [bytes appendBytes:"\n" length:1];
  size_t offset = 0; bool sent = true;
  while (offset < bytes.length) {
    const ssize_t count = write(self.input.fileDescriptor, static_cast<const uint8_t*>(bytes.bytes) + offset, bytes.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { sent = false; break; } offset += static_cast<size_t>(count);
  }
  Clear(bytes.mutableBytes, bytes.length); if (!sent) return nil;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
  const uint8_t newline = '\n';
  while (std::chrono::steady_clock::now() < deadline) {
    NSRange line = [self.buffered rangeOfData:[NSData dataWithBytes:&newline length:1] options:0 range:NSMakeRange(0,self.buffered.length)];
    if (line.location != NSNotFound) {
      if (line.location > kFrameLimit) return nil;
      NSData* data = [self.buffered subdataWithRange:NSMakeRange(0,line.location)];
      [self.buffered replaceBytesInRange:NSMakeRange(0,line.location+1) withBytes:nullptr length:0];
      id response = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      if (![response isKindOfClass:NSDictionary.class] || ![response[@"requestId"] isEqual:request_id] ||
          ![response[@"ok"] isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)response[@"ok"]) != CFBooleanGetTypeID()) return nil;
      if (![response[@"ok"] boolValue] && ![response[@"error"] isKindOfClass:NSDictionary.class]) return nil;
      return response;
    }
    pollfd ready{self.output.fileDescriptor,POLLIN,0}; const int status = poll(&ready,1,250);
    if (status < 0 && errno == EINTR) continue; if (status < 0) return nil;
    if (!status) continue;
    uint8_t chunk[4096]; const ssize_t count = read(self.output.fileDescriptor,chunk,sizeof(chunk));
    if (count <= 0) return nil;
    if (self.buffered.length + static_cast<size_t>(count) > kFrameLimit+1) return nil;
    [self.buffered appendBytes:chunk length:static_cast<NSUInteger>(count)];
  }
  return nil;
}
- (BOOL)stop {
  @try { [self.input closeFile]; } @catch (NSException*) {}
  self.input = nil;
  if (self.task.running && ![self taskMatchesLaunch]) return NO;
  @try { if (self.task.running) [self.task terminate]; } @catch (NSException*) {}
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (self.task.running && std::chrono::steady_clock::now() < deadline) usleep(10000);
  if (self.task.running) {
    // A hung private Node worker must not outlive a requested retry. Match the
    // launched child's kernel start time and parent before any forced signal;
    // a reused PID or another Kestrel process is never a cancellation target.
    if (![self taskMatchesLaunch]) return NO;
    if (kill(self.launchedPid,SIGKILL) && errno != ESRCH) return NO;
    deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (self.task.running && std::chrono::steady_clock::now() < deadline) usleep(10000);
    if (self.task.running) return NO;
  }
  @try { [self.output closeFile]; } @catch (NSException*) {}
  if (self.buffered.length) Clear(self.buffered.mutableBytes,self.buffered.length);
  self.output = nil; self.task = nil; self.buffered = nil; self.hasProcessIdentity = NO;
  return YES;
}
@end

@interface KestrelNativeProfileTransferController ()
@property(nonatomic,copy) NSString* browserProfile;
@property(nonatomic,copy) NSString* currentCoreProfile;
@property(nonatomic,copy) NSString* preparedProfile;
@property(nonatomic,copy) NSString* selectedSource;
@property(atomic,strong) KestrelCoreTransferPipe* pipe;
@property(nonatomic,strong) NSOpenPanel* picker;
@property(nonatomic,strong) NSAlert* reviewAlert;
@property(nonatomic) BOOL testKeys;
@property(nonatomic) BOOL busy;
@property(atomic) BOOL stopped;
@property(nonatomic,strong) dispatch_queue_t queue;
- (void)showPlan:(NSDictionary*)planned;
- (void)showTransferFailure:(NSString*)detail;
- (void)sourceClosed:(NSButton*)sender;
- (BOOL)interruptedRowIsCurrent:(NSDictionary*)row selection:(NSDictionary*)selection;
- (void)finishInterruptedWithTitle:(NSString*)title message:(NSString*)message;
- (void)showInterruptedReview:(NSDictionary*)reviewed row:(NSDictionary*)row selection:(NSDictionary*)selection;
- (void)showRecoveredSelection:(NSDictionary*)row selection:(NSDictionary*)selection witness:(NSDictionary*)witness source:(NSString*)source;
@end

@implementation KestrelNativeProfileTransferController
- (instancetype)initWithBrowserProfile:(NSString*)browserProfile currentCoreProfile:(NSString*)currentCoreProfile testKeys:(BOOL)testKeys {
  if ((self = [super init])) { _browserProfile = [browserProfile copy]; _currentCoreProfile = [currentCoreProfile copy]; _testKeys = testKeys; _queue = dispatch_queue_create("com.kestrel.profile-transfer",DISPATCH_QUEUE_SERIAL); }
  return self;
}
- (BOOL)canBegin { return !self.busy && !self.stopped; }
- (void)shutdown { self.stopped = YES; [self.picker cancel:nil]; if (self.reviewAlert) [NSApp abortModal]; dispatch_async(self.queue, ^{ [self.pipe stop]; self.pipe = nil; }); }
- (NSString*)destinationKey {
  NativeCoreProfileKeyStore store; std::string key, error;
  const auto identity = std::string(NSBundle.mainBundle.bundleIdentifier.UTF8String ?: "");
  const auto bundle = std::string(NSBundle.mainBundle.bundlePath.fileSystemRepresentation ?: "");
  if (!self.preparedProfile) {
    if (self.testKeys) {
      if (!store.GetOrCreateDisposableTestKey(std::string(self.browserProfile.fileSystemRepresentation),identity,bundle,&key,&error)) return nil;
      Clear(key.data(),key.size()); key.clear();
    }
    NSString* parent = [self.browserProfile stringByAppendingPathComponent:@"native-core-profiles"];
    if (!MakePrivateDirectory(parent)) return nil;
    NSString* fresh = [parent stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    if (mkdir(fresh.fileSystemRepresentation,0700) || !PrivateDirectory(fresh)) return nil;
    self.preparedProfile = fresh;
    if (self.testKeys && !WritePrivateFile([fresh stringByAppendingPathComponent:@".kestrel-native-test-profile-v1"], [@"native-test-profile-v1\n" dataUsingEncoding:NSUTF8StringEncoding], false)) return nil;
  }
  const bool ok = self.testKeys ? store.GetOrCreateDisposableTestKey(std::string(self.preparedProfile.fileSystemRepresentation),identity,bundle,&key,&error)
      : store.GetOrCreate(std::string(self.preparedProfile.fileSystemRepresentation),&key,&error);
  NSString* result = ok ? [NSString stringWithUTF8String:key.c_str()] : nil;
  Clear(key.data(),key.size());
  if (!result) return nil;
  NSString* core = [self.preparedProfile stringByAppendingPathComponent:@"native-core"];
  return MakePrivateDirectory(core) && MakePrivateDirectory([core stringByAppendingPathComponent:@"database"]) ? result : nil;
}
- (void)beginTransfer {
  if (![self canBegin]) return;
  if (self.pipe) {
    self.busy = YES;
    dispatch_async(self.queue, ^{
      const BOOL confirmed = [self.pipe stop];
      if (confirmed) self.pipe = nil;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stopped) return;
        self.busy = NO;
        if (confirmed) [self beginTransfer];
        else Alert(@"Transfer worker still stopping",@"The previous private transfer worker could not be confirmed stopped. Existing and prepared files were kept.");
      });
    });
    return;
  }
  NSError* error = nil; NSString* selected = KestrelResolveNativeCoreProfile(self.browserProfile,&error);
  if (![selected isEqualToString:self.currentCoreProfile]) { Alert(@"Restart Kestrel first",@"A different data profile is selected for the next launch. Quit and reopen Kestrel before starting another transfer."); return; }
  NSOpenPanel* picker = NSOpenPanel.openPanel; self.picker = picker; self.busy = YES;
  picker.title = @"Choose an existing Kestrel profile"; picker.message = @"Choose the Kestrel profile containing the conversations and memory you want to transfer.";
  picker.prompt = @"Review Profile"; picker.canChooseDirectories = YES; picker.canChooseFiles = NO; picker.canCreateDirectories = NO; picker.allowsMultipleSelection = NO;
  if (self.testKeys) picker.directoryURL = [NSURL fileURLWithPath:self.browserProfile.stringByDeletingLastPathComponent isDirectory:YES];
  __weak KestrelNativeProfileTransferController* weakSelf = self;
  [picker beginWithCompletionHandler:^(NSModalResponse result) {
    KestrelNativeProfileTransferController* owner = weakSelf; if (!owner || owner.stopped) return;
    owner.picker = nil;
    if (result != NSModalResponseOK || !picker.URL.isFileURL) { owner.busy = NO; return; }
    NSString* source = KestrelCanonicalNativeCoreTransferSource(picker.URL.path);
    if (!source) {
      owner.busy = NO; Alert(@"Profile unavailable",@"Choose an owned, private Kestrel profile folder containing its database and secure data. No existing files were changed."); return;
    }
    if (owner.testKeys) {
      NSString* temporary = CanonicalPath(NSFileManager.defaultManager.temporaryDirectory.path);
      NSData* marker = ReadPrivateFile([source stringByAppendingPathComponent:@".kestrel-native-transfer-source-test-v1"],64);
      if (!temporary || ![source hasPrefix:[temporary stringByAppendingString:@"/"]] || ![marker isEqualToData:[@"kestrel-transfer-source-test-v1\n" dataUsingEncoding:NSUTF8StringEncoding]]) {
        owner.busy = NO; Alert(@"Generated profile required",@"This disposable test session can review only a marked generated temporary profile. Real Kestrel data was not opened."); return;
      }
    }
    NSData* envelope = ReadPrivateFile([source stringByAppendingPathComponent:@"secure/database-key.bin"],256);
    if (!envelope) { owner.busy = NO; Alert(@"Profile key unavailable",@"This profile's protected database key could not be read safely. Existing data was preserved."); return; }
    const auto format = InspectLegacyKestrelCoreKey(std::span<const uint8_t>(static_cast<const uint8_t*>(envelope.bytes),static_cast<size_t>(envelope.length)));
    if (format == NativeLegacyCoreKeyFormat::Unsupported) { owner.busy = NO; Alert(@"Unsupported profile",@"This profile uses an unsupported key format. Existing data was preserved."); return; }
    if (owner.testKeys && format != NativeLegacyCoreKeyFormat::DevelopmentPlaintext) { owner.busy = NO; Alert(@"Development fixture required",@"This disposable test session cannot request a real Keychain password. Use a generated development profile."); return; }
    NSAlert* consent = [[NSAlert alloc] init]; consent.messageText = @"Review this Kestrel profile?";
    consent.informativeText = format == NativeLegacyCoreKeyFormat::DevelopmentPlaintext
        ? @"This development profile stores its encryption key without protection. Continue with a read-only data review? A separate destination profile will be prepared. Nothing will be imported until you review and apply the plan."
        : @"Kestrel will unlock this profile for a read-only data review. macOS may ask you to allow access to Kestrel Safe Storage. A separate protected destination profile will be prepared. Nothing will be imported until you review and apply the plan.";
    [consent addButtonWithTitle:@"Review Data"]; [consent addButtonWithTitle:@"Cancel"];
    if ([consent runModal] != NSAlertFirstButtonReturn) { owner.busy = NO; return; }
    owner.selectedSource = source;
    dispatch_async(owner.queue, ^{ @autoreleasepool {
      std::array<uint8_t,32> key{}; std::string failure; auto reader = CreateNativeLegacyKestrelKeychainReader();
      const bool unlocked = UnlockLegacyKestrelCoreKey(std::span<const uint8_t>(static_cast<const uint8_t*>(envelope.bytes),static_cast<size_t>(envelope.length)),*reader,NativeLegacyKeychainPromptPolicy::AllowUserPrompt,format == NativeLegacyCoreKeyFormat::DevelopmentPlaintext,&key,&failure);
      NSDictionary* planned = nil;
      if (unlocked && !owner.stopped) {
        NSString* destination_key = [owner destinationKey];
        if (destination_key && !owner.stopped) {
          owner.pipe = [[KestrelCoreTransferPipe alloc] init];
          if ([owner.pipe start]) {
            NSString* encoded = [[NSData dataWithBytes:key.data() length:key.size()] base64EncodedStringWithOptions:0];
            planned = [owner.pipe request:@{@"method":@"plan", @"sourceDatabasePath":[source stringByAppendingPathComponent:@"database/kestrel.sqlite"],
              @"destinationDatabasePath":[owner.preparedProfile stringByAppendingPathComponent:@"native-core/database/kestrel.sqlite"], @"sourceKeyBase64":encoded}];
          }
        }
      }
      Clear(key.data(),key.size());
      dispatch_async(dispatch_get_main_queue(), ^{ if (!owner.stopped) [owner showPlan:planned]; });
    } });
  }];
}
- (void)showPlan:(NSDictionary*)planned {
  if (![planned[@"ok"] boolValue] || ![planned[@"planId"] isKindOfClass:NSString.class] || ![planned[@"preview"] isKindOfClass:NSDictionary.class] ||
      ![planned[@"preview"][@"counts"] isKindOfClass:NSDictionary.class] || ![planned[@"preview"][@"excluded"] isKindOfClass:NSDictionary.class] ||
      ![planned[@"preview"][@"planSha256"] isKindOfClass:NSString.class] || !SafeLegacyCounts(planned[@"preview"][@"legacy"])) {
    if ([self.pipe stop]) self.pipe = nil;
    self.busy = NO;
    NSString* detail = [planned[@"error"][@"message"] isKindOfClass:NSString.class] ? planned[@"error"][@"message"] : @"The selected profile could not be unlocked or reviewed. Existing data was preserved.";
    if (self.preparedProfile) [self showTransferFailure:detail]; else Alert(@"Profile review unavailable",detail);
    return;
  }
  NSAlert* review = [[NSAlert alloc] init]; review.messageText = @"Transfer conversations and memory?";
  review.informativeText = [NSString stringWithFormat:@"Source: %@\n\n%@",self.selectedSource,CountSummary(planned[@"preview"])];
  [review addButtonWithTitle:@"Apply Transfer"]; [review addButtonWithTitle:@"Cancel"];
  NSButton* closed = [NSButton checkboxWithTitle:@"The Kestrel instance using this source is closed" target:self action:@selector(sourceClosed:)];
  closed.frame = NSMakeRect(0,0,390,32); review.accessoryView = closed; review.buttons.firstObject.enabled = NO; self.reviewAlert = review;
  std::cout << "KESTREL_NATIVE_CORE_TRANSFER_REVIEW_READY" << std::endl;
  const NSModalResponse decision = [review runModal]; self.reviewAlert = nil;
  if (decision != NSAlertFirstButtonReturn || closed.state != NSControlStateValueOn) { if ([self.pipe stop]) self.pipe = nil; self.busy = NO; return; }
  dispatch_async(self.queue, ^{ @autoreleasepool {
    NSString* destination_key = [self destinationKey];
    NSDictionary* applied = destination_key && !self.stopped ? [self.pipe request:@{@"method":@"apply",@"planId":planned[@"planId"],@"acceptedPlanSha256":planned[@"preview"][@"planSha256"],@"approved":@YES,@"destinationKeyBase64":destination_key}] : nil;
    NSDictionary* verified = [applied[@"ok"] boolValue] ? [self.pipe request:@{@"method":@"verify-recovery",@"recoveryId":applied[@"recoveryId"]}] : nil;
    const BOOL worker_stopped = !self.pipe || [self.pipe stop];
    if (worker_stopped) self.pipe = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.stopped) return;
      if ([verified[@"ok"] boolValue] && worker_stopped) {
        NSDictionary* current = Selection(self.browserProfile);
        NSString* relative = [@"native-core-profiles" stringByAppendingPathComponent:self.preparedProfile.lastPathComponent];
        NSString* active = current[@"active"];
        NSString* active_path = current ? Profile(self.browserProfile,active) : nil;
        const auto saved = [active_path isEqualToString:self.currentCoreProfile]
            ? KestrelSaveNativeCoreProfileSelection(self.browserProfile,relative,active,active) : KestrelNativeProfileSelectionResult::Unchanged;
        if (saved != KestrelNativeProfileSelectionResult::Unchanged) {
          self.preparedProfile = nil; self.busy = NO;
          Alert(saved == KestrelNativeProfileSelectionResult::Selected ? @"Transfer complete" : @"Transfer selected; storage needs attention",
              saved == KestrelNativeProfileSelectionResult::Selected
              ? @"The imported conversations and memory were verified. Quit and reopen Kestrel to use them. Your previous data profile and the original source remain available."
              : @"The verified transfer is selected for the next launch, but Kestrel could not confirm the final storage sync. Quit and reopen Kestrel to check the selection before shutting down this Mac. Both data profiles and the original source remain available.");
          std::cout << "KESTREL_NATIVE_CORE_TRANSFER_SELECTED" << std::endl; return;
        }
      }
      self.busy = NO;
      [self showTransferFailure:@"The transfer could not be activated safely. Your current data profile and the original source remain available."];
    });
  } });
}
- (void)showTransferFailure:(NSString*)detail {
  if (self.stopped) return;
  NSString* prepared = self.preparedProfile;
  if (!prepared) { self.busy = NO; Alert(@"Transfer needs review",detail); return; }
  self.busy = YES;
  NSAlert* choice = [[NSAlert alloc] init]; choice.messageText = @"Keep the prepared files and start again?";
  choice.informativeText = [NSString stringWithFormat:@"%@\n\nPrepared files stay in:\n%@\n\nKestrel will stop its private transfer worker, keep these files for review and let you choose the source again. The next transfer uses a separate destination. No prepared or existing data will be deleted.",detail,prepared];
  [choice addButtonWithTitle:@"Keep Files & Start Again"]; [choice addButtonWithTitle:@"Show Prepared Folder"]; [choice addButtonWithTitle:@"Cancel"];
  const NSModalResponse decision = [choice runModal];
  if (decision == NSAlertSecondButtonReturn) { self.busy = NO; [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[[NSURL fileURLWithPath:prepared isDirectory:YES]]]; return; }
  if (decision != NSAlertFirstButtonReturn) { self.busy = NO; return; }
  dispatch_async(self.queue, ^{ @autoreleasepool {
    const BOOL confirmed = !self.pipe || [self.pipe stop];
    if (confirmed) self.pipe = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.stopped) return;
      if (!confirmed) { self.busy = NO; Alert(@"Transfer worker still stopping",@"Kestrel could not confirm that its private transfer worker stopped. All files were kept. Leave this preparation available for review before retrying."); return; }
      NSDictionary* selected = Selection(self.browserProfile);
      NSString* relative = [@"native-core-profiles" stringByAppendingPathComponent:prepared.lastPathComponent];
      if (!selected || [selected[@"active"] isEqual:relative] || [selected[@"previous"] isEqual:relative] || ![self.preparedProfile isEqual:prepared]) {
        self.busy = NO; Alert(@"Restart Kestrel first",@"The data profile selection changed. Existing and prepared files were kept. Quit and reopen Kestrel before reviewing another transfer."); return;
      }
      // This is a fresh reviewed attempt, not an in-place recovery or deletion.
      // Keep the old canonical path and its key identity so later review remains
      // possible, including any interrupted SQLite journal or recovery lease.
      self.preparedProfile = nil; self.busy = NO;
      std::cout << "KESTREL_NATIVE_CORE_TRANSFER_RETRY_READY" << std::endl;
      [self beginTransfer];
    });
  } });
}
- (BOOL)interruptedRowIsCurrent:(NSDictionary*)row selection:(NSDictionary*)selection {
  NSDictionary* current = Selection(self.browserProfile);
  return !self.stopped && current && [current isEqualToDictionary:selection] &&
      [Profile(self.browserProfile,current[@"active"]) isEqualToString:self.currentCoreProfile] &&
      KestrelPreparedCoreProfileIsCurrent(self.browserProfile,row,current[@"active"],current[@"previous"]);
}
- (void)finishInterruptedWithTitle:(NSString*)title message:(NSString*)message {
  dispatch_async(self.queue, ^{ @autoreleasepool {
    const BOOL confirmed = !self.pipe || [self.pipe stop];
    if (confirmed) self.pipe = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.stopped) return;
      self.busy = NO;
      if (!confirmed) Alert(@"Transfer worker still stopping",@"Kestrel could not confirm that its private transfer worker stopped. All profiles and recovery files were kept. Quit and reopen Kestrel before another review.");
      else if (title) Alert(title,message);
    });
  } });
}
- (void)reviewInterruptedTransfers {
  if (![self canBegin]) return;
  if (self.pipe) {
    self.busy = YES;
    dispatch_async(self.queue, ^{
      const BOOL confirmed = [self.pipe stop]; if (confirmed) self.pipe = nil;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stopped) return;
        self.busy = NO;
        if (confirmed) [self reviewInterruptedTransfers];
        else Alert(@"Transfer worker still stopping",@"The previous private transfer worker could not be confirmed stopped. All files were kept.");
      });
    });
    return;
  }
  NSDictionary* selection = Selection(self.browserProfile);
  if (!selection || ![Profile(self.browserProfile,selection[@"active"]) isEqualToString:self.currentCoreProfile]) {
    Alert(@"Restart Kestrel first",@"The selected data profile is unavailable or has changed. Quit and reopen Kestrel before reviewing an interrupted transfer."); return;
  }
  NSError* error = nil;
  NSArray<NSDictionary*>* rows = KestrelInspectPreparedCoreProfiles(self.browserProfile,selection[@"active"],selection[@"previous"],&error);
  if (!rows) { Alert(@"Prepared profiles need review",error.localizedDescription ?: @"Prepared profiles could not be inspected safely. All files were preserved."); return; }
  if (!rows.count) { Alert(@"No interrupted transfers",@"No unselected prepared data profiles were found. Your current and previous data profiles were left in place."); return; }
  self.busy = YES;
  NSAlert* list = [[NSAlert alloc] init]; list.messageText = @"Review interrupted transfers";
  list.informativeText = @"Choose a prepared data profile to review. Recovery journals can be checked against the original source. Other prepared files stay available for a separate recovery review. Nothing is selected or unlocked at this step.";
  [list addButtonWithTitle:@"Review Transfer"]; [list addButtonWithTitle:@"Cancel"]; [list addButtonWithTitle:@"Show Prepared Folder"];
  NSPopUpButton* candidates = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(0,0,480,28) pullsDown:NO]; NSInteger preferred = -1;
  for (NSDictionary* row in rows) {
    [candidates addItemWithTitle:[NSString stringWithFormat:@"%@ — %@",[row[@"relative"] lastPathComponent],[row[@"hasJournal"] boolValue] ? @"Recovery journal" : @"Preserved files"]];
    if (preferred < 0 && [row[@"hasJournal"] boolValue]) preferred = candidates.numberOfItems-1;
  }
  if (preferred >= 0) [candidates selectItemAtIndex:preferred];
  list.accessoryView = candidates; self.reviewAlert = list;
  const NSModalResponse decision = [list runModal]; self.reviewAlert = nil;
  if (self.stopped) return;
  if (decision == NSAlertSecondButtonReturn || candidates.indexOfSelectedItem < 0) { self.busy = NO; return; }
  NSDictionary* row = rows[static_cast<NSUInteger>(candidates.indexOfSelectedItem)];
  if (![self interruptedRowIsCurrent:row selection:selection]) { self.busy = NO; Alert(@"Prepared profile changed",@"The profile or data selection changed during review. All files were kept. Start a new review."); return; }
  if (decision == NSAlertThirdButtonReturn) { self.busy = NO; [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[[NSURL fileURLWithPath:row[@"path"] isDirectory:YES]]]; return; }
  if (decision != NSAlertFirstButtonReturn) { self.busy = NO; return; }
  if (![row[@"hasJournal"] boolValue]) { self.busy = NO; Alert(@"Prepared files preserved",@"This folder has no safe recovery journal. Kestrel cannot authenticate or select it as a completed transfer. The folder was kept without opening its database or accessing a key."); return; }
  dispatch_async(self.queue, ^{ @autoreleasepool {
    NSDictionary* reviewed = nil;
    if ([self interruptedRowIsCurrent:row selection:selection]) {
      self.pipe = [[KestrelCoreTransferPipe alloc] init];
      if ([self.pipe start]) reviewed = [self.pipe request:@{@"method":@"inspect-interrupted",@"destinationDatabasePath":[row[@"path"] stringByAppendingPathComponent:@"native-core/database/kestrel.sqlite"]}];
    }
    dispatch_async(dispatch_get_main_queue(), ^{ if (!self.stopped) [self showInterruptedReview:reviewed row:row selection:selection]; });
  } });
}
- (void)showInterruptedReview:(NSDictionary*)reviewed row:(NSDictionary*)row selection:(NSDictionary*)selection {
  NSString* destination = [row[@"path"] stringByAppendingPathComponent:@"native-core/database/kestrel.sqlite"];
  if (!ValidInterruptedReview(reviewed,destination) || ![self interruptedRowIsCurrent:row selection:selection]) {
    NSString* detail = [reviewed[@"error"][@"message"] isKindOfClass:NSString.class] ? reviewed[@"error"][@"message"] : @"This preparation could not be reviewed safely. Incomplete stages and unknown files need a separate recovery review. All files were kept.";
    [self finishInterruptedWithTitle:@"Interrupted transfer preserved" message:detail]; return;
  }
  NSString* sourceDatabase = reviewed[@"preview"][@"sourceDatabasePath"];
  NSString* source = [sourceDatabase.stringByDeletingLastPathComponent stringByDeletingLastPathComponent];
  NSString* canonical = KestrelCanonicalNativeCoreTransferSource(source);
  if (![sourceDatabase.lastPathComponent isEqualToString:@"kestrel.sqlite"] || ![sourceDatabase.stringByDeletingLastPathComponent.lastPathComponent isEqualToString:@"database"] ||
      ![canonical isEqualToString:source] || [source isEqual:self.browserProfile] || [source isEqual:self.currentCoreProfile] || [source isEqual:row[@"path"]]) {
    [self finishInterruptedWithTitle:@"Original source unavailable" message:@"The recorded source is not an available, separate private Kestrel profile. All files were kept. No keys were accessed."]; return;
  }
  if (self.testKeys) {
    NSString* temporary = CanonicalPath(NSFileManager.defaultManager.temporaryDirectory.path);
    NSData* marker = ReadPrivateFile([source stringByAppendingPathComponent:@".kestrel-native-transfer-source-test-v1"],64);
    if (!temporary || ![source hasPrefix:[temporary stringByAppendingString:@"/"]] || ![marker isEqualToData:[@"kestrel-transfer-source-test-v1\n" dataUsingEncoding:NSUTF8StringEncoding]]) {
      [self finishInterruptedWithTitle:@"Generated profile required" message:@"This disposable session can recover only a marked generated temporary source. Real Kestrel data was not opened."]; return;
    }
  }
  // Inspect the bounded key envelope's format without unlocking it or asking
  // Keychain. Clear this host-owned copy immediately, including development keys.
  NSDictionary* inputWitness = RecoveryInputWitness(sourceDatabase,destination);
  NSMutableData* inspectedEnvelope = (NSMutableData*)ReadPrivateFile([source stringByAppendingPathComponent:@"secure/database-key.bin"],256);
  const auto reviewedFormat = inspectedEnvelope ? InspectLegacyKestrelCoreKey(std::span<const uint8_t>(static_cast<const uint8_t*>(inspectedEnvelope.bytes),static_cast<size_t>(inspectedEnvelope.length))) : NativeLegacyCoreKeyFormat::Unsupported;
  if (inspectedEnvelope) Clear(inspectedEnvelope.mutableBytes,inspectedEnvelope.length);
  if (!inputWitness || ![RecoveryInputWitness(sourceDatabase,destination) isEqualToDictionary:inputWitness] || reviewedFormat == NativeLegacyCoreKeyFormat::Unsupported || (self.testKeys && reviewedFormat != NativeLegacyCoreKeyFormat::DevelopmentPlaintext)) {
    [self finishInterruptedWithTitle:@"Source key unavailable" message:@"The original source key is missing, unsafe or unsupported. All files and existing keys were preserved."]; return;
  }
  NSAlert* review = [[NSAlert alloc] init]; review.messageText = @"Recover this interrupted transfer?";
  review.informativeText = [NSString stringWithFormat:@"Original source:\n%@\n\n%@\n\n%@ Kestrel will authenticate the original and prepared data using their existing keys. A separate choice lets you use the recovered profile after verification. Your current profile stays selected until then.",source,CountSummary(reviewed[@"preview"]),
      reviewedFormat == NativeLegacyCoreKeyFormat::DevelopmentPlaintext ? @"This development source stores its encryption key without protection." : @"Kestrel will unlock the protected keys. macOS may ask for Keychain access."];
  [review addButtonWithTitle:@"Recover Transfer"]; [review addButtonWithTitle:@"Cancel"];
  NSButton* closed = [NSButton checkboxWithTitle:@"The Kestrel instance using this source is closed" target:self action:@selector(sourceClosed:)];
  closed.frame = NSMakeRect(0,0,390,32); review.accessoryView = closed; review.buttons.firstObject.enabled = NO; self.reviewAlert = review;
  std::cout << "KESTREL_NATIVE_INTERRUPTED_TRANSFER_REVIEW_READY" << std::endl;
  const NSModalResponse decision = [review runModal]; self.reviewAlert = nil;
  if (self.stopped) return;
  if (decision != NSAlertFirstButtonReturn || closed.state != NSControlStateValueOn) { [self finishInterruptedWithTitle:nil message:nil]; return; }
  dispatch_async(self.queue, ^{ @autoreleasepool {
    NSDictionary* recovered = nil; NSDictionary* verified = nil;
    std::array<uint8_t,32> sourceKey{}; std::string destinationKey, failure;
    if ([self interruptedRowIsCurrent:row selection:selection] && [KestrelCanonicalNativeCoreTransferSource(source) isEqualToString:source] && [RecoveryInputWitness(sourceDatabase,destination) isEqualToDictionary:inputWitness]) {
      NSMutableData* envelope = (NSMutableData*)ReadPrivateFile([source stringByAppendingPathComponent:@"secure/database-key.bin"],256);
      if (envelope) {
        const auto bytes = std::span<const uint8_t>(static_cast<const uint8_t*>(envelope.bytes),static_cast<size_t>(envelope.length));
        const auto format = InspectLegacyKestrelCoreKey(bytes);
        if (format == reviewedFormat) {
          auto reader = CreateNativeLegacyKestrelKeychainReader();
          if (UnlockLegacyKestrelCoreKey(bytes,*reader,NativeLegacyKeychainPromptPolicy::AllowUserPrompt,format == NativeLegacyCoreKeyFormat::DevelopmentPlaintext,&sourceKey,&failure) && [self interruptedRowIsCurrent:row selection:selection]) {
            NativeCoreProfileKeyStore store;
            const bool existing = self.testKeys
                ? store.GetExistingDisposableTestKey(std::string([row[@"path"] fileSystemRepresentation]),std::string(NSBundle.mainBundle.bundleIdentifier.UTF8String ?: ""),std::string(NSBundle.mainBundle.bundlePath.fileSystemRepresentation ?: ""),&destinationKey,&failure)
                : store.GetExisting(std::string([row[@"path"] fileSystemRepresentation]),&destinationKey,&failure);
            if (existing && [self interruptedRowIsCurrent:row selection:selection] && [KestrelCanonicalNativeCoreTransferSource(source) isEqualToString:source] && [RecoveryInputWitness(sourceDatabase,destination) isEqualToDictionary:inputWitness]) {
              NSString* encodedSource = [[NSData dataWithBytes:sourceKey.data() length:sourceKey.size()] base64EncodedStringWithOptions:0];
              NSString* encodedDestination = [NSString stringWithUTF8String:destinationKey.c_str()];
              recovered = [self.pipe request:@{@"method":@"recover-interrupted",@"reviewId":reviewed[@"reviewId"],@"acceptedRecoverySha256":reviewed[@"preview"][@"recoverySha256"],@"approved":@YES,@"sourceKeyBase64":encodedSource,@"destinationKeyBase64":encodedDestination}];
            }
          }
        }
        Clear(envelope.mutableBytes,envelope.length);
      }
    }
    Clear(sourceKey.data(),sourceKey.size()); Clear(destinationKey.data(),destinationKey.size()); destinationKey.clear();
    NSDictionary* witness = [recovered[@"ok"] boolValue] && [RecoveryInputWitness(sourceDatabase,destination) isEqualToDictionary:inputWitness] ? RecoveryWitness(sourceDatabase,destination) : nil;
    if (witness && [recovered[@"recoveryId"] isKindOfClass:NSString.class] && !self.stopped)
      verified = [self.pipe request:@{@"method":@"verify-recovery",@"recoveryId":recovered[@"recoveryId"]}];
    const BOOL confirmed = !self.pipe || [self.pipe stop]; if (confirmed) self.pipe = nil;
    const BOOL unchanged = witness && [RecoveryWitness(sourceDatabase,destination) isEqualToDictionary:witness];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.stopped) return;
      if (!confirmed) { self.busy = NO; Alert(@"Transfer worker still stopping",@"The private worker could not be confirmed stopped. Recovery files were kept, and your current profile is still selected."); return; }
      std::cout << "KESTREL_NATIVE_INTERRUPTED_TRANSFER_WORKER_STOPPED" << std::endl;
      if (!unchanged || ![verified[@"ok"] boolValue] || ![verified[@"recovery"][@"originalReadable"] isEqual:@YES] || ![verified[@"recovery"][@"destinationReadable"] isEqual:@YES] || ![verified[@"recovery"][@"activationPerformed"] isEqual:@NO]) {
        self.busy = NO; Alert(@"Recovery needs another review",@"Kestrel could not authenticate and verify the recovered transfer. Existing keys and all data files were kept. Your current profile is still selected. Review the preparation again before retrying."); return;
      }
      std::cout << "KESTREL_NATIVE_INTERRUPTED_TRANSFER_RECOVERED" << std::endl;
      [self showRecoveredSelection:row selection:selection witness:witness source:sourceDatabase];
    });
  } });
}
- (void)showRecoveredSelection:(NSDictionary*)row selection:(NSDictionary*)selection witness:(NSDictionary*)witness source:(NSString*)source {
  if (![self interruptedRowIsCurrent:row selection:selection]) { self.busy = NO; Alert(@"Recovery preserved",@"The data selection changed after recovery. All files were kept. Start a new review before selecting the recovered profile."); return; }
  NSAlert* choice = [[NSAlert alloc] init]; choice.messageText = @"Recovered transfer verified";
  choice.informativeText = @"The original and recovered conversations and memory were authenticated, and the private transfer worker has stopped. Use the recovered data after restarting Kestrel, or keep your current profile. Recovery metadata stays available for a fresh review later.";
  [choice addButtonWithTitle:@"Use Recovered Data Profile"]; [choice addButtonWithTitle:@"Keep Current Profile"];
  self.reviewAlert = choice;
  std::cout << "KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTION_READY" << std::endl;
  const NSModalResponse decision = [choice runModal]; self.reviewAlert = nil;
  if (self.stopped) return;
  self.busy = NO;
  if (decision != NSAlertFirstButtonReturn) return;
  const auto saved = [self interruptedRowIsCurrent:row selection:selection] && [RecoveryWitness(source,[row[@"path"] stringByAppendingPathComponent:@"native-core/database/kestrel.sqlite"]) isEqualToDictionary:witness]
      ? KestrelSaveNativeCoreProfileSelection(self.browserProfile,row[@"relative"],selection[@"active"],selection[@"active"],selection[@"previous"])
      : KestrelNativeProfileSelectionResult::Unchanged;
  if (saved == KestrelNativeProfileSelectionResult::Unchanged) { Alert(@"Recovery preserved",@"The data profile selection changed or could not be saved. All files were kept. Start a new review."); return; }
  std::cout << "KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTED" << std::endl;
  Alert(saved == KestrelNativeProfileSelectionResult::Selected ? @"Recovered data profile selected" : @"Recovered data selected; storage needs attention",
      saved == KestrelNativeProfileSelectionResult::Selected
      ? @"Quit and reopen Kestrel to use the recovered conversations and memory. Your previous profile and the original source remain available."
      : @"The recovered profile is selected for the next launch, but Kestrel could not confirm the final storage sync. Quit and reopen Kestrel to check the selection before shutting down this Mac. All profiles remain available.");
}
- (void)sourceClosed:(NSButton*)sender { self.reviewAlert.buttons.firstObject.enabled = sender.state == NSControlStateValueOn; }
- (void)restorePrevious {
  if (![self canBegin]) return;
  NSDictionary* selected = Selection(self.browserProfile);
  if (!selected || [selected[@"active"] isEqual:selected[@"previous"]]) { Alert(@"No previous data profile",@"There is no earlier data profile selection to restore."); return; }
  NSAlert* choice = [[NSAlert alloc] init]; choice.messageText = @"Use the previous data profile?";
  choice.informativeText = @"This changes the conversations, memory and task history used after restart. Both profiles and any newer work remain on this Mac. Browser data is unchanged.";
  [choice addButtonWithTitle:@"Use Previous Data Profile"]; [choice addButtonWithTitle:@"Cancel"];
  if ([choice runModal] != NSAlertFirstButtonReturn) return;
  const auto saved = KestrelSaveNativeCoreProfileSelection(self.browserProfile,selected[@"previous"],selected[@"active"],selected[@"active"]);
  if (saved == KestrelNativeProfileSelectionResult::Unchanged) { Alert(@"Profile selection unavailable",@"The profile selection changed or could not be saved. Existing data was preserved."); return; }
  Alert(saved == KestrelNativeProfileSelectionResult::Selected ? @"Data profile selected" : @"Data profile selected; storage needs attention",
      saved == KestrelNativeProfileSelectionResult::Selected
      ? @"Quit and reopen Kestrel to use the previous data profile. The imported profile remains available."
      : @"The previous data profile is selected for the next launch, but Kestrel could not confirm the final storage sync. Quit and reopen Kestrel to check the selection before shutting down this Mac. Both data profiles remain available.");
  std::cout << "KESTREL_NATIVE_CORE_PREVIOUS_SELECTED" << std::endl;
}
@end
