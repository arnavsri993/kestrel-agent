#import <Foundation/Foundation.h>

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <limits.h>
#include <map>
#include <string>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>

#include "../src/kestrel_native_core_keychain.h"

class InMemoryNativeCoreKeychain final : public NativeCoreKeychainBackend {
 public:
  NativeCoreKeychainResult read_result = NativeCoreKeychainResult::NotFound;
  NativeCoreKeychainResult add_result = NativeCoreKeychainResult::Success;
  std::map<std::string, std::vector<unsigned char>> items;

  NativeCoreKeychainResult Read(
      const std::string& account,
      std::vector<unsigned char>* value) override {
    if (read_result != NativeCoreKeychainResult::NotFound) return read_result;
    const auto found = items.find(account);
    if (found == items.end()) return NativeCoreKeychainResult::NotFound;
    *value = found->second;
    return NativeCoreKeychainResult::Success;
  }

  NativeCoreKeychainResult Add(
      const std::string& account,
      const std::vector<unsigned char>& value) override {
    if (add_result != NativeCoreKeychainResult::Success) return add_result;
    if (items.contains(account)) return NativeCoreKeychainResult::Duplicate;
    items.emplace(account, value);
    return NativeCoreKeychainResult::Success;
  }
};

std::string PrivateProfile(const char* prefix) {
  char temporary[PATH_MAX]{};
  assert(confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, sizeof(temporary)) > 0);
  std::string pattern = std::string(temporary) + prefix + "-XXXXXX";
  std::vector<char> path(pattern.begin(), pattern.end());
  path.push_back('\0');
  char* created = mkdtemp(path.data());
  assert(created);
  assert(chmod(created, 0700) == 0);
  const std::string marker_path = std::string(created) + "/.kestrel-native-test-profile-v1";
  FILE* marker = fopen(marker_path.c_str(), "wb");
  assert(marker);
  const char marker_contents[] = "native-test-profile-v1\n";
  assert(fwrite(marker_contents, 1, sizeof(marker_contents) - 1, marker) == sizeof(marker_contents) - 1);
  fclose(marker);
  assert(chmod(marker_path.c_str(), 0600) == 0);
  char canonical[PATH_MAX]{};
  assert(realpath(created, canonical));
  return canonical;
}

int main() {
  @autoreleasepool {
    auto backend = std::make_shared<InMemoryNativeCoreKeychain>();
    NativeCoreProfileKeyStore store(backend);
    std::string first_key;
    std::string refused_key;
    std::string error;
    const std::string first_profile = PrivateProfile("kestrel-core-key-test");
    assert(store.GetOrCreate(first_profile, &first_key, &error));
    assert(first_key.size() == 44);
    assert(access((first_profile + "/native-core/database.key").c_str(), F_OK) != 0);
    NativeCoreProfileKeyStore restarted(backend);
    std::string reopened_key;
    assert(restarted.GetOrCreate(first_profile, &reopened_key, &error));
    assert(reopened_key == first_key);

    const std::string second_profile = PrivateProfile("kestrel-core-key-test");
    std::string second_key;
    assert(store.GetOrCreate(second_profile, &second_key, &error));
    assert(second_key != first_key);

    const std::string test_profile = PrivateProfile("kestrel-core-test-key");
    const std::string test_bundle_path = "/tmp/Kestrel Development.app";
    std::string test_key;
    assert(store.GetOrCreateDisposableTestKey(
        test_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &test_key, &error));
    NativeCoreProfileKeyStore test_restart(backend);
    std::string restarted_test_key;
    assert(test_restart.GetOrCreateDisposableTestKey(
        test_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &restarted_test_key, &error));
    assert(restarted_test_key == test_key);
    assert(!store.GetOrCreateDisposableTestKey(
        test_profile, "com.kestrel.desktop", test_bundle_path,
        &refused_key, &error));
    assert(!store.GetOrCreateDisposableTestKey(
        test_profile, "com.kestrel.desktop.dev", "/Applications/Kestrel.app",
        &refused_key, &error));
    assert(!store.GetOrCreate(test_profile, &refused_key, &error));

    const std::string unmarked_profile = PrivateProfile("kestrel-core-test-unmarked");
    assert(unlink((unmarked_profile + "/.kestrel-native-test-profile-v1").c_str()) == 0);
    assert(!store.GetOrCreateDisposableTestKey(
        unmarked_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &refused_key, &error));

    const std::string fifo_marker_profile = PrivateProfile("kestrel-core-test-fifo-marker");
    const std::string fifo_marker = fifo_marker_profile + "/.kestrel-native-test-profile-v1";
    assert(unlink(fifo_marker.c_str()) == 0);
    assert(mkfifo(fifo_marker.c_str(), 0600) == 0);
    assert(!store.GetOrCreateDisposableTestKey(
        fifo_marker_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &refused_key, &error));

    const std::string fifo_key_profile = PrivateProfile("kestrel-core-test-fifo-key");
    assert(mkfifo((fifo_key_profile + "/.kestrel-native-test-core-key-v1").c_str(), 0600) == 0);
    assert(!store.GetOrCreateDisposableTestKey(
        fifo_key_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &refused_key, &error));

    // Existing Keychain values do not authorize following linked native Core
    // paths. Validate filesystem ownership before returning the stable key.
    const std::string linked_core_profile = PrivateProfile("kestrel-core-key-linked-core");
    assert(store.GetOrCreate(linked_core_profile, &refused_key, &error));
    const std::string linked_core_target = PrivateProfile("kestrel-core-key-linked-target");
    assert(symlink(linked_core_target.c_str(),
                   (linked_core_profile + "/native-core").c_str()) == 0);
    assert(!store.GetOrCreate(linked_core_profile, &refused_key, &error));

    const std::string linked_database_profile = PrivateProfile("kestrel-core-key-linked-db");
    assert(store.GetOrCreate(linked_database_profile, &refused_key, &error));
    assert(mkdir((linked_database_profile + "/native-core").c_str(), 0700) == 0);
    const std::string linked_database_target = linked_database_profile + "/external.sqlite";
    FILE* external_database = fopen(linked_database_target.c_str(), "wb");
    assert(external_database);
    fclose(external_database);
    assert(mkdir((linked_database_profile + "/native-core/database").c_str(), 0700) == 0);
    assert(symlink(linked_database_target.c_str(),
                   (linked_database_profile + "/native-core/database/kestrel.sqlite").c_str()) == 0);
    assert(!store.GetOrCreate(linked_database_profile, &refused_key, &error));

    const std::string existing_profile = PrivateProfile("kestrel-core-key-existing");
    assert(mkdir((existing_profile + "/native-core").c_str(), 0700) == 0);
    assert(!store.GetOrCreate(existing_profile, &refused_key, &error));
    assert(!store.GetOrCreateDisposableTestKey(
        existing_profile, "com.kestrel.desktop.dev", test_bundle_path,
        &refused_key, &error));
    assert(access((existing_profile + "/native-core").c_str(), F_OK) == 0);

    const std::string legacy_profile = PrivateProfile("kestrel-core-key-legacy");
    assert(mkdir((legacy_profile + "/native-core").c_str(), 0700) == 0);
    const std::string legacy_path = legacy_profile + "/native-core/database.key";
    FILE* legacy = fopen(legacy_path.c_str(), "wb");
    assert(legacy);
    const char marker[] = "preserve-legacy-fixture";
    assert(fwrite(marker, 1, sizeof(marker) - 1, legacy) == sizeof(marker) - 1);
    fclose(legacy);
    assert(!store.GetOrCreate(legacy_profile, &refused_key, &error));
    struct stat legacy_info {};
    assert(stat(legacy_path.c_str(), &legacy_info) == 0 && legacy_info.st_size == sizeof(marker) - 1);

    backend->read_result = NativeCoreKeychainResult::Failure;
    const std::string denied_profile = PrivateProfile("kestrel-core-key-denied");
    assert(!store.GetOrCreate(denied_profile, &refused_key, &error));
    assert(access((denied_profile + "/native-core").c_str(), F_OK) != 0);

    const std::string linked_profile_parent = PrivateProfile("kestrel-core-key-link");
    const std::string outside_profile = PrivateProfile("kestrel-core-key-outside");
    const std::string linked_profile = linked_profile_parent + "/linked";
    assert(symlink(outside_profile.c_str(), linked_profile.c_str()) == 0);
    assert(!store.GetOrCreate(linked_profile, &refused_key, &error));

    for (const std::string& root : {first_profile, second_profile, existing_profile,
                                    test_profile, unmarked_profile,
                                    linked_core_profile, linked_core_target,
                                    linked_database_profile,
                                    legacy_profile, denied_profile,
                                    fifo_marker_profile, fifo_key_profile,
                                    linked_profile_parent, outside_profile})
      std::filesystem::remove_all(root);
  }
}
