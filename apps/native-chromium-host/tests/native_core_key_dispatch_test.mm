#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <dispatch/dispatch.h>

#include "../src/kestrel_native_core_key_dispatch.h"

#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace {
constexpr char kRequest[] = "native-core-profile-key-v1";
using Disposition = NativeCoreKeyDispatcher::Disposition;
NativeCoreKeyDispatcher::OwnerToken BeginOwner(NativeCoreKeyDispatcher& dispatcher,
                                               std::string profile, uintptr_t pipe) {
  __block NativeCoreKeyDispatcher::OwnerToken owner;
  auto* target = &dispatcher;
  dispatch_sync(dispatch_get_main_queue(), ^{ owner = target->BeginOwner(profile, pipe); });
  return owner;
}
void InvalidateOwner(NativeCoreKeyDispatcher& dispatcher,
                     const NativeCoreKeyDispatcher::OwnerToken& owner) {
  auto* target = &dispatcher;
  dispatch_sync(dispatch_get_main_queue(), ^{ target->InvalidateOwner(owner); });
}
struct Latch {
  std::mutex mutex;
  std::condition_variable condition;
  bool opened = false;
  void Open() { std::lock_guard<std::mutex> lock(mutex); opened = true; condition.notify_all(); }
  void Wait() { std::unique_lock<std::mutex> lock(mutex); assert(condition.wait_for(lock, std::chrono::seconds(3), [&] { return opened; })); }
};
void WaitIdle(const NativeCoreKeyDispatcher& dispatcher) {
  for (int attempts = 0; attempts < 300 && dispatcher.PendingRequests(); ++attempts)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  assert(dispatcher.PendingRequests() == 0);
  dispatch_sync(dispatch_get_main_queue(), ^{});
}
}  // namespace

int main() {
  // This executable has a dispatch main loop, not NSApplication or any window.
  // Every lookup is injected; no macOS Keychain API is linked or invoked.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      NativeCoreKeyDispatcher dispatcher;
      const auto first = BeginOwner(dispatcher, "/generated/profile", 7);
      Latch entered, release, heartbeat, completed;
      std::atomic_int callbacks{0}, lookups{0};
      std::atomic_bool first_active{false};
      assert(dispatcher.Request(first, kRequest, [&](std::string* key, std::string*) {
        assert(![NSThread isMainThread]); first_active = true; ++lookups; entered.Open(); release.Wait(); first_active = false;
        *key = std::string(44, 'x'); return true;
      }, [&](bool, const std::string&) { ++callbacks; }) == Disposition::Queued);
      entered.Wait();
      assert(dispatcher.Request(first, kRequest, [](std::string*, std::string*) { return true; }, [](bool, const std::string&) { assert(false); }) == Disposition::Duplicate);
      Latch* heartbeat_pointer = &heartbeat;
      dispatch_async(dispatch_get_main_queue(), ^{ assert([NSThread isMainThread]); heartbeat_pointer->Open(); });
      heartbeat.Wait(); // Main progresses while the fake security call is held.
      InvalidateOwner(dispatcher, first);
      // Even exact profile/pipe/request-ID reuse cannot adopt the old result.
      const auto replacement = BeginOwner(dispatcher, "/generated/profile", 7);
      assert(replacement->generation != first->generation);
      assert(dispatcher.Request(replacement, kRequest, [&](std::string* key, std::string*) {
        assert(![NSThread isMainThread] && !first_active); ++lookups; *key = std::string(44, 'y'); return true;
      }, [&](bool ok, const std::string& key) {
        assert([NSThread isMainThread]); assert(ok && key == std::string(44, 'y'));
        ++callbacks; completed.Open();
      }) == Disposition::Queued);
      release.Open(); completed.Wait(); WaitIdle(dispatcher);
      assert(callbacks == 1 && lookups == 2);

      // A failing/throwing backend cannot expose a partial key or take down
      // the native owner; both failures settle once on the main queue.
      for (const bool throws : {false, true}) {
        Latch failed;
        const auto failing = BeginOwner(dispatcher, "/generated/failing", 8);
        assert(dispatcher.Request(failing, kRequest, [throws](std::string* key, std::string*) {
          assert(![NSThread isMainThread]); *key = "generated-partial-secret";
          if (throws) throw std::runtime_error("generated backend failure");
          return false;
        }, [&](bool ok, const std::string& key) {
          assert([NSThread isMainThread] && !ok && key.empty()); failed.Open();
        }) == Disposition::Queued);
        failed.Wait(); WaitIdle(dispatcher);
      }

      // A shutdown after lookup started discards its success without a reply.
      Latch shutdown_entered, shutdown_release;
      const auto closing = BeginOwner(dispatcher, "/generated/other-profile", 9);
      assert(dispatcher.Request(closing, kRequest, [&](std::string* key, std::string*) {
        shutdown_entered.Open(); shutdown_release.Wait(); *key = std::string(44, 'z'); return true;
      }, [&](bool, const std::string&) { ++callbacks; }) == Disposition::Queued);
      shutdown_entered.Wait(); InvalidateOwner(dispatcher, closing); shutdown_release.Open();
      WaitIdle(dispatcher); assert(callbacks == 1);

      // Bound queued generations and skip stale queued work before lookup.
      Latch bounded_entered, bounded_release;
      const auto held = BeginOwner(dispatcher, "/generated/held", 10);
      assert(dispatcher.Request(held, kRequest, [&](std::string*, std::string*) {
        bounded_entered.Open(); bounded_release.Wait(); return false;
      }, [&](bool, const std::string&) { ++callbacks; }) == Disposition::Queued);
      bounded_entered.Wait();
      for (int index = 0; index < 3; ++index) {
        const auto queued = BeginOwner(dispatcher, "/generated/queued", 10);
        assert(dispatcher.Request(queued, kRequest, [&](std::string*, std::string*) { assert(false); return false; }, [&](bool, const std::string&) { assert(false); }) == Disposition::Queued);
      }
      const auto overflow = BeginOwner(dispatcher, "/generated/overflow", 10);
      Latch capacity_completed;
      std::atomic_int failure_responses{0};
      assert(dispatcher.Request(overflow, kRequest, [](std::string*, std::string*) { assert(false); return false; }, [&](bool ok, const std::string& key) {
        assert([NSThread isMainThread] && !ok && key.empty());
        ++failure_responses; capacity_completed.Open();
      }) == Disposition::CapacityFailure);
      // Capacity failure settles before the held old lookup is released; a
      // duplicate cannot create a second response or invoke a second lookup.
      capacity_completed.Wait();
      assert(dispatcher.Request(overflow, kRequest, [](std::string*, std::string*) { assert(false); return false; }, [](bool, const std::string&) { assert(false); }) == Disposition::Duplicate);
      assert(failure_responses == 1);
      assert(dispatcher.PendingRequests() == 4);
      bounded_release.Open(); WaitIdle(dispatcher); assert(callbacks == 1);
      std::exit(0);
    }
  });
  // Keep the actual initial thread alive: dispatch_main() may retire it in a
  // command-line process, unlike AppKit's main run loop used by the host.
  CFRunLoopSourceContext context{};
  CFRunLoopSourceRef source = CFRunLoopSourceCreate(nullptr, 0, &context);
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopDefaultMode);
  CFRunLoopRun();
  CFRelease(source);
}
