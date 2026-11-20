#import "kestrel_native_prepared_profiles.h"
#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
NSError* Failure() { return [NSError errorWithDomain:@"com.kestrel.prepared-profiles" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Prepared profiles could not be inspected safely. All files were preserved."}]; }
bool PrivateDirectory(const struct stat& st) { return S_ISDIR(st.st_mode) && st.st_uid == getuid() && !(st.st_mode & 0077); }
bool Same(const struct stat& a, const struct stat& b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
bool SafeText(NSString* value) {
 if (![value isKindOfClass:NSString.class]) return false;
 return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}
bool ValidRelative(NSString* value) {
 if (!SafeText(value)) return false;
 if (!value.length) return true;
 NSArray<NSString*>* parts = value.pathComponents;
 if (parts.count != 2 || ![parts[0] isEqualToString:@"native-core-profiles"] || parts[1].length != 36) return false;
 NSUUID* uuid = [[NSUUID alloc] initWithUUIDString:parts[1]];
 return uuid && [uuid.UUIDString caseInsensitiveCompare:parts[1]] == NSOrderedSame && [value isEqualToString:[@"native-core-profiles" stringByAppendingPathComponent:parts[1]]];
}
int OpenRoot(NSString* root) {
 if (!SafeText(root) || !root.isAbsolutePath) return -1;
 const char* rootPath = root.fileSystemRepresentation;
 if (!rootPath) return -1;
 const size_t rootLength = strlen(rootPath);
 if (rootLength == 0 || rootLength > 4096 || rootLength != [root lengthOfBytesUsingEncoding:NSUTF8StringEncoding]) return -1;
 char canonical[PATH_MAX]{}; struct stat named{}, opened{};
 if (!realpath(rootPath, canonical) || ![root isEqualToString:[NSString stringWithUTF8String:canonical]] || lstat(rootPath, &named) || !PrivateDirectory(named)) return -1;
 int fd = open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
 if (fd < 0) return -1;
 if (fstat(fd, &opened) || !PrivateDirectory(opened) || !Same(named, opened)) { close(fd); return -1; }
 return fd;
}
int OpenPrivateAt(int parent, const char* name) {
 struct stat named{}, opened{};
 if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) || !PrivateDirectory(named)) return -1;
 int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
 if (fd < 0) return -1;
 if (fstat(fd, &opened) || !PrivateDirectory(opened) || !Same(named, opened)) { close(fd); return -1; }
 return fd;
}
bool SafeJournal(int profile) {
 int core = OpenPrivateAt(profile, "native-core"); if (core < 0) return false;
 int database = OpenPrivateAt(core, "database"); close(core); if (database < 0) return false;
 struct stat st{};
 const bool safe = !fstatat(database, "kestrel.sqlite.kestrel-transfer-journal", &st, AT_SYMLINK_NOFOLLOW) && S_ISREG(st.st_mode) && st.st_uid == getuid() && st.st_nlink == 1 && (st.st_mode & 0777) == 0600 && st.st_size > 0 && st.st_size <= 65536;
 close(database); return safe;
}
bool ReservationName(NSString* name) {
 NSString* prefix = @".kestrel-profile-", *suffix = @".lock";
 if (name.length != prefix.length + 64 + suffix.length || ![name hasPrefix:prefix] || ![name hasSuffix:suffix]) return false;
 NSString* hash = [name substringWithRange:NSMakeRange(prefix.length,64)];
 return [hash rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}
bool SafeReservation(int parent, const char* name) {
 struct stat info{};
 return !fstatat(parent,name,&info,AT_SYMLINK_NOFOLLOW) && S_ISREG(info.st_mode) && info.st_uid == getuid() && info.st_nlink == 1 &&
     (info.st_mode & 07777) == 0600 && info.st_size == 0;
}
}

NSArray<NSDictionary*>* KestrelInspectPreparedCoreProfiles(NSString* root, NSString* active, NSString* previous, NSError** error) {
 if (error) *error = nil;
 if (!ValidRelative(active) || !ValidRelative(previous)) { if (error) *error = Failure(); return nil; }
 int rootfd = OpenRoot(root); if (rootfd < 0) { if (error) *error = Failure(); return nil; }
 struct stat rootIdentity{};
 if (fstat(rootfd, &rootIdentity) || !PrivateDirectory(rootIdentity)) { close(rootfd); if (error) *error = Failure(); return nil; }
 struct stat parentStat{};
 if (fstatat(rootfd, "native-core-profiles", &parentStat, AT_SYMLINK_NOFOLLOW)) {
  const bool missing = errno == ENOENT; close(rootfd);
  if (!missing && error) *error = Failure(); return missing ? @[] : nil;
 }
 int parent = OpenPrivateAt(rootfd, "native-core-profiles"); close(rootfd);
 if (parent < 0) { if (error) *error = Failure(); return nil; }
 struct stat parentIdentity{};
 if (fstat(parent, &parentIdentity) || !PrivateDirectory(parentIdentity)) { close(parent); if (error) *error = Failure(); return nil; }
 int enumeration = dup(parent); DIR* directory = enumeration < 0 ? nullptr : fdopendir(enumeration);
 if (!directory) { if (enumeration >= 0) close(enumeration); close(parent); if (error) *error = Failure(); return nil; }
 NSMutableArray<NSDictionary*>* rows = [NSMutableArray array]; bool ok = true; size_t count = 0, reservations = 0;
 for (;;) {
  errno = 0; dirent* entry = readdir(directory); if (!entry) { if (errno) ok = false; break; }
  if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
  NSString* name = [NSString stringWithUTF8String:entry->d_name];
  if (!name) { ok = false; break; }
  // A closed active child can be reserved for transfer without launching it.
  // Its existing shared external fence is coordination metadata, not a profile.
  if (ReservationName(name)) {
   if (++reservations > 128 || !SafeReservation(parent,entry->d_name)) { ok = false; break; }
   continue;
  }
  if (++count > 128) { ok = false; break; }
  NSString* relative = [@"native-core-profiles" stringByAppendingPathComponent:name];
  if (!ValidRelative(relative) || !name.length) continue;
  NSString* path = [root stringByAppendingPathComponent:relative];
  if (strlen(path.fileSystemRepresentation) > 4096) { ok = false; break; }
  int child = OpenPrivateAt(parent, entry->d_name);
  if (child < 0) { ok = false; break; }
  struct stat st{}; if (fstat(child, &st)) { close(child); ok = false; break; }
  if (![relative isEqualToString:active] && ![relative isEqualToString:previous])
   [rows addObject:@{ @"relative":relative, @"path":path, @"rootDevice":@((unsigned long long)rootIdentity.st_dev), @"rootInode":@((unsigned long long)rootIdentity.st_ino), @"parentDevice":@((unsigned long long)parentIdentity.st_dev), @"parentInode":@((unsigned long long)parentIdentity.st_ino), @"device":@((unsigned long long)st.st_dev), @"inode":@((unsigned long long)st.st_ino), @"hasJournal":@(SafeJournal(child)) }];
  close(child);
 }
 closedir(directory); close(parent);
 if (!ok) { if (error) *error = Failure(); return nil; }
 [rows sortUsingComparator:^NSComparisonResult(NSDictionary* a, NSDictionary* b) { return [a[@"relative"] compare:b[@"relative"]]; }];
 return rows;
}

BOOL KestrelPreparedCoreProfileIsCurrent(NSString* root, NSDictionary* row, NSString* active, NSString* previous) {
 if (![row isKindOfClass:NSDictionary.class] || !ValidRelative(active) || !ValidRelative(previous)) return NO;
 NSString* relative = row[@"relative"], *path = row[@"path"];
 if (!SafeText(path) || !ValidRelative(relative) || !relative.length || !SafeText(root) || ![path isEqualToString:[root stringByAppendingPathComponent:relative]] || [relative isEqualToString:active] || [relative isEqualToString:previous]) return NO;
 for (NSString* key in @[@"rootDevice", @"rootInode", @"parentDevice", @"parentInode", @"device", @"inode"])
  if (![row[key] isKindOfClass:NSNumber.class]) return NO;
 int rootfd = OpenRoot(root); if (rootfd < 0) return NO;
 struct stat rootStat{}; if (fstat(rootfd, &rootStat) || !PrivateDirectory(rootStat)) { close(rootfd); return NO; }
 int parent = OpenPrivateAt(rootfd, "native-core-profiles"); close(rootfd); if (parent < 0) return NO;
 struct stat parentStat{}; if (fstat(parent, &parentStat) || !PrivateDirectory(parentStat)) { close(parent); return NO; }
 int child = OpenPrivateAt(parent, relative.lastPathComponent.fileSystemRepresentation); close(parent); if (child < 0) return NO;
 struct stat st{}; const bool current = !fstat(child, &st) && PrivateDirectory(st) && [row[@"rootDevice"] unsignedLongLongValue] == (unsigned long long)rootStat.st_dev && [row[@"rootInode"] unsignedLongLongValue] == (unsigned long long)rootStat.st_ino && [row[@"parentDevice"] unsignedLongLongValue] == (unsigned long long)parentStat.st_dev && [row[@"parentInode"] unsignedLongLongValue] == (unsigned long long)parentStat.st_ino && [row[@"device"] unsignedLongLongValue] == (unsigned long long)st.st_dev && [row[@"inode"] unsignedLongLongValue] == (unsigned long long)st.st_ino;
 close(child); return current;
}
