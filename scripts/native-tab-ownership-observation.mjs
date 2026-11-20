const FAILURE_MESSAGE = "The initial user page must belong to a real Chrome tab in both query forms.";

/**
 * Wait for Chrome's two public tabs query forms to identify the same registered
 * page. Query functions are supplied by the caller so production can call the
 * real extension API and tests can model delayed native registration.
 */
export async function observeNativeTabOwnership({
	url,
	queryUnfiltered,
	queryFiltered,
	delay,
	attempts = 30,
	intervalMs = 100,
}) {
	if (
		typeof url !== "string" ||
		typeof queryUnfiltered !== "function" ||
		typeof queryFiltered !== "function" ||
		typeof delay !== "function" ||
		!Number.isInteger(attempts) || attempts < 1 ||
		!Number.isFinite(intervalMs) || intervalMs < 0
	) {
		throw new TypeError("Invalid native tab ownership observation options.");
	}

	for (let attempt = 0; attempt < attempts; attempt++) {
		const [allTabs, filteredTabs] = await Promise.all([
			queryUnfiltered(),
			queryFiltered(url),
		]);
		const filtered = Array.isArray(filteredTabs)
			? filteredTabs.find((tab) => tab?.url === url && Number.isInteger(tab.id) && Number.isInteger(tab.windowId))
			: undefined;
		const unfiltered = filtered && Array.isArray(allTabs)
			? allTabs.find((tab) =>
				tab?.url === url &&
				tab.id === filtered.id &&
				tab.windowId === filtered.windowId &&
				Number.isInteger(tab.id) &&
				Number.isInteger(tab.windowId))
			: undefined;

		if (filtered && unfiltered) {
			return { tab: filtered, attempts: attempt + 1 };
		}
		if (attempt + 1 < attempts) await delay(intervalMs);
	}

	const error = new Error(FAILURE_MESSAGE);
	error.code = "NATIVE_TAB_OWNERSHIP_UNCONFIRMED";
	throw error;
}
