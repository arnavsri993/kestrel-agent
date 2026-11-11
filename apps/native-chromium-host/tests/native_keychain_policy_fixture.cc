#include <set>
#include <string>

#include "../src/kestrel_keychain_policy.h"

class SwitchSet {
 public:
  bool HasSwitch(const std::string& name) const {
    return switches.find(name) != switches.end();
  }
  void RemoveSwitch(const std::string& name) { switches.erase(name); }
  void AppendSwitch(const std::string& name) { switches.insert(name); }

  std::set<std::string> switches;
};

int main() {
  // All combinations cover inherited conflicts and incomplete test markers.
  for (unsigned bits = 0; bits < 16; ++bits) {
    SwitchSet command_line;
    command_line.switches.insert("unrelated");
    if (bits & 1) command_line.switches.insert("kestrel-test-profile-key");
    if (bits & 2) command_line.switches.insert("kestrel-durable-profile");
    if (bits & 4) command_line.switches.insert("use-mock-keychain");
    if (bits & 8) command_line.switches.insert("kestrel-real-keychain");
    const bool selected = kestrel::ConfigureKeychainPolicy(command_line);
#if KESTREL_NATIVE_RELEASE_BUILD
    const bool expected = false;
#else
    const bool expected = (bits & 3) == 3;
#endif
    if (selected != expected || command_line.HasSwitch("use-mock-keychain") != expected ||
        command_line.HasSwitch("kestrel-real-keychain") || !command_line.HasSwitch("unrelated") ||
        command_line.HasSwitch("kestrel-test-profile-key") != bool(bits & 1) ||
        command_line.HasSwitch("kestrel-durable-profile") != bool(bits & 2)) return 1;
  }
  return 0;
}
