import type { SelectedAttachment } from "@kestrel/shared-types";

export const LARGE_PASTE_MIN_LENGTH = 8_000;

export async function createPastedTextAttachment(
	text: string,
): Promise<SelectedAttachment> {
	const response = await window.kestrel.request({
		type: "create-pasted-text-attachment",
		text,
	});
	if (!response.ok) throw new Error(response.error);
	if (!("selectedAttachments" in response) || !response.selectedAttachments[0])
		throw new Error("Kestrel could not create the pasted text attachment.");
	return response.selectedAttachments[0];
}

export function removePastedTextAttachment(attachment: SelectedAttachment): void {
	if (attachment.source !== "external" || !attachment.name.startsWith("pasted-text-"))
		return;
	void window.kestrel
		.request({ type: "remove-pasted-text-attachment", path: attachment.path })
		.catch(() => undefined);
}
