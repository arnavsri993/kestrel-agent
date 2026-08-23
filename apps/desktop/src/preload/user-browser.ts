import { ipcRenderer, webUtils } from "electron";

// Keep this bridge local to the entry. Electron's sandboxed preload loader
// cannot resolve Rollup's relative shared chunks, so both preload outputs must
// remain completely standalone.
function hasFiles(event: DragEvent): boolean {
	return Boolean(
		event.isTrusted &&
			event.dataTransfer &&
			([...event.dataTransfer.types].includes("Files") ||
				event.dataTransfer.files.length > 0),
	);
}

function installFileDragBridge(): void {
	let fileDragDepth = 0;

	function notifyDrag(active: boolean): void {
		ipcRenderer.send("kestrel:user-browser-file-drag", { active });
	}

	function pathsFrom(event: DragEvent): string[] {
		const paths = [...(event.dataTransfer?.files ?? [])].flatMap((file) => {
			try {
				const path = webUtils.getPathForFile(file);
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
			if (fileDragDepth === 1) notifyDrag(true);
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
			notifyDrag(true);
		},
		{ capture: true },
	);

	window.addEventListener(
		"dragleave",
		(event) => {
			if (!hasFiles(event)) return;
			fileDragDepth = Math.max(0, fileDragDepth - 1);
			if (fileDragDepth === 0) notifyDrag(false);
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
			notifyDrag(false);
			ipcRenderer.send("kestrel:user-browser-file-drop", {
				paths: pathsFrom(event),
			});
		},
		{ capture: true },
	);
}

installFileDragBridge();
