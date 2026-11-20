#pragma once
#include <string>

// Main-browser-only. Must succeed before CefInitialize or a Core broker starts.
// A stock CEF framework cannot silently fall back to Keychain or a mock key.
bool ConfigureNativeBrowserLocalVault(const std::string& canonical_profile,
                                     bool disposable_test,
                                     std::string* error);
