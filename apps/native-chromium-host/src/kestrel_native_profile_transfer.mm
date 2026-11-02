#import <Cocoa/Cocoa.h>
#include <array>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <limits.h>
#include <iostream>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#include "kestrel_native_profile_transfer.h"
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
NSData* ReadPrivateFile(NSString* path, size_t maximum) {
  const int fd = open(path.fileSystemRepresentation, O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  if (fd < 0) return nil;
  struct stat info{};
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 ||
      (info.st_mode & 0077) || info.st_size <= 0 || static_cast<uint64_t>(info.st_size) > maximum) { close(fd); return nil; }
  NSMutableData* data = [NSMutableData dataWithLength:static_cast<NSUInteger>(info.st_size)];
  size_t offset = 0;
  while (offset < data.length) {
    const ssize_t count = read(fd, static_cast<uint8_t*>(data.mutableBytes) + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { close(fd); return nil; } offset += static_cast<size_t>(count);
  }
  uint8_t extra{}; const bool complete = read(fd, &extra, 1) == 0; close(fd);
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
void Clear(void* pointer, size_t size) { volatile uint8_t* bytes = static_cast<volatile uint8_t*>(pointer); while (size--) *bytes++ = 0; }
void Alert(NSString* title, NSString* message) { NSAlert* alert = [[NSAlert alloc] init]; alert.messageText = title; alert.informativeText = message; [alert addButtonWithTitle:@"OK"]; [alert runModal]; }
NSString* CountSummary(NSDictionary* preview) {
  NSDictionary* counts = preview[@"counts"], *excluded = preview[@"excluded"];
  return [NSString stringWithFormat:@"Conversations: %@\nMessages: %@\nMemory records: %@\nTimeline entries: %@\n\nActive tasks to cancel: %@\nApprovals to clear: %@\nScheduled jobs to cancel: %@\n\nThis step transfers conversations, memory and task history. Browser data and saved credentials are not included. Connect providers again if needed after restart. Your existing profiles stay available.",
      counts[@"runtime_sessions"] ?: @0, counts[@"runtime_messages"] ?: @0, counts[@"memories"] ?: @0, counts[@"memory_timeline_events"] ?: @0,
      excluded[@"activeAgentRunsCancelled"] ?: @0, excluded[@"unexecutedApprovalsRetired"] ?: @0, excluded[@"scheduledJobsCancelled"] ?: @0];
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

KestrelNativeProfileSelectionResult KestrelSaveNativeCoreProfileSelection(NSString* root, NSString* active, NSString* previous, NSString* expected_active) {
  NSDictionary* current = Selection(root);
  if (!current || ![current[@"active"] isEqual:expected_active] || !ValidRelative(active) || !ValidRelative(previous) || !Profile(root, active) || !Profile(root, previous)) return KestrelNativeProfileSelectionResult::Unchanged;
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
- (BOOL)start;
- (NSDictionary*)request:(NSDictionary*)request;
- (void)stop;
@end
@implementation KestrelCoreTransferPipe
- (BOOL)start {
  NSString* root = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"agent-core"];
  self.task = [[NSTask alloc] init]; self.task.executableURL = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"node/bin/node"]];
  self.task.arguments = @[[root stringByAppendingPathComponent:@"service/host-profile-file-transfer.js"], @"--protected-host-pipe"];
  NSMutableDictionary* environment = [NSMutableDictionary dictionary]; NSDictionary* inherited = NSProcessInfo.processInfo.environment;
  for (NSString* name in @[@"HOME",@"PATH",@"LANG",@"TMPDIR"]) if (inherited[name]) environment[name] = inherited[name];
  self.task.environment = environment;
  NSPipe* input = NSPipe.pipe; NSPipe* output = NSPipe.pipe;
  self.task.standardInput = input; self.task.standardOutput = output; self.task.standardError = NSFileHandle.fileHandleWithNullDevice;
  self.input = input.fileHandleForWriting; self.output = output.fileHandleForReading; self.buffered = NSMutableData.data;
  fcntl(self.input.fileDescriptor, F_SETNOSIGPIPE, 1);
  return [self.task launchAndReturnError:nil];
}
- (NSDictionary*)request:(NSDictionary*)request {
  if (!self.task.running) return nil;
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
  const auto deadline = NSDate.date.timeIntervalSince1970 + 120;
  const uint8_t newline = '\n';
  while (NSDate.date.timeIntervalSince1970 < deadline) {
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
- (void)stop {
  @try { [self.input closeFile]; } @catch (NSException*) {}
  @try { if (self.task.running) [self.task terminate]; } @catch (NSException*) {}
  self.input = nil; self.output = nil; self.task = nil; self.buffered = nil;
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
- (void)sourceClosed:(NSButton*)sender;
@end

@implementation KestrelNativeProfileTransferController
- (instancetype)initWithBrowserProfile:(NSString*)browserProfile currentCoreProfile:(NSString*)currentCoreProfile testKeys:(BOOL)testKeys {
  if ((self = [super init])) { _browserProfile = [browserProfile copy]; _currentCoreProfile = [currentCoreProfile copy]; _testKeys = testKeys; _queue = dispatch_queue_create("com.kestrel.profile-transfer",DISPATCH_QUEUE_SERIAL); }
  return self;
}
- (BOOL)canBegin { return !self.busy && !self.stopped; }
- (void)shutdown { self.stopped = YES; [self.picker cancel:nil]; dispatch_async(self.queue, ^{ [self.pipe stop]; self.pipe = nil; }); }
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
      ![planned[@"preview"][@"planSha256"] isKindOfClass:NSString.class]) {
    [self.pipe stop]; self.pipe = nil; self.busy = NO;
    NSString* detail = [planned[@"error"][@"message"] isKindOfClass:NSString.class] ? planned[@"error"][@"message"] : @"The selected profile could not be unlocked or reviewed. Existing data was preserved.";
    Alert(@"Profile review unavailable",detail); return;
  }
  NSAlert* review = [[NSAlert alloc] init]; review.messageText = @"Transfer conversations and memory?";
  review.informativeText = [NSString stringWithFormat:@"Source: %@\n\n%@",self.selectedSource,CountSummary(planned[@"preview"])];
  [review addButtonWithTitle:@"Apply Transfer"]; [review addButtonWithTitle:@"Cancel"];
  NSButton* closed = [NSButton checkboxWithTitle:@"The Kestrel instance using this source is closed" target:self action:@selector(sourceClosed:)];
  closed.frame = NSMakeRect(0,0,390,32); review.accessoryView = closed; review.buttons.firstObject.enabled = NO; self.reviewAlert = review;
  const NSModalResponse decision = [review runModal]; self.reviewAlert = nil;
  if (decision != NSAlertFirstButtonReturn || closed.state != NSControlStateValueOn) { [self.pipe stop]; self.pipe = nil; self.busy = NO; return; }
  dispatch_async(self.queue, ^{ @autoreleasepool {
    NSString* destination_key = [self destinationKey];
    NSDictionary* applied = destination_key && !self.stopped ? [self.pipe request:@{@"method":@"apply",@"planId":planned[@"planId"],@"acceptedPlanSha256":planned[@"preview"][@"planSha256"],@"approved":@YES,@"destinationKeyBase64":destination_key}] : nil;
    NSDictionary* verified = [applied[@"ok"] boolValue] ? [self.pipe request:@{@"method":@"verify-recovery",@"recoveryId":applied[@"recoveryId"]}] : nil;
    [self.pipe stop]; self.pipe = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.stopped) return;
      if ([verified[@"ok"] boolValue]) {
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
      Alert(@"Transfer needs review",@"The transfer could not be activated safely. Existing profiles and any prepared data were preserved. Do not retry an interrupted import until its recovery state has been reviewed.");
    });
  } });
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
