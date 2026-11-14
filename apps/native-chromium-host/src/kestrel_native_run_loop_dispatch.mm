#import <CoreFoundation/CoreFoundation.h>

#include "kestrel_native_run_loop_dispatch.h"

#include <atomic>
#include <memory>

void KestrelDispatchToMainRunLoop(KestrelNativeRunLoopBlock block) {
  if (!block) return;

  const void* explicit_modes[] = {
      kCFRunLoopDefaultMode,
      CFSTR("NSModalPanelRunLoopMode"),
      CFSTR("NSEventTrackingRunLoopMode"),
  };
  CFArrayRef mode_set = CFArrayCreate(kCFAllocatorDefault,
      explicit_modes, sizeof(explicit_modes) / sizeof(explicit_modes[0]),
      &kCFTypeArrayCallBacks);
  if (!mode_set) return;

  const auto delivered = std::make_shared<std::atomic_bool>(false);
  KestrelNativeRunLoopBlock retained = [block copy];
  CFRunLoopRef main_loop = CFRunLoopGetMain();
  KestrelNativeRunLoopBlock delivery = ^{
    bool expected = false;
    if (delivered->compare_exchange_strong(expected, true,
            std::memory_order_acq_rel, std::memory_order_acquire)) {
      retained();
    }
  };
  CFRunLoopPerformBlock(main_loop, mode_set, delivery);
  CFRelease(mode_set);
  CFRunLoopWakeUp(main_loop);
}
