#pragma once
#include <cstdint>
#include <string>

// Leave other origins to Chromium's normal permission UI. The owned extension
// must never inherit that fallback for another document or a mixed request.
enum class NativeMicrophoneDecision { kChromiumDefault, kDeny, kAllowAudio };
inline NativeMicrophoneDecision NativeMicrophonePolicy(const std::string& ui_url,
    const std::string& origin, const std::string& frame_url, bool main_frame,
    uint32_t requested, uint32_t audio_only, bool os_authorized) {
  const auto slash = ui_url.find('/', ui_url.find("://") + 3);
  if (slash == std::string::npos) return NativeMicrophoneDecision::kDeny;
  const std::string owned_origin = ui_url.substr(0, slash);
  if (origin != owned_origin && origin != owned_origin + "/") return NativeMicrophoneDecision::kChromiumDefault;
  const bool document = frame_url == ui_url ||
      (frame_url.size() > ui_url.size() && frame_url.compare(0, ui_url.size(), ui_url) == 0 &&
       (frame_url[ui_url.size()] == '?' || frame_url[ui_url.size()] == '#'));
  return main_frame && document && requested == audio_only && os_authorized
      ? NativeMicrophoneDecision::kAllowAudio : NativeMicrophoneDecision::kDeny;
}
