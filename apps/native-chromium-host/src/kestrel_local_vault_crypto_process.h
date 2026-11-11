#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Production uses the helper beside the executable in the main app bundle.
// An explicit path is only for standalone fixture tests.
bool NativeVaultSealIsolated(const std::vector<uint8_t>& context,
                             const std::vector<uint8_t>& key,
                             std::vector<uint8_t>* envelope,
                             const std::string& test_helper_path = {});
bool NativeVaultOpenIsolated(const std::vector<uint8_t>& context,
                             const std::vector<uint8_t>& envelope,
                             std::vector<uint8_t>* key,
                             const std::string& test_helper_path = {});
