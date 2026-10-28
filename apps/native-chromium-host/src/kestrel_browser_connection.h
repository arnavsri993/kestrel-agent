#ifndef KESTREL_BROWSER_CONNECTION_H_
#define KESTREL_BROWSER_CONNECTION_H_

inline NSMutableArray<NSTask*>* KestrelBrowserChildren() {
  static NSMutableArray<NSTask*>* children = nil;
  if (!children) children = [NSMutableArray array];
  return children;
}

// CEF callbacks have drained at this point. Keep the parent alive until all
// owned children exit, including a suspended child that cannot consume EOF.
inline void FinishBrowserChildren() {
  for (NSTask* task in KestrelBrowserChildren()) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    bool terminated = false;
    while (task.isRunning && std::chrono::steady_clock::now() < deadline) {
      const auto left = deadline - std::chrono::steady_clock::now();
      if (!terminated && left < std::chrono::seconds(3)) {
        [task terminate];
        terminated = true;
      }
      if (left < std::chrono::seconds(1)) kill(task.processIdentifier, SIGKILL);
      usleep(20000);
    }
    if (task.isRunning) kill(task.processIdentifier, SIGKILL);
  }
  [KestrelBrowserChildren() removeAllObjects];
}

// Private inherited pipes, never a listening port or an extension-accessible
// endpoint. The child receives only its disposable HOME and explicit flags.
@interface KestrelBrowserConnection : NSObject
@property(nonatomic, strong) NSTask* task;
@property(nonatomic, strong) NSFileHandle* input;
@property(nonatomic, strong) NSFileHandle* output;
@property(nonatomic, strong) NSMutableData* buffer;
@property(nonatomic, strong) dispatch_queue_t writes;
@property(atomic, copy) void (^lineHandler)(NSString*);
@property(atomic, copy) void (^exitHandler)(void);
- (BOOL)start:(NSString*)profile;
- (void)send:(NSString*)line;
- (void)stop;
@end

@implementation KestrelBrowserConnection
- (BOOL)start:(NSString*)profile {
  self.buffer = [NSMutableData data];
  self.writes = dispatch_queue_create("com.kestrel.native-browser-writes", DISPATCH_QUEUE_SERIAL);
  self.task = [[NSTask alloc] init];
  self.task.executableURL = [NSURL fileURLWithPath:NSBundle.mainBundle.executablePath];
  NSMutableArray* arguments = [NSMutableArray arrayWithArray:@[
    @"--kestrel-extension-workbench", @"--kestrel-browser-child",
    @"--kestrel-cache-path", profile
  ]];
  auto command = CefCommandLine::GetGlobalCommandLine();
  // Explicit development probes only. No other parent flags or environment
  // are inherited; in particular the child never receives shell/Core flags.
  if (command && command->HasSwitch("remote-debugging-port"))
    [arguments addObject:@"--remote-debugging-port=0"];
  if (command && command->HasSwitch("load-extension"))
    [arguments addObject:[NSString stringWithFormat:@"--load-extension=%s",
      command->GetSwitchValue("load-extension").ToString().c_str()]];
  self.task.arguments = arguments;
  self.task.environment = @{ @"HOME": profile, @"LANG": @"en_US.UTF-8",
                            @"PATH": @"/usr/bin:/bin", @"TMPDIR": NSTemporaryDirectory() };
  NSPipe* input = [NSPipe pipe];
  NSPipe* output = [NSPipe pipe];
  self.input = input.fileHandleForWriting;
  self.output = output.fileHandleForReading;
  self.task.standardInput = input;
  self.task.standardOutput = output;
  self.task.standardError = NSFileHandle.fileHandleWithStandardError;
  __weak KestrelBrowserConnection* weak = self;
  self.output.readabilityHandler = ^(NSFileHandle* handle) {
    KestrelBrowserConnection* connection = weak;
    if (!connection) return;
    NSData* data = handle.availableData;
    if (!data.length) { handle.readabilityHandler = nil; return; }
    if (connection.buffer.length + data.length > 1024 * 1024) {
      void (^failure)(void) = connection.exitHandler;
      [connection stop];
      if (failure) failure();
      return;
    }
    [connection.buffer appendData:data];
    const uint8_t newline = '\n';
    NSData* separator = [NSData dataWithBytes:&newline length:1];
    while (true) {
      NSRange range = [connection.buffer rangeOfData:separator options:0
                                      range:NSMakeRange(0, connection.buffer.length)];
      if (range.location == NSNotFound) break;
      NSData* bytes = [connection.buffer subdataWithRange:NSMakeRange(0, range.location)];
      [connection.buffer replaceBytesInRange:NSMakeRange(0, range.location + 1)
                                  withBytes:nullptr length:0];
      NSString* line = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
      void (^handler)(NSString*) = connection.lineHandler;
      if ([line hasPrefix:@"KESTREL_BROWSER_IPC "] && handler)
        handler([line substringFromIndex:20]);
    }
  };
  self.task.terminationHandler = ^(NSTask*) {
    KestrelBrowserConnection* connection = weak;
    connection.output.readabilityHandler = nil;
    void (^handler)(void) = connection.exitHandler;
    if (handler) handler();
  };
  NSError* error = nil;
  const BOOL launched = [self.task launchAndReturnError:&error];
  if (launched) {
    NSIndexSet* exited = [KestrelBrowserChildren() indexesOfObjectsPassingTest:
      ^BOOL(NSTask* task, NSUInteger, BOOL*) { return !task.isRunning; }];
    [KestrelBrowserChildren() removeObjectsAtIndexes:exited];
    [KestrelBrowserChildren() addObject:self.task];
  }
  return launched;
}
- (void)send:(NSString*)line {
  if (!self.task.isRunning || line.length > 16384) return;
  NSFileHandle* input = self.input;
  dispatch_async(self.writes, ^{
    @try { [input writeData:[[line stringByAppendingString:@"\n"]
                                 dataUsingEncoding:NSUTF8StringEncoding]]; }
    @catch (NSException*) { }
  });
}
- (void)stop {
  self.output.readabilityHandler = nil;
  self.lineHandler = nil;
  self.exitHandler = nil;
  self.task.terminationHandler = nil;
  NSTask* task = self.task;
  NSFileHandle* input = self.input;
  // Closing stdin invokes the child's graceful CloseAll; a stuck child gets
  // bounded termination. All blocking I/O stays off CEF's UI thread.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try { [input closeFile]; } @catch (NSException*) { }
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    if (task.isRunning) [task terminate];
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    if (task.isRunning) kill(task.processIdentifier, SIGKILL);
  });
}
@end
#endif
