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
  SwitchSet defaults;
  defaults.switches.insert("unrelated");
  const bool default_mock = kestrel::ConfigureKeychainPolicy(defaults);
#if KESTREL_NATIVE_RELEASE_BUILD
  if (default_mock || defaults.HasSwitch("use-mock-keychain")) return 1;
#else
  if (!default_mock || !defaults.HasSwitch("use-mock-keychain")) return 2;
#endif
  if (!defaults.HasSwitch("unrelated")) return 3;

  SwitchSet explicit_real;
  explicit_real.switches.insert("kestrel-real-keychain");
  explicit_real.switches.insert("use-mock-keychain");
  explicit_real.switches.insert("unrelated");
  const bool explicit_real_mock =
      kestrel::ConfigureKeychainPolicy(explicit_real);
  if (explicit_real_mock || explicit_real.HasSwitch("use-mock-keychain"))
    return 4;
  if (!explicit_real.HasSwitch("kestrel-real-keychain") ||
      !explicit_real.HasSwitch("unrelated"))
    return 5;

  SwitchSet inherited_mock;
  inherited_mock.switches.insert("use-mock-keychain");
  const bool inherited_mock_selected =
      kestrel::ConfigureKeychainPolicy(inherited_mock);
#if KESTREL_NATIVE_RELEASE_BUILD
  if (inherited_mock_selected || inherited_mock.HasSwitch("use-mock-keychain"))
    return 6;
#else
  if (!inherited_mock_selected || !inherited_mock.HasSwitch("use-mock-keychain"))
    return 7;
#endif
  return 0;
}
