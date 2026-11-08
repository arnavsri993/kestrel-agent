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
  // Remove inherited or user-supplied conflicts before applying the selected
  // policy. Release binaries never use Chromium's mock backend; development
  // binaries use it by default and keep the explicit real-keychain opt-in.
  command_line.RemoveSwitch("use-mock-keychain");
#if KESTREL_NATIVE_RELEASE_BUILD
  constexpr bool use_mock_keychain = false;
#else
  const bool use_mock_keychain =
      !command_line.HasSwitch("kestrel-real-keychain");
#endif
  if (use_mock_keychain) command_line.AppendSwitch("use-mock-keychain");
  return use_mock_keychain;
}

}  // namespace kestrel

#endif  // KESTREL_NATIVE_KEYCHAIN_POLICY_H_
