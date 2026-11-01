#import <Foundation/Foundation.h>
#include <cassert>
#include <vector>
#include "../src/native_external_url_queue.h"
#include "../src/native_external_url_validation.h"
int main() { @autoreleasepool {
  assert(IsAllowedKestrelExternalURL([NSURL URLWithString:@"https://example.com/path?q=1"]));
  assert(IsAllowedKestrelExternalURL([NSURL URLWithString:@"http://example.com/"]));
  for (NSString* value in @[@"file:///tmp/a", @"chrome://settings/", @"https://user:pass@example.com/", @"https://user@example.com/", @"https:///missing"]) assert(!IsAllowedKestrelExternalURL([NSURL URLWithString:value]));
  NSString* longURL = [@"https://example.com/" stringByPaddingToLength:8200 withString:@"a" startingAtIndex:0];
  assert(!IsAllowedKestrelExternalURL([NSURL URLWithString:longURL]));
  std::vector<std::string> sent;
  NativeExternalUrlQueue queue([&](const std::string& id, const std::string& url) { sent.push_back(id + ":" + url); return true; });
  assert(queue.Enqueue("one")); assert(queue.Enqueue("two")); assert(sent.empty());
  queue.SetReady(true); assert(sent.size() == 1); assert(!queue.Complete("wrong"));
  assert(queue.Complete("external-1")); assert(sent.size() == 2);
  queue.SetReady(false); assert(queue.uncertain());
  assert(queue.Enqueue("three")); queue.SetReady(true); assert(sent.size() == 3);
  assert(sent[2] == "external-3:three"); assert(queue.Complete("external-3"));
  bool canSend = false;
  int attempts = 0;
  NativeExternalUrlQueue retry([&](const std::string&, const std::string&) { ++attempts; return canSend; });
  assert(retry.Enqueue("unsent")); retry.SetReady(true); assert(attempts == 1);
  canSend = true; retry.SetReady(true); assert(attempts == 2);
  assert(retry.Complete("external-2")); retry.SetReady(true); assert(attempts == 2);
  queue.SetReady(false); for (int i = 0; i < 32; ++i) assert(queue.Enqueue("queued"));
  assert(!queue.Enqueue("overflow"));
} }
