#ifndef KESTREL_NATIVE_EXTERNAL_URL_QUEUE_H_
#define KESTREL_NATIVE_EXTERNAL_URL_QUEUE_H_
#include <deque>
#include <functional>
#include <string>

// Main-thread only. Once sent, an item is never replayed, even if the result
// is lost. Unsent items stay bounded and wait for the authenticated worker.
class NativeExternalUrlQueue {
 public:
  using Send = std::function<bool(const std::string&, const std::string&)>;
  explicit NativeExternalUrlQueue(Send send) : send_(std::move(send)) {}
  bool Enqueue(std::string url) {
    if (pending_.size() + (in_flight_.empty() ? 0 : 1) >= 32) return false;
    pending_.push_back(std::move(url)); Pump(); return true;
  }
  void SetReady(bool ready) {
    ready_ = ready;
    if (!ready && !in_flight_.empty()) { in_flight_.clear(); uncertain_ = true; }
    Pump();
  }
  bool Complete(const std::string& id) {
    if (id.empty() || id != in_flight_) return false;
    in_flight_.clear(); Pump(); return true;
  }
  bool uncertain() const { return uncertain_; }
 private:
  void Pump() {
    if (!ready_ || !in_flight_.empty() || pending_.empty()) return;
    const auto id = "external-" + std::to_string(++sequence_);
    if (!send_(id, pending_.front())) { ready_ = false; return; }
    in_flight_ = id;
    pending_.pop_front();
  }
  Send send_;
  std::deque<std::string> pending_;
  std::string in_flight_;
  unsigned long long sequence_ = 0;
  bool ready_ = false, uncertain_ = false;
};
#endif
