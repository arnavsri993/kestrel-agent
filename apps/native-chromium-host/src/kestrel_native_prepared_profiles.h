#pragma once
#import <Foundation/Foundation.h>

// Native-host-only inventory. A nil result means inspection was unsafe; an
// empty result means no eligible prepared profiles. No keys or contents read.
NSArray<NSDictionary*>* KestrelInspectPreparedCoreProfiles(NSString* browserRoot, NSString* activeRelative, NSString* previousRelative, NSError** error);
// The caller must pass freshly read selection values before any further action.
BOOL KestrelPreparedCoreProfileIsCurrent(NSString* browserRoot, NSDictionary* row, NSString* activeRelative, NSString* previousRelative);
