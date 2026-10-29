#ifndef KESTREL_CHROMIUM_DESKTOP_H_
#define KESTREL_CHROMIUM_DESKTOP_H_
int RunKestrelChromiumDesktop(int argc, char** argv, bool default_profile = false);
bool CloseKestrelChromiumDesktop();
bool ReopenKestrelChromiumDesktop();
#endif
