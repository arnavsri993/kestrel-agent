#ifndef KESTREL_CHROMIUM_DESKTOP_H_
#define KESTREL_CHROMIUM_DESKTOP_H_
#ifdef __OBJC__
@class NSURL;
bool EnqueueKestrelExternalURL(NSURL* url);
#endif
int RunKestrelChromiumDesktop(int argc, char** argv, bool default_profile = false);
bool CloseKestrelChromiumDesktop();
bool ReopenKestrelChromiumDesktop();
#endif
