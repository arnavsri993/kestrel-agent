import { contextBridge, ipcRenderer } from "electron";
import {
  AgentStreamEventSchema,
  KestrelDeepLinkSchema,
  LocalRuntimeProgressSchema,
  PetActivityStateSchema,
  PetStatusSchema,
  RendererRequestSchema,
  RuntimeEventSchema,
  type RendererBridge,
  WorkspaceSnapshotSchema,
} from "@kestrel/shared-types";

const bridge: RendererBridge = {
  request: (request) =>
    ipcRenderer.invoke("kestrel:request", RendererRequestSchema.parse(request)),
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

contextBridge.exposeInMainWorld("kestrel", bridge);
