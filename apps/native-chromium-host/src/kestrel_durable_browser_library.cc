#include "kestrel_durable_browser_library.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string_view>

#include "include/cef_parser.h"

namespace {

bool is_http_url(const std::string& url) {
  return url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0;
}

bool has_control(const std::string& value) {
  return std::any_of(value.begin(), value.end(), [](unsigned char character) {
    return character < 0x20 || character == 0x7f;
  });
}

std::string sanitize_text(std::string value, size_t limit,
                          std::string_view fallback) {
  value.erase(std::remove_if(value.begin(), value.end(),
                             [](unsigned char character) {
                               return character < 0x20 || character == 0x7f;
                             }),
              value.end());
  if (value.size() > limit) value.resize(limit);
  return value.empty() ? std::string(fallback) : value;
}

bool ensure_directory(const std::string& path) {
  if (path.empty()) return false;
  struct stat info {};
  if (stat(path.c_str(), &info) == 0) {
    return S_ISDIR(info.st_mode);
  }
  if (mkdir(path.c_str(), 0700) == 0) return true;
  return errno == EEXIST;
}

bool atomic_write(const std::string& path, const std::string& contents) {
  const std::string temporary = path + ".tmp";
  const int fd =
      open(temporary.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  const char* cursor = contents.data();
  size_t remaining = contents.size();
  while (remaining > 0) {
    const ssize_t written = write(fd, cursor, remaining);
    if (written <= 0) {
      close(fd);
      unlink(temporary.c_str());
      return false;
    }
    cursor += written;
    remaining -= static_cast<size_t>(written);
  }
  if (fsync(fd) != 0) {
    close(fd);
    unlink(temporary.c_str());
    return false;
  }
  close(fd);
  if (chmod(temporary.c_str(), 0600) != 0) {
    unlink(temporary.c_str());
    return false;
  }
  if (rename(temporary.c_str(), path.c_str()) != 0) {
    unlink(temporary.c_str());
    return false;
  }
  return true;
}

std::string read_file(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return {};
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

std::string required_string(CefRefPtr<CefDictionaryValue> item,
                            const char* key) {
  if (!item || item->GetType(key) != VTYPE_STRING) return {};
  return item->GetString(key).ToString();
}

}  // namespace

std::string DurableBrowserLibrary::LibraryPath(
    const std::string& isolated_profile_root) const {
  if (isolated_profile_root.empty()) return {};
  return isolated_profile_root + "/browser-library.json";
}

bool DurableBrowserLibrary::Load(const std::string& isolated_profile_root) {
  bookmarks.clear();
  bookmark_folders.clear();
  history.clear();
  downloads.clear();
  site_permissions.clear();

  const std::string path = LibraryPath(isolated_profile_root);
  if (path.empty()) return false;
  const std::string raw = read_file(path);
  if (raw.empty()) return true;

  const CefRefPtr<CefValue> parsed = CefParseJSON(raw, JSON_PARSER_RFC);
  if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) {
    std::cerr << "Kestrel ignored an invalid durable browser library."
              << std::endl;
    return false;
  }
  const CefRefPtr<CefDictionaryValue> root = parsed->GetDictionary();
  if (!root || root->GetType("version") != VTYPE_INT ||
      root->GetInt("version") != kVersion) {
    std::cerr << "Kestrel ignored an unsupported durable browser library."
              << std::endl;
    return false;
  }

  if (root->GetType("bookmarkFolders") == VTYPE_LIST) {
    const CefRefPtr<CefListValue> list = root->GetList("bookmarkFolders");
    for (size_t index = 0; list && index < list->GetSize(); ++index) {
      if (list->GetType(index) != VTYPE_DICTIONARY) continue;
      const CefRefPtr<CefDictionaryValue> item = list->GetDictionary(index);
      DurableBookmarkFolder folder;
      folder.id = required_string(item, "id");
      folder.name = sanitize_text(required_string(item, "name"), 80, "");
      folder.created_at = required_string(item, "createdAt");
      if (folder.id.rfind("bookmark-folder-", 0) != 0 || folder.name.empty() ||
          folder.created_at.empty() || has_control(folder.id)) {
        continue;
      }
      bookmark_folders.push_back(std::move(folder));
      if (bookmark_folders.size() >= kMaxBookmarkFolders) break;
    }
  }

  if (root->GetType("bookmarks") == VTYPE_LIST) {
    const CefRefPtr<CefListValue> list = root->GetList("bookmarks");
    for (size_t index = 0; list && index < list->GetSize(); ++index) {
      if (list->GetType(index) != VTYPE_DICTIONARY) continue;
      const CefRefPtr<CefDictionaryValue> item = list->GetDictionary(index);
      DurableBookmark bookmark;
      bookmark.id = required_string(item, "id");
      bookmark.url = required_string(item, "url");
      bookmark.title =
          sanitize_text(required_string(item, "title"), 500, "Untitled");
      bookmark.display_mode = required_string(item, "displayMode");
      if (bookmark.display_mode != "full" && bookmark.display_mode != "title" &&
          bookmark.display_mode != "icon") {
        bookmark.display_mode = "full";
      }
      bookmark.folder_id = required_string(item, "folderId");
      bookmark.created_at = required_string(item, "createdAt");
      if (bookmark.id.rfind("bookmark-", 0) != 0 || !is_http_url(bookmark.url) ||
          bookmark.url.size() > 8192 || bookmark.created_at.empty() ||
          has_control(bookmark.id) || has_control(bookmark.url)) {
        continue;
      }
      if (!bookmark.folder_id.empty()) {
        const bool folder_exists = std::any_of(
            bookmark_folders.begin(), bookmark_folders.end(),
            [&](const DurableBookmarkFolder& folder) {
              return folder.id == bookmark.folder_id;
            });
        if (!folder_exists) bookmark.folder_id.clear();
      }
      bookmarks.push_back(std::move(bookmark));
      if (bookmarks.size() >= kMaxBookmarks) break;
    }
  }

  if (root->GetType("history") == VTYPE_LIST) {
    const CefRefPtr<CefListValue> list = root->GetList("history");
    for (size_t index = 0; list && index < list->GetSize(); ++index) {
      if (list->GetType(index) != VTYPE_DICTIONARY) continue;
      const CefRefPtr<CefDictionaryValue> item = list->GetDictionary(index);
      DurableHistoryEntry entry;
      entry.id = required_string(item, "id");
      entry.tab_id = required_string(item, "tabId");
      entry.url = required_string(item, "url");
      entry.title =
          sanitize_text(required_string(item, "title"), 500, "Untitled");
      entry.visited_at = required_string(item, "visitedAt");
      if (entry.id.rfind("visit-", 0) != 0 ||
          entry.tab_id.rfind("tab-", 0) != 0 || !is_http_url(entry.url) ||
          entry.url.size() > 8192 || entry.visited_at.empty()) {
        continue;
      }
      history.push_back(std::move(entry));
      if (history.size() >= kMaxHistory) break;
    }
  }

  if (root->GetType("downloads") == VTYPE_LIST) {
    const CefRefPtr<CefListValue> list = root->GetList("downloads");
    for (size_t index = 0; list && index < list->GetSize(); ++index) {
      if (list->GetType(index) != VTYPE_DICTIONARY) continue;
      const CefRefPtr<CefDictionaryValue> item = list->GetDictionary(index);
      DurableDownload download;
      download.id = required_string(item, "id");
      download.tab_id = required_string(item, "tabId");
      download.filename =
          sanitize_text(required_string(item, "filename"), 255, "download");
      download.source_url = required_string(item, "sourceUrl");
      download.received_bytes = item->GetType("receivedBytes") == VTYPE_INT
                                    ? item->GetInt("receivedBytes")
                                    : 0;
      download.total_bytes = item->GetType("totalBytes") == VTYPE_INT
                                 ? item->GetInt("totalBytes")
                                 : 0;
      download.status = required_string(item, "status");
      download.started_at = required_string(item, "startedAt");
      download.completed_at = required_string(item, "completedAt");
      download.can_reveal =
          item->GetType("canReveal") == VTYPE_BOOL && item->GetBool("canReveal");
      if (download.id.rfind("download-", 0) != 0 ||
          !is_http_url(download.source_url) || download.started_at.empty()) {
        continue;
      }
      if (download.status != "checking" && download.status != "progressing" &&
          download.status != "completed" && download.status != "cancelled" &&
          download.status != "failed" && download.status != "blocked") {
        download.status = "completed";
      }
      downloads.push_back(std::move(download));
      if (downloads.size() >= kMaxDownloads) break;
    }
  }

  if (root->GetType("sitePermissions") == VTYPE_LIST) {
    const CefRefPtr<CefListValue> list = root->GetList("sitePermissions");
    for (size_t index = 0; list && index < list->GetSize(); ++index) {
      if (list->GetType(index) != VTYPE_DICTIONARY) continue;
      const CefRefPtr<CefDictionaryValue> item = list->GetDictionary(index);
      DurableSitePermission permission;
      permission.origin = required_string(item, "origin");
      permission.permission = required_string(item, "permission");
      permission.decision = required_string(item, "decision");
      permission.updated_at = required_string(item, "updatedAt");
      if (permission.origin.empty() || permission.permission.empty() ||
          (permission.decision != "allow" && permission.decision != "deny") ||
          permission.updated_at.empty()) {
        continue;
      }
      site_permissions.push_back(std::move(permission));
      if (site_permissions.size() >= kMaxSitePermissions) break;
    }
  }

  return true;
}

bool DurableBrowserLibrary::Save(
    const std::string& isolated_profile_root) const {
  const std::string path = LibraryPath(isolated_profile_root);
  if (path.empty()) return false;
  if (!ensure_directory(isolated_profile_root)) return false;

  CefRefPtr<CefDictionaryValue> root = CefDictionaryValue::Create();
  root->SetInt("version", kVersion);
  root->SetList("bookmarks", SerializeBookmarks());
  root->SetList("bookmarkFolders", SerializeBookmarkFolders());
  root->SetList("history", SerializeHistory());
  root->SetList("downloads", SerializeDownloads());
  root->SetList("sitePermissions", SerializeSitePermissions());

  CefRefPtr<CefValue> value = CefValue::Create();
  if (!value->SetDictionary(root)) return false;
  const std::string json =
      CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString() + "\n";
  return atomic_write(path, json);
}

CefRefPtr<CefListValue> DurableBrowserLibrary::SerializeBookmarks() const {
  CefRefPtr<CefListValue> list = CefListValue::Create();
  list->SetSize(bookmarks.size());
  for (size_t index = 0; index < bookmarks.size(); ++index) {
    const DurableBookmark& bookmark = bookmarks[index];
    CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
    item->SetString("id", bookmark.id);
    item->SetString("url", bookmark.url);
    item->SetString("title", bookmark.title);
    item->SetString("displayMode", bookmark.display_mode);
    if (!bookmark.folder_id.empty()) {
      item->SetString("folderId", bookmark.folder_id);
    }
    item->SetString("createdAt", bookmark.created_at);
    list->SetDictionary(index, item);
  }
  return list;
}

CefRefPtr<CefListValue> DurableBrowserLibrary::SerializeBookmarkFolders()
    const {
  CefRefPtr<CefListValue> list = CefListValue::Create();
  list->SetSize(bookmark_folders.size());
  for (size_t index = 0; index < bookmark_folders.size(); ++index) {
    const DurableBookmarkFolder& folder = bookmark_folders[index];
    CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
    item->SetString("id", folder.id);
    item->SetString("name", folder.name);
    item->SetString("createdAt", folder.created_at);
    list->SetDictionary(index, item);
  }
  return list;
}

CefRefPtr<CefListValue> DurableBrowserLibrary::SerializeHistory() const {
  CefRefPtr<CefListValue> list = CefListValue::Create();
  list->SetSize(history.size());
  for (size_t index = 0; index < history.size(); ++index) {
    const DurableHistoryEntry& entry = history[index];
    CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
    item->SetString("id", entry.id);
    item->SetString("tabId", entry.tab_id);
    item->SetString("url", entry.url);
    item->SetString("title", entry.title);
    item->SetString("visitedAt", entry.visited_at);
    list->SetDictionary(index, item);
  }
  return list;
}

CefRefPtr<CefListValue> DurableBrowserLibrary::SerializeDownloads() const {
  CefRefPtr<CefListValue> list = CefListValue::Create();
  list->SetSize(downloads.size());
  for (size_t index = 0; index < downloads.size(); ++index) {
    const DurableDownload& download = downloads[index];
    CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
    item->SetString("id", download.id);
    if (!download.tab_id.empty()) item->SetString("tabId", download.tab_id);
    item->SetString("filename", download.filename);
    item->SetString("sourceUrl", download.source_url);
    item->SetInt("receivedBytes",
                 static_cast<int>(std::min<int64_t>(
                     download.received_bytes, INT_MAX)));
    item->SetInt("totalBytes",
                 static_cast<int>(
                     std::min<int64_t>(download.total_bytes, INT_MAX)));
    item->SetString("status", download.status);
    item->SetString("startedAt", download.started_at);
    if (!download.completed_at.empty()) {
      item->SetString("completedAt", download.completed_at);
    }
    item->SetBool("canReveal", download.can_reveal);
    list->SetDictionary(index, item);
  }
  return list;
}

CefRefPtr<CefListValue> DurableBrowserLibrary::SerializeSitePermissions()
    const {
  CefRefPtr<CefListValue> list = CefListValue::Create();
  list->SetSize(site_permissions.size());
  for (size_t index = 0; index < site_permissions.size(); ++index) {
    const DurableSitePermission& permission = site_permissions[index];
    CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
    item->SetString("origin", permission.origin);
    item->SetString("permission", permission.permission);
    item->SetString("decision", permission.decision);
    item->SetString("updatedAt", permission.updated_at);
    list->SetDictionary(index, item);
  }
  return list;
}
