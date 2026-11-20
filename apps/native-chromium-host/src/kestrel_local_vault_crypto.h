#ifndef KESTREL_LOCAL_VAULT_CRYPTO_H_
#define KESTREL_LOCAL_VAULT_CRYPTO_H_
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Buffers must not overlap. Output is cleared on failure (up to the relevant
 * maximum); out_len is always zero on failure. Context is 1..4096 bytes. */
enum kestrel_vault_status {
  KESTREL_VAULT_OK = 0,
  KESTREL_VAULT_INVALID = 1,
  KESTREL_VAULT_BUFFER_TOO_SMALL = 2,
  KESTREL_VAULT_UNAVAILABLE = 3,
  KESTREL_VAULT_CRYPTO_FAILURE = 4
};
#define KESTREL_VAULT_KEY_SIZE 32
#define KESTREL_VAULT_MAX_CONTEXT 4096
#define KESTREL_VAULT_MAX_ENVELOPE 16384
int32_t kestrel_vault_seal(const uint8_t *context, size_t context_len,
                           const uint8_t *key, size_t key_len,
                           uint8_t *out, size_t out_capacity, size_t *out_len);
int32_t kestrel_vault_open(const uint8_t *context, size_t context_len,
                           const uint8_t *envelope, size_t envelope_len,
                           uint8_t *out_key, size_t out_capacity, size_t *out_len);
int32_t kestrel_vault_derive(const uint8_t *context, size_t context_len,
                             const uint8_t *master, size_t master_len,
                             const uint8_t *purpose, size_t purpose_len,
                             uint8_t *out_key, size_t out_capacity, size_t *out_len);
#ifdef __cplusplus
}
#endif
#endif
