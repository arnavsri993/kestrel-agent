#pragma once
#import <Foundation/Foundation.h>

// Resolve only the native host's private, bounded profile selection. No legacy
// discovery, key access, directory creation, migration or implicit fallback.
NSString* KestrelResolveNativeCoreProfile(NSString* browser_profile, NSError** error);
// Canonicalize only a folder explicitly selected in the native picker, then
// require the profile and its database/secure directories to be private.
NSString* KestrelCanonicalNativeCoreTransferSource(NSString* selected_path);

enum class KestrelNativeProfileSelectionResult { Unchanged, Selected, SelectedDurabilityUnconfirmed };
KestrelNativeProfileSelectionResult KestrelSaveNativeCoreProfileSelection(
    NSString* browser_profile, NSString* active, NSString* previous, NSString* expected_active,
    NSString* expected_previous = nil);

// Read a validated immutable v2 snapshot; v1 selections normalize to explicit
// legacy entries without modifying the file. Resolver uses one such snapshot.
NSDictionary* KestrelReadNativeCoreProfileSelection(NSString* browser_profile, NSError** error);
NSDictionary* KestrelResolveNativeCoreProfileSelection(NSString* browser_profile, NSError** error);
KestrelNativeProfileSelectionResult KestrelRegisterPreparedNativeCoreHandoff(
    NSString* browser_profile, NSString* relative_profile, NSString* handoff_id, NSDictionary* expected_selection);
KestrelNativeProfileSelectionResult KestrelSaveReviewedNativeCoreProfileSelection(
    NSString* browser_profile, NSString* active, NSString* previous, NSDictionary* expected_selection);

@interface KestrelNativeProfileTransferController : NSObject
- (instancetype)initWithBrowserProfile:(NSString*)browserProfile
                    currentCoreProfile:(NSString*)currentCoreProfile
                              testKeys:(BOOL)testKeys;
- (void)beginTransfer;
- (void)reviewInterruptedTransfers;
- (void)restorePrevious;
- (BOOL)canBegin;
- (void)shutdown;
// Main-thread only. Starts shutdown if needed, then waits at most 15 seconds
// for earlier queue work and the owned transfer worker to stop cleanly.
- (BOOL)waitForShutdown:(NSTimeInterval)timeout;
@end
