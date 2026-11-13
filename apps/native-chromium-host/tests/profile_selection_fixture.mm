#import <Foundation/Foundation.h>
#include "kestrel_native_profile_transfer.h"
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <membership.h>
#include <sys/stat.h>
#include <sys/proc.h>
#include <unistd.h>
#include "kestrel_legacy_core_key.h"

static size_t FixtureLegacyReaderCalls = 0;
static std::unique_ptr<NativeLegacyKestrelKeychainReader> FixtureLegacyReader() {
  ++FixtureLegacyReaderCalls;
  return CreateNativeLegacyKestrelKeychainReader();
}

// Compile the production module below with a fixture-only sync replacement.
// The shipping source and executable have no fault flag or replacement.
static int FixtureFsync(int fd) {
  const char* fault = getenv("KESTREL_SELECTION_FIXTURE_FSYNC_FAULT");
  struct stat info{};
  if (fault && !fstat(fd,&info) && ((!strcmp(fault,"directory") && S_ISDIR(info.st_mode)) || (!strcmp(fault,"file") && S_ISREG(info.st_mode)))) { errno = EIO; return -1; }
  return fsync(fd);
}
#define fsync FixtureFsync
#define CreateNativeLegacyKestrelKeychainReader FixtureLegacyReader
#include "../src/kestrel_native_profile_transfer.mm"
#undef CreateNativeLegacyKestrelKeychainReader
#undef fsync

class ReadOnlySourceFixtureBackend final : public NativeCoreKeychainBackend {
 public:
  size_t reads = 0, creates = 0;
  bool found = true;
  std::function<void()> onRead;
  NativeCoreKeychainResult Read(const std::string&,std::vector<unsigned char>* bytes) override {
    ++reads;
    if (onRead) onRead();
    if (!found) return NativeCoreKeychainResult::NotFound;
    bytes->assign(32,0x4a); return NativeCoreKeychainResult::Success;
  }
  NativeCoreKeychainResult Add(const std::string&,const std::vector<unsigned char>&) override {
    ++creates; return NativeCoreKeychainResult::Failure;
  }
};

// Stop at the next UI-entry boundary so retry cleanup exercises the actual
// controller queue without opening a picker, alert or native application.
@interface FixtureRetryController : KestrelNativeProfileTransferController
@property(nonatomic) NSUInteger entries;
@property(nonatomic) BOOL reentered;
@end
@implementation FixtureRetryController
- (void)beginTransfer { if (++self.entries == 1) [super beginTransfer]; else self.reentered = YES; }
- (void)reviewInterruptedTransfers { if (++self.entries == 1) [super reviewInterruptedTransfers]; else self.reentered = YES; }
@end
@interface FixtureRetryPipe : KestrelCoreTransferPipe
@property(nonatomic,weak) FixtureRetryController* owner;
@property(nonatomic) BOOL confirmed;
@property(atomic) BOOL stopCalled;
@end
@implementation FixtureRetryPipe
- (BOOL)stop {
  // On an uncertain stop, model owner shutdown before the main-queue alert.
  // This leaves the actual guarded cleanup path intact without native UI.
  if (!self.confirmed) self.owner.stopped = YES;
  self.stopCalled = YES;
  return self.confirmed;
}
@end

int main(int argc, char** argv) {
  @autoreleasepool {
    if ((argc == 4 || argc == 5) && !strcmp(argv[2],"--native-source")) {
      NSString* owner = [NSString stringWithUTF8String:argv[1]], *action = [NSString stringWithUTF8String:argv[3]];
      NSDictionary* descriptor = NativeSourceDescriptor(owner);
      KestrelNativeTransferSourceLease* lease = nil;
      int busyFd = -1;
      std::unique_ptr<kestrel::ProfileReservation> busyReservation;
      NSString* vault = [descriptor[@"profileRoot"] stringByAppendingPathComponent:@".kestrel-local-vault-v1"];
      NSString* database = [descriptor[@"coreRoot"] stringByAppendingPathComponent:@"database/kestrel.sqlite"];
      NSData* originalVault = vault ? ReadPrivateFile(vault,16384) : nil;
      NSData* originalDatabase = database ? ReadPrivateFile(database,16384) : nil;
      NSString* selectionPath = [owner stringByAppendingPathComponent:kSelectionName];
      NSData* originalSelection = ReadPrivateFile(selectionPath,32768);
      if ([action isEqual:@"busy-source"]) {
        busyFd = open([owner stringByAppendingPathComponent:@".kestrel-desktop.lock"].fileSystemRepresentation,O_RDWR|O_NOFOLLOW);
        if (busyFd < 0 || flock(busyFd,LOCK_EX|LOCK_NB)) return 2;
      }
      if ([action isEqual:@"busy-reservation"] || [action isEqual:@"busy-active-reservation"]) {
        kestrel::ProfileReservationError error;
        NSString* reserved = [action isEqual:@"busy-active-reservation"] ? descriptor[@"profileRoot"] : owner;
        busyReservation = kestrel::ProfileReservation::Acquire(std::string(reserved.fileSystemRepresentation),&error);
        if (!busyReservation) return 2;
      }
      if (descriptor) lease = [KestrelNativeTransferSourceLease acquire:descriptor];
      if ([action hasPrefix:@"retry-"]) {
        if (!lease) return 2;
        FixtureRetryController* controller = [[FixtureRetryController alloc] initWithBrowserProfile:owner currentCoreProfile:owner testKeys:NO];
        FixtureRetryPipe* pipe = [[FixtureRetryPipe alloc] init];
        pipe.confirmed = [action hasSuffix:@"confirmed"]; pipe.owner = controller;
        controller.pipe = pipe; controller.sourceLease = lease;
        if ([action hasPrefix:@"retry-recovery-"]) [controller reviewInterruptedTransfers]; else [controller beginTransfer];
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(750);
        while (std::chrono::steady_clock::now() < deadline && !(pipe.stopCalled && (controller.reentered || controller.stopped))) {
          CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.01,true);
        }
        NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"stopCalled":@(pipe.stopCalled),@"reentered":@(controller.reentered),
            @"pipeRetained":@(controller.pipe != nil),@"leaseRetained":@(controller.sourceLease != nil)} options:0 error:nil];
        return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
      }
      auto backend = std::make_shared<ReadOnlySourceFixtureBackend>();
      backend->found = ![action isEqual:@"lookup-missing"];
      NativeCoreProfileKeyStore store(backend);
      if ([action isEqual:@"mutate-vault"]) {
        NSMutableData* changed = [originalVault mutableCopy]; const uint8_t byte = 7; [changed appendBytes:&byte length:1];
        if (!WritePrivateFile(vault,changed,true)) return 2;
      }
      if ([action isEqual:@"replace-vault"] && !WritePrivateFile(vault,originalVault,true)) return 2;
      if ([action isEqual:@"move-owner"] && rename(owner.fileSystemRepresentation,[owner stringByAppendingString:@"-kept"].fileSystemRepresentation)) return 2;
      if ([action isEqual:@"mutate-selection"]) {
        NSDictionary* selection = descriptor[@"selection"];
        NSData* changed = [NSJSONSerialization dataWithJSONObject:selection options:NSJSONWritingPrettyPrinted error:nil];
        if (!WritePrivateFile([owner stringByAppendingPathComponent:kSelectionName],changed,true)) return 2;
      }
      if ([action isEqual:@"switch-selection"]) {
        NSMutableDictionary* selection = [descriptor[@"selection"] mutableCopy]; selection[@"active"] = @"";
        NSData* changed = [NSJSONSerialization dataWithJSONObject:selection options:0 error:nil];
        if (!WritePrivateFile([owner stringByAppendingPathComponent:kSelectionName],changed,true)) return 2;
      }
      if ([action isEqual:@"changed-during-lookup"]) backend->onRead = [=] {
        if (!WritePrivateFile(vault,originalVault,true)) abort();
      };
      if ([action isEqual:@"replace-core"]) {
        NSString* core = descriptor[@"coreRoot"];
        if (rename(core.fileSystemRepresentation,[core stringByAppendingString:@"-kept"].fileSystemRepresentation) || mkdir(core.fileSystemRepresentation,0700)) return 2;
      }
      if ([@[@"root-metadata-only",@"active-profile-metadata-only",@"core-metadata-only",@"database-metadata-only"] containsObject:action]) {
        NSString* target = [action isEqual:@"root-metadata-only"] ? owner : [action isEqual:@"active-profile-metadata-only"]
            ? descriptor[@"profileRoot"] : [action isEqual:@"core-metadata-only"] ? descriptor[@"coreRoot"] : [descriptor[@"coreRoot"] stringByAppendingPathComponent:@"database"];
        struct stat before{}, after{};
        if (lstat(target.fileSystemRepresentation,&before) || chmod(target.fileSystemRepresentation,0500)) return 2;
        usleep(1000);
        if (chmod(target.fileSystemRepresentation,0700) || lstat(target.fileSystemRepresentation,&after) ||
            before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_mode != after.st_mode ||
            before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
            (before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec)) return 2;
      }
      if ([action isEqual:@"root-acl-change"]) {
        struct stat before{}, after{};
        if (lstat(owner.fileSystemRepresentation,&before)) return 2;
        uuid_t ownerUuid{};
        acl_t acl = acl_init(1); acl_entry_t entry; acl_permset_t permissions;
        const bool changed = acl && !mbr_uid_to_uuid(getuid(),ownerUuid) && !acl_create_entry(&acl,&entry) &&
            !acl_set_tag_type(entry,ACL_EXTENDED_ALLOW) && !acl_set_qualifier(entry,ownerUuid) &&
            !acl_get_permset(entry,&permissions) && !acl_add_perm(permissions,ACL_READ_ATTRIBUTES) &&
            !acl_set_permset(entry,permissions) && !acl_set_file(owner.fileSystemRepresentation,ACL_TYPE_EXTENDED,acl);
        if (acl) acl_free(acl);
        if (!changed || lstat(owner.fileSystemRepresentation,&after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
            before.st_mode != after.st_mode || before.st_uid != after.st_uid || before.st_gid != after.st_gid ||
            before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) return 2;
      }
      if ([action isEqual:@"root-group-change"]) {
        struct stat before{}, after{};
        if (lstat(owner.fileSystemRepresentation,&before)) return 2;
        const int count = getgroups(0,nullptr); if (count <= 0) return 2;
        std::vector<gid_t> groups(static_cast<size_t>(count)); if (getgroups(count,groups.data()) != count) return 2;
        gid_t alternate = before.st_gid;
        for (gid_t group : groups) if (group != before.st_gid) { alternate = group; break; }
        if (alternate == before.st_gid || chown(owner.fileSystemRepresentation,static_cast<uid_t>(-1),alternate) ||
            lstat(owner.fileSystemRepresentation,&after) || before.st_gid == after.st_gid || before.st_mode != after.st_mode || before.st_uid != after.st_uid ||
            before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_flags != after.st_flags ||
            before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
            ![OwnerAclWitness(owner,after) isEqual:descriptor[@"witness"][owner][@"aclSha256"]]) return 2;
      }
      std::array<uint8_t,32> key{};
      const bool opened = [lease isCurrent] && ExistingNativeSourceKey(descriptor,&key,&store);
      bool failureCleared = true;
      if (!opened) for (uint8_t byte : key) failureCleared = failureCleared && byte == 0;
      bool bindingValid = false, wrongKeyRejected = false, bindingNoKeys = false, bindingWitness = false;
      bool reservationsBlock = false, preparedReadable = false;
      if (lease && [lease isCurrent]) {
        kestrel::ProfileReservationError ownerError, activeError;
        auto ownerAttempt = kestrel::ProfileReservation::Acquire(std::string(owner.fileSystemRepresentation),&ownerError);
        auto activeAttempt = kestrel::ProfileReservation::Acquire(std::string([descriptor[@"profileRoot"] fileSystemRepresentation]),&activeError);
        reservationsBlock = !ownerAttempt && !activeAttempt && ownerError == kestrel::ProfileReservationError::kBusy && activeError == kestrel::ProfileReservationError::kBusy;
        NSDictionary* selection = descriptor[@"selection"];
        preparedReadable = KestrelInspectPreparedCoreProfiles(owner,selection[@"active"],selection[@"previous"],nil) != nil;
      }
      if (argc == 5 && descriptor && [lease isCurrent]) {
        NSString* destination = [NSString stringWithUTF8String:argv[4]], *handoff = @"123e4567-e89b-42d3-a456-426614174000";
        std::array<uint8_t,32> generatedDestination{}; generatedDestination.fill(0x6b);
        NSString* encoded = [[NSData dataWithBytes:generatedDestination.data() length:generatedDestination.size()] base64EncodedStringWithOptions:0];
        if (!SaveSourceBinding(destination,handoff,descriptor,encoded)) return 2;
        NSDictionary* binding = ReadSourceBinding(destination,handoff,database);
        bindingValid = binding && AuthenticateSourceBinding(binding,encoded);
        wrongKeyRejected = !AuthenticateSourceBinding(binding,[[NSData dataWithBytes:key.data() length:key.size()] base64EncodedStringWithOptions:0]);
        NSString* text = [[NSString alloc] initWithData:ReadPrivateFile([destination stringByAppendingPathComponent:kSourceBindingName],kFrameLimit) encoding:NSUTF8StringEncoding];
        bindingNoKeys = ![text containsString:encoded] && ![text containsString:[[NSData dataWithBytes:key.data() length:key.size()] base64EncodedStringWithOptions:0]];
        NSString* target = [destination stringByAppendingPathComponent:@"native-core/database/kestrel.sqlite"];
        bindingWitness = RecoveryInputWitness(database,target) != nil;
        if ([action isEqual:@"tamper-binding"]) {
          NSMutableDictionary* changed = [binding mutableCopy]; changed[@"mac"] = [[NSMutableData dataWithLength:32] base64EncodedStringWithOptions:0];
          NSData* bytes = [NSJSONSerialization dataWithJSONObject:changed options:0 error:nil];
          if (!WritePrivateFile([destination stringByAppendingPathComponent:kSourceBindingName],bytes,true)) return 2;
          bindingValid = AuthenticateSourceBinding(ReadSourceBinding(destination,handoff,database),encoded);
        }
        if ([action isEqual:@"stale-binding"]) {
          if (!WritePrivateFile(vault,originalVault,true)) return 2;
          bindingValid = AuthenticateSourceBinding(ReadSourceBinding(destination,handoff,database),encoded);
          bindingWitness = RecoveryInputWitness(database,target) != nil;
        }
      }
      const bool sourceUnchanged = (!originalVault || [ReadPrivateFile(vault,16384) isEqualToData:originalVault]) &&
          (!originalDatabase || [ReadPrivateFile(database,16384) isEqualToData:originalDatabase]) &&
          (originalSelection ? [ReadPrivateFile(selectionPath,32768) isEqualToData:originalSelection] : MissingPath(selectionPath));
      Clear(key.data(),key.size());
      if (busyFd >= 0) close(busyFd);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"valid":@(descriptor != nil),@"profile":descriptor[@"profileRoot"] ?: NSNull.null,
          @"lease":@(lease != nil),@"current":@([lease isCurrent]),@"opened":@(opened),@"reads":@(backend->reads),@"creates":@(backend->creates),
          @"legacyReaders":@(FixtureLegacyReaderCalls),@"sourceUnchanged":@(sourceUnchanged),@"failureCleared":@(failureCleared),@"bindingValid":@(bindingValid),
          @"wrongKeyRejected":@(wrongKeyRejected),@"bindingNoKeys":@(bindingNoKeys),@"bindingWitness":@(bindingWitness),
          @"reservationsBlock":@(reservationsBlock),@"preparedReadable":@(preparedReadable)} options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
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
    if (argc == 3 && !strcmp(argv[2], "--project-handoff-validation")) {
      NSString* identifier = @"123e4567-e89b-42d3-a456-426614174000";
      NSMutableDictionary* fresh = [@{ @"id":identifier, @"projects":@2, @"pendingIdentities":@3,
        @"instructions":@1, @"registryPresent":@YES } mutableCopy];
      const BOOL validFresh = SafeProjectHandoffPreview(fresh,identifier,false);
      NSMutableDictionary* recovery = [fresh mutableCopy]; recovery[@"manifestPresent"] = @NO;
      const BOOL validRecovery = SafeProjectHandoffPreview(recovery,identifier,true);
      BOOL badFreshExtra = NO, badFreshMissing = NO, badFreshType = NO, badFreshRange = NO, badFreshID = NO;
      BOOL badRecoveryExtra = NO, badRecoveryMissing = NO, badRecoveryType = NO, badRecoveryRange = NO, badRecoveryID = NO;
      fresh[@"unexpected"] = @0; badFreshExtra = !SafeProjectHandoffPreview(fresh,identifier,false); [fresh removeObjectForKey:@"unexpected"];
      [fresh removeObjectForKey:@"instructions"]; badFreshMissing = !SafeProjectHandoffPreview(fresh,identifier,false); fresh[@"instructions"] = @1;
      fresh[@"registryPresent"] = @1; badFreshType = !SafeProjectHandoffPreview(fresh,identifier,false); fresh[@"registryPresent"] = @YES;
      fresh[@"projects"] = @501; badFreshRange = !SafeProjectHandoffPreview(fresh,identifier,false); fresh[@"projects"] = @2;
      fresh[@"id"] = @"not-a-uuid"; badFreshID = !SafeProjectHandoffPreview(fresh,identifier,false); fresh[@"id"] = identifier;
      recovery[@"unexpected"] = @0; badRecoveryExtra = !SafeProjectHandoffPreview(recovery,identifier,true); [recovery removeObjectForKey:@"unexpected"];
      [recovery removeObjectForKey:@"manifestPresent"]; badRecoveryMissing = !SafeProjectHandoffPreview(recovery,identifier,true); recovery[@"manifestPresent"] = @NO;
      recovery[@"manifestPresent"] = @0; badRecoveryType = !SafeProjectHandoffPreview(recovery,identifier,true); recovery[@"manifestPresent"] = @NO;
      recovery[@"pendingIdentities"] = @-1; badRecoveryRange = !SafeProjectHandoffPreview(recovery,identifier,true); recovery[@"pendingIdentities"] = @3;
      recovery[@"id"] = @"123E4567-E89B-42D3-A456-426614174000"; badRecoveryID = !SafeProjectHandoffPreview(recovery,identifier,true);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{ @"validFresh":@(validFresh), @"validRecovery":@(validRecovery),
        @"badFreshExtra":@(badFreshExtra), @"badFreshMissing":@(badFreshMissing), @"badFreshType":@(badFreshType), @"badFreshRange":@(badFreshRange), @"badFreshID":@(badFreshID),
        @"badRecoveryExtra":@(badRecoveryExtra), @"badRecoveryMissing":@(badRecoveryMissing), @"badRecoveryType":@(badRecoveryType), @"badRecoveryRange":@(badRecoveryRange), @"badRecoveryID":@(badRecoveryID) } options:0 error:nil];
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
      value[@"jobAliases"] = @250001; BOOL badLimit = !SafeLegacyCounts(value);
      value[@"jobAliases"] = @1; value[@"sourceSchemaVersion"] = @20; BOOL badVersion = !SafeLegacyCounts(value);
      value[@"sourceSchemaVersion"] = @19; value[@"unknown"] = @0; BOOL badFields = !SafeLegacyCounts(value);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"valid":@(valid),@"badBool":@(badBool),@"badLimit":@(badLimit),@"badVersion":@(badVersion),@"badFields":@(badFields)} options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if (argc == 3 && !strcmp(argv[2], "--conflict-review-validation")) {
      NSMutableDictionary* value = [@{@"sourceSchemaVersion":@19,@"jobAliases":@1,@"archivedDiagnosticEvents":@0,@"archivedMemoryJobs":@2,@"pausedMemoryJobIdentities":@1} mutableCopy];
      BOOL valid = SafeLegacyCounts(value);
      BOOL disclosed = [CountSummary(@{@"legacy":value,@"counts":@{},@"excluded":@{}}) containsString:@"These jobs will not restart automatically."];
      value[@"archivedMemoryJobs"] = @YES; BOOL badBool = !SafeLegacyCounts(value);
      value[@"archivedMemoryJobs"] = @3; BOOL badPair = !SafeLegacyCounts(value);
      value[@"archivedMemoryJobs"] = @0; value[@"pausedMemoryJobIdentities"] = @0; BOOL badZero = !SafeLegacyCounts(value);
      [value removeObjectForKey:@"pausedMemoryJobIdentities"]; BOOL badMissing = !SafeLegacyCounts(value);
      value[@"archivedMemoryJobs"] = @1; value[@"pausedMemoryJobIdentities"] = @1; value[@"purgedMemoryJobArchives"] = @1; BOOL partialPurge = SafeLegacyCounts(value);
      value[@"archivedMemoryJobs"] = @0; value[@"purgedMemoryJobArchives"] = @2; BOOL completePurge = SafeLegacyCounts(value);
      BOOL purgeDisclosed = [CountSummary(@{@"legacy":value,@"counts":@{},@"excluded":@{}}) containsString:@"Previously deleted job histories: 2"];
      value[@"purgedMemoryJobArchives"] = @3; BOOL badPurgeCount = !SafeLegacyCounts(value);
      NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"valid":@(valid),@"disclosed":@(disclosed),@"badBool":@(badBool),@"badPair":@(badPair),@"badZero":@(badZero),@"badMissing":@(badMissing),@"partialPurge":@(partialPurge),@"completePurge":@(completePurge),@"purgeDisclosed":@(purgeDisclosed),@"badPurgeCount":@(badPurgeCount)} options:0 error:nil];
      return result && fwrite(result.bytes,1,result.length,stdout) == result.length ? 0 : 2;
    }
    if (argc != 2 && argc != 3 && argc != 5 && argc != 6 && argc != 7) return 2;
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
    if (argc >= 3 && !strcmp(argv[2],"--registry")) {
      NSError* error = nil;
      KestrelNativeProfileSelectionResult result = KestrelNativeProfileSelectionResult::Unchanged;
      if (argc == 7) {
        NSData* input = [[NSString stringWithUTF8String:argv[6]] dataUsingEncoding:NSUTF8StringEncoding];
        id expected = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if (![expected isKindOfClass:NSDictionary.class]) return 2;
        NSString* first = [NSString stringWithUTF8String:argv[4]], *second = [NSString stringWithUTF8String:argv[5]];
        if (!strcmp(argv[3],"register")) result = KestrelRegisterPreparedNativeCoreHandoff(root,first,second,expected);
        else if (!strcmp(argv[3],"save")) result = KestrelSaveReviewedNativeCoreProfileSelection(root,first,second,expected);
        else return 2;
      } else if (argc != 3) return 2;
      NSDictionary* selection = KestrelReadNativeCoreProfileSelection(root,&error);
      NSDictionary* resolved = KestrelResolveNativeCoreProfileSelection(root,nil);
      NSDictionary* response = @{@"selection":selection ?: NSNull.null,@"resolved":resolved ?: NSNull.null,@"error":@(error != nil),
        @"saved":result == KestrelNativeProfileSelectionResult::Selected ? @"selected" : result == KestrelNativeProfileSelectionResult::SelectedDurabilityUnconfirmed ? @"selected-durability-unconfirmed" : @"unchanged"};
      NSData* bytes = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
      return bytes && fwrite(bytes.bytes,1,bytes.length,stdout) == bytes.length ? 0 : 2;
    }
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
