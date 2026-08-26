import {
	AgentStreamEventSchema,
	ExternalIntakeSchema,
	KestrelDeepLinkSchema,
	LocalRuntimeProgressSchema,
	PasswordPromptSchema,
	PetActivityStateSchema,
	PetStatusSchema,
	type RendererBridge,
	RendererRequestSchema,
	RuntimeEventSchema,
	UserBrowserCommandSchema,
	UserBrowserEventSchema,
	WorkspaceSnapshotSchema,
} from "@kestrel/shared-types";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { installFileDragBridge } from "./file-drag";

const bridge: RendererBridge = {
	request: (request) =>
		ipcRenderer.invoke("kestrel:request", RendererRequestSchema.parse(request)),
	getPathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file as File);
		} catch {
			return "";
		}
	},
	onBrowserEvent(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
			callback(UserBrowserEventSchema.parse(value));
		ipcRenderer.on("kestrel:browser-event", listener);
		return () => ipcRenderer.off("kestrel:browser-event", listener);
	},
	onPasswordPrompt(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
			callback(value === null ? null : PasswordPromptSchema.parse(value));
		ipcRenderer.on("kestrel:password-prompt", listener);
		return () => ipcRenderer.off("kestrel:password-prompt", listener);
	},
	onBrowserCommand(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
			callback(UserBrowserCommandSchema.parse(value));
		ipcRenderer.on("kestrel:browser-command", listener);
		return () => ipcRenderer.off("kestrel:browser-command", listener);
	},
	onDeepLink(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
			callback(KestrelDeepLinkSchema.parse(value));
		ipcRenderer.on("kestrel:deep-link", listener);
		ipcRenderer.send("kestrel:deep-link-ready");
		return () => {
			ipcRenderer.off("kestrel:deep-link", listener);
			ipcRenderer.send("kestrel:deep-link-not-ready");
		};
	},
	onExternalIntake(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
			callback(ExternalIntakeSchema.parse(value));
		ipcRenderer.on("kestrel:external-intake", listener);
		ipcRenderer.send("kestrel:external-intake-ready");
		return () => ipcRenderer.off("kestrel:external-intake", listener);
	},
	onFileDrag(callback) {
		const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const active = (value as { active?: unknown }).active;
			if (typeof active === "boolean") callback({ active });
		};
		ipcRenderer.on("kestrel:file-drag", listener);
		return () => ipcRenderer.off("kestrel:file-drag", listener);
	},
	onSnapshot(callback) {
		const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) =>
			callback(WorkspaceSnapshotSchema.parse(snapshot));
		ipcRenderer.on("kestrel:snapshot", listener);
		return () => ipcRenderer.off("kestrel:snapshot", listener);
	},
	onPetStatus(callback) {
		const listener = (_event: Electron.IpcRendererEvent, status: unknown) =>
			callback(PetStatusSchema.parse(status));
		ipcRenderer.on("kestrel:pet-status", listener);
		return () => ipcRenderer.off("kestrel:pet-status", listener);
	},
	onPetActivity(callback) {
		const listener = (_event: Electron.IpcRendererEvent, activity: unknown) =>
			callback(PetActivityStateSchema.parse(activity));
		ipcRenderer.on("kestrel:pet-activity", listener);
		return () => ipcRenderer.off("kestrel:pet-activity", listener);
	},
	onRuntimeEvent(callback) {
		const listener = (_event: Electron.IpcRendererEvent, event: unknown) =>
			callback(RuntimeEventSchema.parse(event));
		ipcRenderer.on("kestrel:runtime-event", listener);
		return () => ipcRenderer.off("kestrel:runtime-event", listener);
	},
	onAgentStream(callback) {
		const listener = (_event: Electron.IpcRendererEvent, event: unknown) =>
			callback(AgentStreamEventSchema.parse(event));
		ipcRenderer.on("kestrel:agent-stream", listener);
		return () => ipcRenderer.off("kestrel:agent-stream", listener);
	},
	onLocalRuntimeProgress(callback) {
		const listener = (_event: Electron.IpcRendererEvent, progress: unknown) =>
			callback(LocalRuntimeProgressSchema.parse(progress));
		ipcRenderer.on("kestrel:local-runtime-progress", listener);
		return () => ipcRenderer.off("kestrel:local-runtime-progress", listener);
	},
};

installFileDragBridge({
	getPathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file as File);
		} catch {
			return "";
		}
	},
	onDrag: (active) => ipcRenderer.send("kestrel:user-browser-file-drag", { active }),
	onDrop: (paths) => ipcRenderer.send("kestrel:user-browser-file-drop", { paths }),
});

contextBridge.exposeInMainWorld("kestrel", bridge);
