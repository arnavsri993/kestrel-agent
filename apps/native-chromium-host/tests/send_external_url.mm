#import <Foundation/Foundation.h>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <iostream>

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc != 3) { std::cerr << "Expected a process ID and HTTP(S) URL." << std::endl; return 2; }
    char* end = nullptr;
    errno = 0;
    long value = strtol(argv[1], &end, 10);
    if (errno || !end || *end || value <= 0 || value > INT_MAX) return 2;
    NSString* text = [NSString stringWithUTF8String:argv[2]];
    if (!text || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 8192 ||
        [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound ||
        [text rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location != NSNotFound) return 2;
    NSURLComponents* url = [NSURLComponents componentsWithString:text];
    NSString* scheme = url.scheme.lowercaseString;
    if (!url || !([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) ||
        !url.host.length || url.user != nil || url.password != nil) return 2;
    NSAppleEventDescriptor* target = [NSAppleEventDescriptor descriptorWithProcessIdentifier:(pid_t)value];
    NSAppleEventDescriptor* event = [NSAppleEventDescriptor appleEventWithEventClass:'GURL'
        eventID:'GURL' targetDescriptor:target returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    [event setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:text] forKeyword:keyDirectObject];
    NSError* error = nil;
    [event sendEventWithOptions:NSAppleEventSendNoReply timeout:5 error:&error];
    if (error) { std::cerr << "Could not send the URL event (" << error.code << ")." << std::endl; return 1; }
    return 0;
  }
}
