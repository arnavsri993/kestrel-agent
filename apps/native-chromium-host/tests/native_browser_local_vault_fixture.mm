#import <Foundation/Foundation.h>
#include "../src/kestrel_browser_local_vault.h"
#include <dlfcn.h>
#include <cstdio>
#include <cstring>
#include <string>

// The fake framework is loaded with the same visibility as CEF's wrapper.
// It never implements encryption and aborts if configure is reached.
int main(int argc, char** argv) {
  @autoreleasepool {
    if (argc != 4) return 2;
    NSString* framework = [NSBundle.mainBundle.privateFrameworksPath
        stringByAppendingPathComponent:@"Chromium Embedded Framework.framework/Chromium Embedded Framework"];
    void* library = dlopen(framework.fileSystemRepresentation, RTLD_LAZY | RTLD_LOCAL | RTLD_FIRST);
    if (!library) return 3;
    const bool has_version = dlsym(library, "cef_kestrel_vault_api_version") != nullptr;
    if (has_version && dlsym(RTLD_DEFAULT, "cef_kestrel_vault_api_version") != nullptr) return 4;
    std::string error;
    const bool ok = ConfigureNativeBrowserLocalVault(argv[1], !strcmp(argv[2], "mock"), &error);
    const bool expected = !strcmp(argv[3], "ok");
    if (ok != expected) { fprintf(stderr, "unexpected result: %s\n", error.c_str()); return 5; }
    if (ok) puts("ok"); else printf("%s\n", error.c_str());
    dlclose(library);
    return 0;
  }
}
