#include <cstring>
#include <iostream>

#include "include/cef_app.h"
#include "include/cef_sandbox_mac.h"
#include "include/wrapper/cef_library_loader.h"
#include "kestrel_chromium_app.h"

namespace {

bool no_sandbox_requested(int argc, char* argv[]) {
  for (int index = 1; index < argc; ++index) {
    if (std::strcmp(argv[index], "--kestrel-allow-no-sandbox") == 0 ||
        std::strcmp(argv[index], "--no-sandbox") == 0)
      return true;
  }
  return false;
}

}  // namespace

int main(int argc, char* argv[]) {
  // A shipping Kestrel process does not use this escape hatch. It exists only
  // to diagnose local signing failures without misrepresenting them as a
  // production-ready browser process.
  const bool no_sandbox = no_sandbox_requested(argc, argv);
  CefScopedSandboxContext sandbox_context;
  if (!no_sandbox && !sandbox_context.Initialize(argc, argv)) {
    std::cerr << "Kestrel Chromium helper could not initialize its sandbox."
              << std::endl;
    return 1;
  }

  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInHelper()) {
    std::cerr << "Kestrel Chromium helper could not load the bundled framework."
              << std::endl;
    return 1;
  }

  CefMainArgs main_args(argc, argv);
  bool extension_workbench = false;
  for (int index = 1; index < argc; ++index) {
    if (std::strcmp(argv[index], "--kestrel-extension-workbench") == 0)
      extension_workbench = true;
  }
  CefRefPtr<KestrelChromiumApp> app(
      new KestrelChromiumApp({}, extension_workbench));
  return CefExecuteProcess(main_args, app.get(), nullptr);
}
