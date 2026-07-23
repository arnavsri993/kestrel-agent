const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";

export const SITE_BASE_PATH =
  configuredBasePath &&
  configuredBasePath.startsWith("/") &&
  !configuredBasePath.endsWith("/")
    ? configuredBasePath
    : "";

export function sitePath(path: `/${string}`): string {
  return `${SITE_BASE_PATH}${path}`;
}
