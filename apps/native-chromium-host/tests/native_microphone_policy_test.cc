#include "../src/native_microphone_policy.h"
#include <cassert>
int main() {
  const std::string ui = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html";
  const std::string origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  using D = NativeMicrophoneDecision;
  auto policy = [&](const std::string& o, const std::string& url, bool main, uint32_t flags, bool authorized) {
    return NativeMicrophonePolicy(ui, o, url, main, flags, 1, authorized);
  };
  assert(policy(origin, ui, true, 1, true) == D::kAllowAudio);
  assert(policy(origin + "/", ui + "?app=settings", true, 1, true) == D::kAllowAudio);
  assert(policy(origin, ui + "#home", true, 1, true) == D::kAllowAudio);
  assert(policy(origin, ui, false, 1, true) == D::kDeny);
  assert(policy(origin, ui, true, 1, false) == D::kDeny);
  assert(policy(origin, ui, true, 0, true) == D::kDeny);
  assert(policy(origin, ui, true, 2, true) == D::kDeny);
  assert(policy(origin, ui, true, 3, true) == D::kDeny);
  assert(policy(origin, ui, true, 4, true) == D::kDeny);
  assert(policy(origin, ui + ".evil", true, 1, true) == D::kDeny);
  assert(policy(origin, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/other.html", true, 1, true) == D::kDeny);
  assert(policy("https://example.com", "https://example.com", true, 1, true) == D::kChromiumDefault);
  assert(policy("chrome-extension://other", "chrome-extension://other/index.html", true, 1, true) == D::kChromiumDefault);
}
