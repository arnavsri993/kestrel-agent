#include <node_api.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <libproc.h>
#include <unistd.h>

#include <climits>
#include <cmath>
#include <cstring>

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

napi_value Init(napi_env env, napi_value exports) {
  napi_value inspect;
  if (napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, Inspect, nullptr, &inspect) != napi_ok ||
      napi_set_named_property(env, exports, "inspect", inspect) != napi_ok)
    return Fail(env, "could not initialize peer inspector");
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
