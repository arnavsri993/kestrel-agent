export function dispatchNativeComputerHostRequest(
	manager: { handleHostRequest(request: { type: string; enabled?: boolean | undefined; surface?: "screen-recording" | "accessibility" | undefined }): Promise<unknown> },
	request: { type: string; enabled?: boolean | undefined; surface?: "screen-recording" | "accessibility" | undefined },
): Promise<unknown> | undefined;
