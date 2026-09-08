export interface FileDropGuardTarget {
	addEventListener(
		type: string,
		listener: (event: DragEvent) => void,
		options?: AddEventListenerOptions,
	): void;
}

function hasFiles(event: DragEvent): boolean {
	return Boolean(
		event.isTrusted &&
		event.dataTransfer &&
		([...event.dataTransfer.types].includes("Files") ||
			event.dataTransfer.files.length > 0),
	);
}

/**
 * Keep files dropped on Kestrel's chrome from becoming navigations or file
 * tabs. The embedded website has its own WebContentsView and does not install
 * this guard, so its upload inputs still receive native file drops.
 */
export function installFileDropGuard(target: FileDropGuardTarget): void {
	const block = (event: DragEvent) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
	};

	target.addEventListener("dragenter", block, { capture: true });
	target.addEventListener("dragover", block, { capture: true });
	target.addEventListener("drop", block, { capture: true });
}
