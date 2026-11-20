#ifndef KESTREL_NATIVE_RUN_LOOP_DISPATCH_H_
#define KESTREL_NATIVE_RUN_LOOP_DISPATCH_H_

#ifdef __OBJC__
typedef void (^KestrelNativeRunLoopBlock)(void);

// Schedule work on the main run loop in default, modal-panel or event-tracking
// modes. The block is delivered at most once, even if these modes switch.
void KestrelDispatchToMainRunLoop(KestrelNativeRunLoopBlock block);
#endif

#endif
