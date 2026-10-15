import type { RendererTransport } from "@kestrel/shared-types";
import { ipcRenderer } from "electron";

/** Electron owns IPC; the portable bridge owns the renderer API. */
export const electronRendererTransport: RendererTransport = {
	request: (request) => ipcRenderer.invoke("kestrel:request", request),
	subscribe(channel, callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
		ipcRenderer.on(`kestrel:${channel}`, listener);
		return () => { ipcRenderer.off(`kestrel:${channel}`, listener); };
	},
	notify: (signal) => ipcRenderer.send(`kestrel:${signal}`),
};
