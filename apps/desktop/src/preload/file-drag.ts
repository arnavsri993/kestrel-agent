export interface FileDragBridgeOptions {
	getPathForFile(file: unknown): string;
	onDrag(active: boolean): void;
	onDrop(paths: string[]): void;
}

function hasFiles(event: DragEvent): boolean {
	return Boolean(
		event.isTrusted &&
		event.dataTransfer &&
		([...event.dataTransfer.types].includes("Files") ||
			event.dataTransfer.files.length > 0),
	);
}

export function installFileDragBridge({
	getPathForFile,
	onDrag,
	onDrop,
}: FileDragBridgeOptions): void {
	let fileDragDepth = 0;

	function pathsFrom(event: DragEvent): string[] {
		const paths = [...(event.dataTransfer?.files ?? [])].flatMap((file) => {
			try {
				const path = getPathForFile(file);
				return path ? [path] : [];
			} catch {
				return [];
			}
		});
		return [...new Set(paths)].slice(0, 8);
	}

	window.addEventListener(
		"dragenter",
		(event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			fileDragDepth += 1;
			if (fileDragDepth === 1) onDrag(true);
		},
		{ capture: true },
	);

	window.addEventListener(
		"dragover",
		(event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.dataTransfer!.dropEffect = "copy";
			if (fileDragDepth === 0) fileDragDepth = 1;
			onDrag(true);
		},
		{ capture: true },
	);

	window.addEventListener(
		"dragleave",
		(event) => {
			if (!hasFiles(event)) return;
			fileDragDepth = Math.max(0, fileDragDepth - 1);
			if (fileDragDepth === 0) onDrag(false);
		},
		{ capture: true },
	);

	window.addEventListener(
		"drop",
		(event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.stopPropagation();
			fileDragDepth = 0;
			onDrag(false);
			onDrop(pathsFrom(event));
		},
		{ capture: true },
	);
}
