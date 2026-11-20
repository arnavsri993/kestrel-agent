const HOST_TYPES = new Set(["computer-use-status", "computer-use-update", "computer-use-open-settings"]);

export async function dispatchNativeComputerHostRequest(manager, request) {
	if (!HOST_TYPES.has(request?.type)) return undefined;
	return manager.handleHostRequest(request);
}
