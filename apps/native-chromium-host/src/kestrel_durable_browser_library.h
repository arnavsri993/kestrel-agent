#pragma once

#include <string>
#include <vector>

#include "include/cef_values.h"

// Isolated-profile browser library for the native Chromium host.
// Persists only when the host is launched with --kestrel-durable-profile.
// Never reads or writes the Electron Application Support profile.

struct DurableBookmark {
  std::string id;
  std::string url;
  std::string title;
  std::string display_mode = "full";
  std::string folder_id;
  std::string created_at;
};

struct DurableBookmarkFolder {
  std::string id;
  std::string name;
  std::string created_at;
};

struct DurableHistoryEntry {
  std::string id;
  std::string tab_id;
  std::string url;
  std::string title;
  std::string visited_at;
};

struct DurableDownload {
  std::string id;
  std::string tab_id;
  std::string filename;
  std::string source_url;
  int64_t received_bytes = 0;
  int64_t total_bytes = 0;
  std::string status = "completed";
  std::string started_at;
  std::string completed_at;
  bool can_reveal = false;
};

struct DurableSitePermission {
  std::string origin;
  std::string permission;
  std::string decision;
  std::string updated_at;
};

struct DurableBrowserLibrary {
  static constexpr int kVersion = 1;
  static constexpr size_t kMaxBookmarks = 2000;
  static constexpr size_t kMaxBookmarkFolders = 100;
  static constexpr size_t kMaxHistory = 5000;
  static constexpr size_t kMaxDownloads = 500;
  static constexpr size_t kMaxSitePermissions = 500;

  std::vector<DurableBookmark> bookmarks;
  std::vector<DurableBookmarkFolder> bookmark_folders;
  std::vector<DurableHistoryEntry> history;
  std::vector<DurableDownload> downloads;
  std::vector<DurableSitePermission> site_permissions;

  std::string LibraryPath(const std::string& isolated_profile_root) const;
  bool Load(const std::string& isolated_profile_root);
  bool Save(const std::string& isolated_profile_root) const;

  CefRefPtr<CefListValue> SerializeBookmarks() const;
  CefRefPtr<CefListValue> SerializeBookmarkFolders() const;
  CefRefPtr<CefListValue> SerializeHistory() const;
  CefRefPtr<CefListValue> SerializeDownloads() const;
  CefRefPtr<CefListValue> SerializeSitePermissions() const;
};
