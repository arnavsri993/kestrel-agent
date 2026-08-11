export function canShowMainWindow(
  appReady: boolean,
  coreStartupComplete: boolean,
): boolean {
  return appReady && coreStartupComplete;
}
