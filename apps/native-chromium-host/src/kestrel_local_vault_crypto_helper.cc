#include "kestrel_local_vault_crypto.h"
#include <arpa/inet.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <vector>

namespace {
void Wipe(void* ptr, size_t len) { volatile uint8_t* p = static_cast<volatile uint8_t*>(ptr); while (len--) *p++ = 0; }
bool Transfer(int fd, void* buffer, size_t len, bool writing) {
  auto* p = static_cast<uint8_t*>(buffer);
  while (len) {
    ssize_t n = writing ? write(fd, p, len) : read(fd, p, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    p += n; len -= static_cast<size_t>(n);
  }
  return true;
}
uint32_t Get32(const uint8_t* p) { uint32_t n; memcpy(&n, p, 4); return ntohl(n); }
void Put32(uint8_t* p, uint32_t n) { n = htonl(n); memcpy(p, &n, 4); }
}
int main() {
  constexpr int fd = 3;
  uint8_t header[16];
  if (!Transfer(fd, header, sizeof(header), false) || memcmp(header, "KVC1", 4)) return 1;
  uint32_t op = Get32(header + 4), ctx_len = Get32(header + 8), in_len = Get32(header + 12);
  if ((op != 1 && op != 2) || !ctx_len || ctx_len > KESTREL_VAULT_MAX_CONTEXT ||
      (op == 1 ? in_len != 32 : !in_len || in_len > KESTREL_VAULT_MAX_ENVELOPE)) return 1;
  std::vector<uint8_t> ctx(ctx_len), input(in_len);
  if (!Transfer(fd, ctx.data(), ctx.size(), false) || !Transfer(fd, input.data(), input.size(), false)) return 1;
  uint8_t trailing;
  ssize_t n;
  do { n = read(fd, &trailing, 1); } while (n < 0 && errno == EINTR);
  if (n != 0) return 1;
  std::vector<uint8_t> output(op == 1 ? KESTREL_VAULT_MAX_ENVELOPE : 32);
  size_t out_len = 0;
  int32_t status = op == 1
      ? kestrel_vault_seal(ctx.data(), ctx.size(), input.data(), input.size(), output.data(), output.size(), &out_len)
      : kestrel_vault_open(ctx.data(), ctx.size(), input.data(), input.size(), output.data(), output.size(), &out_len);
  Wipe(input.data(), input.size());
  if (status != 0 || (op == 1 ? !out_len || out_len > output.size() : out_len != 32)) {
    Wipe(output.data(), output.size()); return 1;
  }
  uint8_t reply[8]; memcpy(reply, "KVR1", 4); Put32(reply + 4, static_cast<uint32_t>(out_len));
  bool ok = Transfer(fd, reply, sizeof(reply), true) && Transfer(fd, output.data(), out_len, true);
  Wipe(output.data(), output.size());
  return ok ? 0 : 1;
}
