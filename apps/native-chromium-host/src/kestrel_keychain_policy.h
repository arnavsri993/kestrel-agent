#ifndef KESTREL_NATIVE_KEYCHAIN_POLICY_H_
#define KESTREL_NATIVE_KEYCHAIN_POLICY_H_
#pragma once

#ifndef KESTREL_NATIVE_RELEASE_BUILD
#error "The native Chromium builder must select an explicit release policy."
#endif

namespace kestrel {

static_assert(KESTREL_NATIVE_RELEASE_BUILD == 0 ||
                  KESTREL_NATIVE_RELEASE_BUILD == 1,
              "The native Chromium release policy must be 0 or 1.");

template <typename CommandLine>
bool ConfigureKeychainPolicy(CommandLine& command_line) {
  // The host must reject normal startup until the non-Keychain Chromium
  // provider is available. Mock storage is restricted to explicitly marked
  // disposable development profiles; the host independently validates them.
  command_line.RemoveSwitch("use-mock-keychain");
  command_line.RemoveSwitch("kestrel-real-keychain");
#if KESTREL_NATIVE_RELEASE_BUILD
  constexpr bool use_mock_keychain = false;
#else
  const bool use_mock_keychain =
      command_line.HasSwitch("kestrel-test-profile-key") &&
      command_line.HasSwitch("kestrel-durable-profile");
#endif
  if (use_mock_keychain) command_line.AppendSwitch("use-mock-keychain");
  return use_mock_keychain;
}

}  // namespace kestrel

#endif  // KESTREL_NATIVE_KEYCHAIN_POLICY_H_
