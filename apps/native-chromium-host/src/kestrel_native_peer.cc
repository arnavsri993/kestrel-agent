#include <node_api.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <libproc.h>
#include <unistd.h>

#include <climits>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <string>
#include <vector>
#include "kestrel_backup_publication.h"

namespace {
napi_value Fail(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

bool SetNumber(napi_env env, napi_value object, const char* name, double number) {
  napi_value value;
  return napi_create_double(env, number, &value) == napi_ok &&
         napi_set_named_property(env, object, name, value) == napi_ok;
}

napi_value Inspect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  if (napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr) != napi_ok || argc != 1)
    return Fail(env, "inspect requires a connected socket file descriptor");
  napi_valuetype type;
  double input;
  if (napi_typeof(env, arg, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, arg, &input) != napi_ok || !std::isfinite(input) ||
      std::floor(input) != input || input < 0 || input > INT_MAX)
    return Fail(env, "invalid socket file descriptor");
  const int fd = static_cast<int>(input);
  pid_t pid = 0;
  socklen_t pid_size = sizeof(pid);
  uid_t uid;
  gid_t gid;
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pid_size) != 0 ||
      pid_size != sizeof(pid) || pid <= 0 || getpeereid(fd, &uid, &gid) != 0)
    return Fail(env, "could not authenticate Unix socket peer");
  proc_bsdinfo process{};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process))
    return Fail(env, "could not inspect Unix socket peer process");
  char path[PROC_PIDPATHINFO_MAXSIZE]{};
  int path_size = proc_pidpath(pid, path, sizeof(path));
  if (path_size <= 0 || path_size >= static_cast<int>(sizeof(path)))
    return Fail(env, "could not resolve Unix socket peer executable");
  napi_value result, executable;
  if (napi_create_object(env, &result) != napi_ok ||
      !SetNumber(env, result, "pid", pid) || !SetNumber(env, result, "uid", uid) ||
      !SetNumber(env, result, "gid", gid) || !SetNumber(env, result, "parentPid", process.pbi_ppid) ||
      napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &executable) != napi_ok ||
      napi_set_named_property(env, result, "executable", executable) != napi_ok)
    return Fail(env, "could not return Unix socket peer identity");
  return result;
}

bool String(napi_env env, napi_value value, size_t maximum, std::string* output) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok ||
      size == 0 || size > maximum) return false;
  std::vector<char> buffer(size + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size) != napi_ok)
    return false;
  output->assign(buffer.data(), size);
  return output->find('\0') == std::string::npos;
}
bool Identity(napi_env env, napi_value object, const char* name, uint64_t* result) {
  napi_value value;
  std::string text;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      !String(env, value, 20, &text)) return false;
  for (char c : text) if (c < '0' || c > '9') return false;
  errno = 0;
  char* end = nullptr;
  const auto number = strtoull(text.c_str(), &end, 10);
  if (errno != 0 || !end || *end != '\0') return false;
  *result = number;
  return true;
}
napi_value PublishBackup(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3], names;
  std::string staging, final_path;
  uint32_t count = 0;
  kestrel::BackupDirectoryIdentity identity{};
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3 ||
      !String(env, args[0], 4096, &staging) || !String(env, args[1], 4096, &final_path) ||
      napi_get_property_names(env, args[2], &names) != napi_ok ||
      napi_get_array_length(env, names, &count) != napi_ok || count != 4 ||
      !Identity(env, args[2], "parentDev", &identity.parent_dev) ||
      !Identity(env, args[2], "parentIno", &identity.parent_ino) ||
      !Identity(env, args[2], "stagingDev", &identity.staging_dev) ||
      !Identity(env, args[2], "stagingIno", &identity.staging_ino))
    return Fail(env, "Invalid private backup publication request.");
  const auto result = kestrel::PublishBackupDirectory(staging, final_path, identity);
  if (result != kestrel::BackupPublication::kPublished) {
    napi_throw_error(env, result == kestrel::BackupPublication::kCommittedSyncUncertain
        ? "KESTREL_BACKUP_COMMITTED_SYNC_UNCERTAIN" : "KESTREL_BACKUP_PUBLISH_FAILED",
        result == kestrel::BackupPublication::kCommittedSyncUncertain
        ? "Backup was published but directory synchronization could not be confirmed."
        : "Backup publication was refused.");
    return nullptr;
  }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value inspect, publish;
  if (napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, Inspect, nullptr, &inspect) != napi_ok ||
      napi_set_named_property(env, exports, "inspect", inspect) != napi_ok ||
      napi_create_function(env, "publishBackupDirectory", NAPI_AUTO_LENGTH, PublishBackup, nullptr, &publish) != napi_ok ||
      napi_set_named_property(env, exports, "publishBackupDirectory", publish) != napi_ok)
    return Fail(env, "could not initialize peer inspector");
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
