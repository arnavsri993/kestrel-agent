#include "native_computer_window.h"

#include <cassert>
#include <limits>

int main() {
  // A real failure placed a small Chromium sharing indicator ahead of the
  // focused browser on a display above and to the right of the main display.
  const NativeComputerWindowRect browser = {3390, -1246, 1036, 778};
  std::vector<NativeComputerWindowCandidate> windows = {
      {42, 10, 0, 1, {3422, -1184, 66, 20}},
      {43, 11, 0, 1, browser},
      {42, 12, 0, 1, browser},
  };
  const auto own = SelectNativeComputerWindow(windows, 42, 12, nullptr);
  assert(own.found && !own.ambiguous && own.window.window_id == 12);
  const auto external = SelectNativeComputerWindow(windows, 42, 0, &browser);
  assert(external.found && external.window.window_id == 12);

  // An exact focused modal window may be above the normal window layer.
  windows.push_back({42, 13, 8, 1, {3400, -1200, 500, 200}});
  const NativeComputerWindowRect modal = windows.back().bounds;
  assert(SelectNativeComputerWindow(windows, 42, 0, &modal).window.window_id == 13);

  // A missing focus match cannot fall back to the sharing badge or another app.
  const NativeComputerWindowRect missing = {0, 0, 800, 600};
  assert(!SelectNativeComputerWindow(windows, 42, 0, &missing).found);
  assert(!SelectNativeComputerWindow(windows, 42, 11, nullptr).found);
  assert(!SelectNativeComputerWindow(windows, 0, 0, nullptr).found);

  windows.push_back({42, 14, 0, 0, browser});
  windows.push_back({42, 15, 0, 1, {0, 0, std::numeric_limits<double>::quiet_NaN(), 600}});
  assert(SelectNativeComputerWindow(windows, 42, 0, &browser).window.window_id == 12);
  windows.push_back({42, 16, 0, 1, browser});
  const auto ambiguous = SelectNativeComputerWindow(windows, 42, 0, &browser);
  assert(!ambiguous.found && ambiguous.ambiguous);
  // The owned app's public key-window number still distinguishes overlapping windows.
  assert(SelectNativeComputerWindow(windows, 42, 16, nullptr).window.window_id == 16);
}
