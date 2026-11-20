#include "../src/kestrel_local_vault.h"
#include <sys/stat.h>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>
#include <iostream>
namespace fs = std::filesystem;
static constexpr const char* kVault = ".kestrel-local-vault-v1";
static constexpr const char* kCore = "native-core-database/v1";
static constexpr const char* kBrowser = "chromium-oscrypt/v1";
#define CHECK(x) do { if (!(x)) { std::cerr << "fixture failed line " << __LINE__ << '\n'; return 1; } } while (0)
class FixtureCrypto final : public NativeLocalVaultCrypto {
 public:
  bool seal_failure = false, open_failure = false, derive_failure = false;
  int seal_calls = 0, open_calls = 0, derive_calls = 0;
  fs::path create_during_seal;
  bool Seal(const std::string&, const std::vector<unsigned char>& master, std::vector<unsigned char>* out) override {
    ++seal_calls;
    if (!create_during_seal.empty()) { std::ofstream stream(create_during_seal); stream << "existing data"; stream.close(); }
    if (seal_failure) { *out = {1,2,3}; return false; }
    *out = {0x42}; out->insert(out->end(), master.begin(), master.end()); return true;
  }
  bool Open(const std::string&, const std::vector<unsigned char>& envelope, std::vector<unsigned char>* out) override {
    ++open_calls; if (open_failure || envelope.size() != 33 || envelope[0] != 0x42) { *out = {1,2,3}; return false; }
    out->assign(envelope.begin() + 1, envelope.end()); return true;
  }
  bool Derive(const std::string&, const std::vector<unsigned char>& master, const std::string& purpose, std::vector<unsigned char>* out) override {
    ++derive_calls; *out = master; if (derive_failure) return false;
    (*out)[0] ^= purpose == kCore ? 0x11 : 0x22; return true;
  }
};
static bool writeFile(const fs::path& path, const std::string& value, mode_t mode = 0600) {
  std::ofstream stream(path, std::ios::binary); stream << value; stream.close();
  return stream.good() && chmod(path.c_str(), mode) == 0;
}
static fs::path profile(const fs::path& root, const std::string& name) {
  fs::path result = root / name; fs::create_directory(result); chmod(result.c_str(), 0700); return result;
}
int main(int argc, char** argv) {
  CHECK(argc == 2); const fs::path root(argv[1]);
  const auto crypto = std::make_shared<FixtureCrypto>(); NativeLocalVault vault(crypto);
  std::vector<unsigned char> key, first, other; std::string error;
  auto good = profile(root, "good");
  CHECK(vault.GetKey(good.string(), kCore, true, &first, &error)); CHECK(first.size() == 32 && error.empty());
  CHECK(vault.GetKey(good.string(), kCore, false, &key, &error)); CHECK(key == first);
  CHECK(vault.GetKey(good.string(), kBrowser, false, &other, &error)); CHECK(other.size() == 32 && other != first);
  auto missing = profile(root, "missing"); const int seals = crypto->seal_calls, opens = crypto->open_calls, derives = crypto->derive_calls;
  key = {9}; CHECK(!vault.GetKey(missing.string(), kCore, false, &key, &error)); CHECK(key.empty());
  CHECK(fs::is_empty(missing)); CHECK(crypto->seal_calls == seals && crypto->open_calls == opens && crypto->derive_calls == derives);
  for (const std::string kind : {"unknown-file", "Profile 1", "native-core"}) {
    auto dir = profile(root, "existing-" + kind); auto entry = dir / kind;
    if (kind == "unknown-file") CHECK(writeFile(entry, "existing"));
    else CHECK(fs::create_directory(entry));
    const int before = crypto->seal_calls; key = {9};
    CHECK(!vault.GetKey(dir.string(), kCore, true, &key, &error));
    CHECK(key.empty() && crypto->seal_calls == before && !fs::exists(dir / kVault) && fs::exists(entry));
  }
  auto marked = profile(root, "marked");
  CHECK(writeFile(marked / ".kestrel-native-default-v1", "kestrel-native-v1\n"));
  CHECK(writeFile(marked / ".kestrel-native-test-profile-v1", "native-test-profile-v1\n"));
  CHECK(writeFile(marked / ".kestrel-desktop.lock", ""));
  CHECK(vault.GetKey(marked.string(), kCore, true, &key, &error));
  CHECK(key.size() == 32 && fs::exists(marked / kVault));
  for (const std::string marker : {".kestrel-native-default-v1", ".kestrel-native-test-profile-v1", ".kestrel-desktop.lock"}) {
    auto dir = profile(root, "bad-marker-" + marker); CHECK(writeFile(dir / marker, "wrong"));
    const int before = crypto->seal_calls; key = {9};
    CHECK(!vault.GetKey(dir.string(), kCore, true, &key, &error));
    CHECK(key.empty() && crypto->seal_calls == before && !fs::exists(dir / kVault));
  }
  auto racing = profile(root, "appears-during-seal");
  crypto->create_during_seal = racing / "new-existing-data";
  const int before_racing = crypto->seal_calls; key = {9};
  CHECK(!vault.GetKey(racing.string(), kCore, true, &key, &error));
  CHECK(key.empty() && crypto->seal_calls == before_racing + 1 && fs::exists(crypto->create_during_seal) && !fs::exists(racing / kVault));
  crypto->create_during_seal.clear();
  for (const std::string kind : {"malformed", "link", "hardlink", "readable", "fifo", "oversized"}) {
    auto dir = profile(root, kind); auto path = dir / kVault;
    if (kind == "link") { auto target = root / "target"; CHECK(writeFile(target, "target")); CHECK(symlink(target.c_str(), path.c_str()) == 0); }
    else if (kind == "hardlink") { auto target = root / "hardlink-target"; CHECK(writeFile(target, "original")); CHECK(link(target.c_str(), path.c_str()) == 0); }
    else if (kind == "fifo") CHECK(mkfifo(path.c_str(), 0600) == 0);
    else CHECK(writeFile(path, kind == "oversized" ? std::string(16385, 'x') : "bad", kind == "readable" ? 0644 : 0600));
    struct stat before {}, after {}; CHECK(lstat(path.c_str(), &before) == 0);
    key = {9}; CHECK(!vault.GetKey(dir.string(), kCore, true, &key, &error)); CHECK(key.empty());
    CHECK(lstat(path.c_str(), &after) == 0); CHECK(before.st_ino == after.st_ino && before.st_mode == after.st_mode && before.st_size == after.st_size);
    CHECK(std::distance(fs::directory_iterator(dir), fs::directory_iterator()) == 1);
  }
  auto badMode = profile(root, "nonprivate"); CHECK(chmod(badMode.c_str(), 0755) == 0);
  key = {9}; CHECK(!vault.GetKey(badMode.string(), kCore, true, &key, &error)); CHECK(key.empty() && fs::is_empty(badMode));
  key = {9}; CHECK(!vault.GetKey((good / ".").string(), kCore, true, &key, &error)); CHECK(key.empty());
  auto failure = profile(root, "seal-failure"); crypto->seal_failure = true; key = {9};
  CHECK(!vault.GetKey(failure.string(), kCore, true, &key, &error)); CHECK(key.empty() && fs::is_empty(failure)); crypto->seal_failure = false;
  crypto->open_failure = true; key = {9}; CHECK(!vault.GetKey(good.string(), kCore, true, &key, &error)); CHECK(key.empty()); crypto->open_failure = false;
  crypto->derive_failure = true; key = {9}; CHECK(!vault.GetKey(good.string(), kCore, true, &key, &error)); CHECK(key.empty()); crypto->derive_failure = false;
  CHECK(vault.GetKey(good.string(), kCore, false, &key, &error) && key == first);
  return 0;
}
