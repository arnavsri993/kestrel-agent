import type { UserBrowserSettings } from "@kestrel/shared-types";
import type { FrequentBrowserSite } from "./new-tab";

export function normalizeShortcutUrl(value: string): string | null {
 try {
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname ? url.href : null;
 } catch { return null; }
}

export function homeShortcuts(pinned: NonNullable<UserBrowserSettings["newTabShortcuts"]>, frequent: FrequentBrowserSite[]) {
 const origins = new Set(pinned.map((item) => new URL(item.url).origin));
 return [
  ...pinned.map((item) => ({ ...item, pinned: true, faviconDataUrl: frequent.find((site) => site.origin === new URL(item.url).origin)?.faviconDataUrl })),
  ...frequent.filter((item) => !origins.has(item.origin)).map((item) => ({ ...item, title: item.hostname.replace(/^www\./, ""), pinned: false })),
 ].slice(0, Math.max(8, pinned.length));
}
