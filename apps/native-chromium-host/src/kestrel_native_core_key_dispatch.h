#ifndef KESTREL_NATIVE_CORE_KEY_DISPATCH_H_
#define KESTREL_NATIVE_CORE_KEY_DISPATCH_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

// A bootstrap belongs to one owner lifetime, even when the wire request ID,
// profile and file descriptor are reused by a later owner. Never cancels a
// macOS security operation or changes its authorization policy.
class NativeCoreKeyDispatcher {
 public:
  struct Owner {
    const uint64_t generation;
    const std::string profile;
    const uintptr_t pipe;
  };
  using OwnerToken = std::shared_ptr<const Owner>;
  using Lookup = std::function<bool(std::string*, std::string*)>;
  using Completion = std::function<void(bool, const std::string&)>;
  enum class Disposition { Queued, CapacityFailure, Duplicate, Stale, Invalid };

  NativeCoreKeyDispatcher();
  ~NativeCoreKeyDispatcher();
  NativeCoreKeyDispatcher(const NativeCoreKeyDispatcher&) = delete;
  NativeCoreKeyDispatcher& operator=(const NativeCoreKeyDispatcher&) = delete;

  // Ownership changes run on main, serial with completion delivery. Request
  // may run on the private pipe reader thread; it never waits for main.
  OwnerToken BeginOwner(std::string profile, uintptr_t pipe);
  void InvalidateOwner(const OwnerToken& owner);
  // At most one request per owner and four outstanding lookups. CapacityFailure
  // reserves the request and promptly completes false on main without lookup.
  // Duplicate/Stale never issue a second response to an accepted request.
  Disposition Request(const OwnerToken& owner, std::string request_id,
                      Lookup lookup, Completion completion);
  size_t PendingRequests() const;

 private:
  struct State;
  std::shared_ptr<State> state_;
};

#endif
