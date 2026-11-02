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
    NSString* browser_profile, NSString* active, NSString* previous, NSString* expected_active);

@interface KestrelNativeProfileTransferController : NSObject
- (instancetype)initWithBrowserProfile:(NSString*)browserProfile
                    currentCoreProfile:(NSString*)currentCoreProfile
                              testKeys:(BOOL)testKeys;
- (void)beginTransfer;
- (void)restorePrevious;
- (BOOL)canBegin;
- (void)shutdown;
@end
