#ifndef KESTREL_NATIVE_EXTERNAL_URL_VALIDATION_H_
#define KESTREL_NATIVE_EXTERNAL_URL_VALIDATION_H_
#import <Foundation/Foundation.h>

static inline bool IsAllowedKestrelExternalURL(NSURL* url) {
  if (![url isKindOfClass:NSURL.class]) return false;
  NSString* text = url.absoluteString;
  NSCharacterSet* rejected = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  if (!text || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 8192 ||
      [text rangeOfCharacterFromSet:rejected].location != NSNotFound ||
      [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return false;
  NSURLComponents* parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  NSString* scheme = parts.scheme.lowercaseString;
  return parts && ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) &&
      parts.host.length && parts.user == nil && parts.password == nil;
}
#endif
