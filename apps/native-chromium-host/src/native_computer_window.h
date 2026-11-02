#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

struct NativeComputerWindowRect {
  double x = 0, y = 0, width = 0, height = 0;
};
struct NativeComputerWindowCandidate {
  int process_id = 0;
  uint32_t window_id = 0;
  int layer = 0;
  double alpha = 1;
  NativeComputerWindowRect bounds;
};
struct NativeComputerWindowSelection {
  bool found = false;
  bool ambiguous = false;
  NativeComputerWindowCandidate window;
};

inline bool NativeComputerWindowRectMatches(const NativeComputerWindowRect& a,
                                            const NativeComputerWindowRect& b) {
  return std::isfinite(a.x) && std::isfinite(a.y) &&
      std::isfinite(a.width) && std::isfinite(a.height) &&
      std::isfinite(b.x) && std::isfinite(b.y) &&
      std::isfinite(b.width) && std::isfinite(b.height) &&
      std::abs(a.x - b.x) <= 0.5 && std::abs(a.y - b.y) <= 0.5 &&
      std::abs(a.width - b.width) <= 0.5 && std::abs(a.height - b.height) <= 0.5;
}

// Window-server order includes sharing badges and floating helper windows.
// Control uses an exact own-app key-window number or unique focused AX bounds.
// Without Accessibility, the normal-window fallback is for read-only capture;
// the input owner independently requires Accessibility before submitting input.
inline NativeComputerWindowSelection SelectNativeComputerWindow(
    const std::vector<NativeComputerWindowCandidate>& windows, int process_id,
    uint32_t focused_window_id, const NativeComputerWindowRect* focused_bounds) {
  NativeComputerWindowSelection selected;
  if (process_id <= 0) return selected;
  for (const auto& window : windows) {
    const auto& bounds = window.bounds;
    if (window.process_id != process_id || window.window_id == 0 ||
        !std::isfinite(window.alpha) || window.alpha <= 0.01 ||
        !std::isfinite(bounds.x) || !std::isfinite(bounds.y) ||
        !std::isfinite(bounds.width) || !std::isfinite(bounds.height) ||
        bounds.width <= 0 || bounds.height <= 0) continue;
    if (focused_window_id != 0 && window.window_id != focused_window_id) continue;
    if (focused_bounds && !NativeComputerWindowRectMatches(bounds, *focused_bounds)) continue;
    if (focused_window_id == 0 && !focused_bounds && window.layer != 0) continue;
    if (focused_bounds && selected.found) {
      selected.found = false;
      selected.ambiguous = true;
      return selected;
    }
    selected.found = true;
    selected.window = window;
    if (focused_window_id != 0 || !focused_bounds) return selected;
  }
  return selected;
}
