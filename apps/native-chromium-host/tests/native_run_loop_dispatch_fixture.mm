#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>

#include "kestrel_native_run_loop_dispatch.h"

#include <atomic>
#include <cstdio>
#include <dispatch/dispatch.h>
#include <memory>
#include <pthread.h>
#include <thread>

struct Result {
  std::atomic<int> calls{0};
  std::atomic<bool> callback_on_main{false};
  std::atomic<bool> callback_before_unwind{false};
  std::atomic<bool> outer_finished{false};
  CFStringRef expected_mode = nullptr;
  CFStringRef actual_mode = nullptr;
  bool right_mode = false;
  ~Result() { if (actual_mode) CFRelease(actual_mode); }
};

static bool RunScenario(CFStringRef nested_mode, const char* name) {
  const auto result = std::make_shared<Result>();
  result->expected_mode = nested_mode;
  const auto state = result;
  dispatch_async(dispatch_get_main_queue(), ^{
    dispatch_semaphore_t enter_nested = dispatch_semaphore_create(0);
    std::thread worker([state, enter_nested] {
      dispatch_semaphore_wait(enter_nested, DISPATCH_TIME_FOREVER);
      KestrelDispatchToMainRunLoop(^{
        state->callback_on_main.store(pthread_main_np() != 0, std::memory_order_relaxed);
        state->actual_mode = CFRunLoopCopyCurrentMode(CFRunLoopGetMain());
        state->right_mode = state->actual_mode && CFEqual(state->expected_mode, state->actual_mode);
        state->calls.fetch_add(1, std::memory_order_relaxed);
      });
    });

    dispatch_semaphore_signal(enter_nested);
    const CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 5.0;
    while (state->calls.load(std::memory_order_relaxed) == 0 && CFAbsoluteTimeGetCurrent() < deadline) {
      CFRunLoopRunInMode(nested_mode, 0.05, false);
    }
    state->callback_before_unwind.store(state->calls.load(std::memory_order_relaxed) == 1,
        std::memory_order_relaxed);
    worker.join();

    // Switch modes after delivery. A registration copied into several modes
    // must not invoke its body again when the loop services another mode.
    const CFStringRef other_modes[] = {
        kCFRunLoopDefaultMode, CFSTR("NSModalPanelRunLoopMode"), CFSTR("NSEventTrackingRunLoopMode")};
    for (CFStringRef mode : other_modes) CFRunLoopRunInMode(mode, 0.01, false);
    state->outer_finished.store(true, std::memory_order_release);
  });

  const CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 8.0;
  while (!result->outer_finished.load(std::memory_order_acquire) && CFAbsoluteTimeGetCurrent() < deadline) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
  }
  const bool ok = result->outer_finished.load(std::memory_order_acquire) &&
      result->calls.load(std::memory_order_relaxed) == 1 &&
      result->callback_on_main.load(std::memory_order_relaxed) &&
      result->callback_before_unwind.load(std::memory_order_relaxed) && result->right_mode;
  if (!ok) std::fprintf(stderr, "run-loop dispatch scenario failed: %s calls=%d main=%d before=%d finished=%d rightMode=%d\n", name,
      result->calls.load(), result->callback_on_main.load(), result->callback_before_unwind.load(), result->outer_finished.load(), result->right_mode);
  else std::printf("PASS %s\n", name);
  return ok;
}

int main() {
  @autoreleasepool {
    bool ok = true;
    ok = RunScenario(kCFRunLoopDefaultMode, "default-mode") && ok;
    ok = RunScenario(CFSTR("NSModalPanelRunLoopMode"), "modal-mode-nested-dispatch") && ok;
    ok = RunScenario(CFSTR("NSEventTrackingRunLoopMode"), "event-tracking-mode") && ok;
    return ok ? 0 : 1;
  }
}
