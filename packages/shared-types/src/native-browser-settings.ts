// These destinations are available only to the first-party Kestrel UI. Core
// browser tools continue to exclude every chrome:// page.
export const NATIVE_BROWSER_SETTINGS_URLS = [
	"chrome://settings/", "chrome://settings/onStartup",
	"chrome://settings/appearance", "chrome://settings/search",
	"chrome://settings/searchEngines", "chrome://settings/privacy",
	"chrome://settings/content", "chrome://settings/autofill",
	"chrome://password-manager/passwords", "chrome://settings/payments",
	"chrome://settings/addresses", "chrome://settings/performance",
	"chrome://settings/downloads", "chrome://settings/languages",
	"chrome://settings/accessibility", "chrome://settings/fonts",
	"chrome://settings/system", "chrome://settings/reset",
	"chrome://settings/clearBrowserData", "chrome://settings/importData",
	"chrome://extensions/", "chrome://downloads/", "chrome://history/",
	"chrome://bookmarks/",
] as const;

const destinations = new Set<string>(NATIVE_BROWSER_SETTINGS_URLS);
export function isNativeBrowserSettingsUrl(value: string): boolean {
	return destinations.has(value);
}
