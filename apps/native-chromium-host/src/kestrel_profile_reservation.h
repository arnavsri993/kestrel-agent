#ifndef KESTREL_PROFILE_RESERVATION_H_
#define KESTREL_PROFILE_RESERVATION_H_

#include <memory>
#include <string>
#include <sys/types.h>

namespace kestrel {
enum class ProfileReservationError { kNone, kBusy, kUnsafe, kFailed };

// Reserves an external fence only. It does not prove the profile is offline.
class ProfileReservation {
 public:
  static std::unique_ptr<ProfileReservation> Acquire(
      const std::string& canonical_profile, ProfileReservationError* error);
  ~ProfileReservation();
  ProfileReservation(const ProfileReservation&) = delete;
  ProfileReservation& operator=(const ProfileReservation&) = delete;
  bool IsCurrent() const;

 private:
  ProfileReservation(int parent_fd, int lock_fd, std::string parent,
                     std::string lock_name, dev_t parent_dev, ino_t parent_ino,
                     dev_t lock_dev, ino_t lock_ino);
  int parent_fd_;
  int lock_fd_;
  std::string parent_;
  std::string lock_name_;
  dev_t parent_dev_;
  ino_t parent_ino_;
  dev_t lock_dev_;
  ino_t lock_ino_;
};
}  // namespace kestrel
#endif
