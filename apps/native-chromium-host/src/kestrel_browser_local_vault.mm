#import <Foundation/Foundation.h>
#include "kestrel_browser_local_vault.h"
#include "kestrel_local_vault.h"
#include <array>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef KESTREL_NATIVE_RELEASE_BUILD
#error "Select an explicit native build policy."
#endif

namespace {
struct LoadedVaultApi {
  using Version = unsigned int (*)();
  using Configure = int (*)(unsigned char*, size_t);
  void* library = nullptr;
  Version version = nullptr;
  Configure configure = nullptr;
  LoadedVaultApi() {
    // CEF's wrapper deliberately uses RTLD_LOCAL|RTLD_FIRST. RTLD_DEFAULT
    // cannot reliably see its exports and could select an unrelated symbol.
    NSString* binary = [NSBundle.mainBundle.privateFrameworksPath
        stringByAppendingPathComponent:@"Chromium Embedded Framework.framework/Chromium Embedded Framework"];
    std::array<char, PATH_MAX> canonical {};
    if (!binary || !realpath(binary.fileSystemRepresentation, canonical.data())) return;
    library = dlopen(canonical.data(), RTLD_NOLOAD | RTLD_LAZY | RTLD_LOCAL | RTLD_FIRST);
    if (!library) return;
    version = reinterpret_cast<Version>(dlsym(library, "cef_kestrel_vault_api_version"));
    configure = reinterpret_cast<Configure>(dlsym(library, "cef_kestrel_vault_configure"));
  }
  ~LoadedVaultApi() { if (library) dlclose(library); }
};
bool DisposableProfile(const std::string& profile) {
#if KESTREL_NATIVE_RELEASE_BUILD
  (void)profile;
  return false;
#else
  struct stat profile_info {};
  std::array<char, PATH_MAX> resolved_profile {};
  if (profile.empty() || profile.front() != '/' ||
      !realpath(profile.c_str(), resolved_profile.data()) ||
      profile != resolved_profile.data() || lstat(profile.c_str(), &profile_info) != 0 ||
      !S_ISDIR(profile_info.st_mode) || profile_info.st_uid != getuid() ||
      (profile_info.st_mode & 0077) != 0) return false;
  NSString* identifier = NSBundle.mainBundle.bundleIdentifier;
  if (![identifier isEqualToString:@"com.kestrel.native-chromium-host.dev"] &&
      ![identifier isEqualToString:@"com.kestrel.desktop.dev"]) return false;
  std::array<char, PATH_MAX> temp {}, canonical {};
  if (!confstr(_CS_DARWIN_USER_TEMP_DIR, temp.data(), temp.size()) ||
      !realpath(temp.data(), canonical.data()) ||
      profile.rfind(std::string(canonical.data()) + "/", 0) != 0) return false;
  const std::string path = profile + "/.kestrel-native-test-profile-v1";
  const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return false;
  struct stat info {}; std::array<char, 24> value {};
  const ssize_t size = read(fd, value.data(), value.size());
  const bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
      info.st_uid == getuid() && info.st_nlink == 1 &&
      (info.st_mode & 0777) == 0600 && info.st_size == 23 && size == 23 &&
      memcmp(value.data(), "native-test-profile-v1\n", 23) == 0;
  close(fd);
  return valid;
#endif
}
}

bool ConfigureNativeBrowserLocalVault(const std::string& profile,
                                     bool disposable_test, std::string* error) {
  LoadedVaultApi api;
  if (disposable_test) {
    if (api.library && !api.version && !api.configure && DisposableProfile(profile)) return true;
    if (api.version || api.configure) {
      if (error) *error = "This vault-enabled engine requires a fresh production-vault profile. Mock storage is unsupported.";
      return false;
    }
    if (error) *error = "Mock browser storage is restricted to marked disposable development profiles.";
    return false;
  }
  if (!api.version || !api.configure || api.version() != 1) {
    if (error) *error = "This Chromium engine does not support Kestrel's local vault. A vault-enabled engine build is required; existing profiles were preserved.";
    return false;
  }
  // The shared vault enforces a conservative empty-profile allowlist before
  // creation. Absence of Default/Local State alone never means a fresh profile.
  NativeLocalVault vault; std::vector<unsigned char> key;
  if (!vault.GetKey(profile, "chromium-oscrypt/v1", true, &key, error)) return false;
  const bool configured = key.size() == 32 && api.configure(key.data(), key.size()) == 1;
  volatile unsigned char* data = key.data();
  for (size_t n = key.size(); n; --n) *data++ = 0;
  if (!configured && error) *error = "Chromium rejected local-vault initialization; existing data was preserved.";
  return configured;
}
