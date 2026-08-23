import { ipcRenderer, webUtils } from "electron";
import { installFileDragBridge } from "./file-drag";

installFileDragBridge({
	getPathForFile: (file) => webUtils.getPathForFile(file as File),
	onDrag: (active) => ipcRenderer.send("kestrel:user-browser-file-drag", { active }),
	onDrop: (paths) => ipcRenderer.send("kestrel:user-browser-file-drop", { paths }),
});
