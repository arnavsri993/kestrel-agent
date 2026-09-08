export const KESTREL_TAB_TRANSFER_MIME = "application/x-kestrel-tab";

export interface BrowserTabTransferPayload {
	tabId: string;
	transferToken: string;
}

const TAB_ID_PATTERN = /^tab-[a-f0-9-]{36}$/;
const TRANSFER_TOKEN_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serializeBrowserTabTransfer(
	payload: BrowserTabTransferPayload,
): string {
	return JSON.stringify(payload);
}

export function parseBrowserTabTransfer(
	value: string,
): BrowserTabTransferPayload | null {
	try {
		const payload = JSON.parse(value) as Partial<BrowserTabTransferPayload>;
		if (
			!payload ||
			typeof payload !== "object" ||
			typeof payload.tabId !== "string" ||
			!TAB_ID_PATTERN.test(payload.tabId) ||
			typeof payload.transferToken !== "string" ||
			!TRANSFER_TOKEN_PATTERN.test(payload.transferToken)
		)
			return null;
		return {
			tabId: payload.tabId,
			transferToken: payload.transferToken,
		};
	} catch {
		return null;
	}
}
