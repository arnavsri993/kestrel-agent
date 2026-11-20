#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#include "kestrel_native_core_key_dispatch.h"

#include <mutex>
#include <cassert>
#include <utility>

namespace {
struct KeyResult {
  bool ok = false;
  std::string key;
  void Clear() {
    volatile char* bytes = key.data();
    for (size_t index = 0; index < key.size(); ++index) bytes[index] = 0;
    key.clear();
  }
  ~KeyResult() { Clear(); }
};
}  // namespace

struct NativeCoreKeyDispatcher::State {
  std::mutex mutex;
  dispatch_queue_t queue = dispatch_queue_create(
      "com.kestrel.native-core.profile-key", DISPATCH_QUEUE_SERIAL);
  OwnerToken current;
  uint64_t generation = 0;
  bool requested = false;
  std::string request_id;
  size_t pending = 0;

  bool Current(const OwnerToken& owner, const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex);
    return owner && current == owner && current->generation == owner->generation &&
           current->profile == owner->profile && current->pipe == owner->pipe && request_id == id;
  }
  void Finished() {
    std::lock_guard<std::mutex> lock(mutex);
    --pending;
  }
};

NativeCoreKeyDispatcher::NativeCoreKeyDispatcher() : state_(std::make_shared<State>()) {}
NativeCoreKeyDispatcher::~NativeCoreKeyDispatcher() {
  std::lock_guard<std::mutex> lock(state_->mutex);
  state_->current.reset();
}

NativeCoreKeyDispatcher::OwnerToken NativeCoreKeyDispatcher::BeginOwner(
    std::string profile, uintptr_t pipe) {
  assert([NSThread isMainThread]);
  std::lock_guard<std::mutex> lock(state_->mutex);
  state_->current = std::make_shared<const Owner>(Owner{
      ++state_->generation, std::move(profile), pipe});
  state_->requested = false;
  state_->request_id.clear();
  return state_->current;
}

void NativeCoreKeyDispatcher::InvalidateOwner(const OwnerToken& owner) {
  assert([NSThread isMainThread]);
  std::lock_guard<std::mutex> lock(state_->mutex);
  if (state_->current == owner) state_->current.reset();
}

size_t NativeCoreKeyDispatcher::PendingRequests() const {
  std::lock_guard<std::mutex> lock(state_->mutex);
  return state_->pending;
}

NativeCoreKeyDispatcher::Disposition NativeCoreKeyDispatcher::Request(
    const OwnerToken& owner, std::string request_id,
    Lookup lookup, Completion completion) {
  const auto state = state_;
  bool capacity_failure = false;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!owner || state->current != owner) return Disposition::Stale;
    if (state->requested) return Disposition::Duplicate;
    if (request_id.empty() || request_id.size() > 100 || !lookup || !completion)
      return Disposition::Invalid;
    state->requested = true;
    state->request_id = request_id;
    capacity_failure = state->pending >= 4;
    if (!capacity_failure) ++state->pending;
  }
  if (capacity_failure) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (state->Current(owner, request_id)) completion(false, std::string());
    });
    return Disposition::CapacityFailure;
  }
  dispatch_async(state->queue, ^{
    @autoreleasepool {
      if (!state->Current(owner, request_id)) { state->Finished(); return; }
      const auto result = std::make_shared<KeyResult>();
      std::string error;
      try { result->ok = lookup(&result->key, &error); }
      catch (...) { result->ok = false; }
      if (!result->ok) result->Clear();
      // A completed lookup may outlive its broker, profile or whole owner.
      // Dropping the last result reference erases its key on every stale path.
      if (!state->Current(owner, request_id)) { state->Finished(); return; }
      dispatch_async(dispatch_get_main_queue(), ^{
        if (state->Current(owner, request_id)) completion(result->ok, result->key);
        state->Finished();
      });
    }
  });
  return Disposition::Queued;
}
