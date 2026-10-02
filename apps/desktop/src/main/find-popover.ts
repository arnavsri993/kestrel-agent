import { BrowserWindow, type Rectangle } from "electron";
import type { UserBrowserEvent } from "@kestrel/shared-types";
import type { UserBrowserService } from "./user-browser-service";

interface FindRecord {
	owner: BrowserWindow;
	window: BrowserWindow;
	service: UserBrowserService;
	tabId: string;
	url: string;
	anchor: Rectangle;
}
const records = new Map<BrowserWindow, FindRecord>();
const senders = new WeakMap<BrowserWindow, FindRecord>();
export function findPopoverForSender(sender: BrowserWindow) {
	return senders.get(sender);
}

function position(record: FindRecord) {
	const content = record.owner.getContentBounds();
	const zoom = record.owner.webContents.getZoomFactor();
	const anchor = record.anchor;
	const width = Math.max(240, Math.min(360, content.width - 16, anchor.width));
	record.window.setBounds({
		x: Math.round(
			content.x +
				Math.max(
					8,
					Math.min(
						content.width - width - 8,
						(anchor.x + anchor.width) * zoom - width - 8,
					),
				),
		),
		y: Math.round(content.y + anchor.y * zoom + 8),
		width,
		height: 48,
	});
}
export function updateFindPopoverAnchor(
	owner: BrowserWindow,
	bounds: Rectangle,
) {
	const record = records.get(owner);
	if (record) {
		record.anchor = bounds;
		position(record);
	}
}
export function forwardFindPopoverEvent(
	owner: BrowserWindow,
	event: UserBrowserEvent,
) {
	const record = records.get(owner);
	if (!record || record.window.isDestroyed()) return;
	if (event.type === "state") {
		const tab = event.state.tabs.find((tab) => tab.id === record.tabId);
		if (
			event.state.activeTabId !== record.tabId ||
			!tab ||
			tab.url !== record.url
		)
			record.window.close();
	} else if (
		event.type === "find-in-page" &&
		event.match.tabId === record.tabId
	) {
		record.window.webContents.send("kestrel:browser-event", event);
	}
}
export function openFindPopover(options: {
	owner: BrowserWindow;
	service: UserBrowserService;
	anchor: Rectangle;
	preload: string;
	renderer: string;
	developmentUrl?: string;
	protect: (contents: Electron.WebContents) => void;
}) {
	const { owner, service } = options;
	const state = service.getState();
	const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
	if (!tab) return;
	const existing = records.get(owner);
	if (existing && existing.tabId === tab.id && !existing.window.isDestroyed()) {
		existing.window.show();
		existing.window.focus();
		existing.window.webContents.send("kestrel:browser-command", "find-in-page");
		return;
	}
	existing?.window.close();
	const window = new BrowserWindow({
		parent: owner,
		modal: false,
		show: false,
		frame: false,
		transparent: true,
		width: 360,
		height: 48,
		resizable: false,
		minimizable: false,
		maximizable: false,
		skipTaskbar: true,
		hasShadow: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: options.preload,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: !options.developmentUrl,
			webSecurity: true,
			devTools: Boolean(options.developmentUrl),
		},
	});
	const record: FindRecord = {
		owner,
		window,
		service,
		tabId: tab.id,
		url: tab.url,
		anchor: options.anchor,
	};
	records.set(owner, record);
	senders.set(window, record);
	const reposition = () => position(record);
	owner.on("move", reposition);
	owner.on("resize", reposition);
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	options.protect(window.webContents);
	window.once("ready-to-show", () => {
		position(record);
		window.show();
		window.focus();
	});
	window.on("closed", () => {
		owner.removeListener("move", reposition);
		owner.removeListener("resize", reposition);
		senders.delete(window);
		if (records.get(owner) === record) records.delete(owner);
		if (!owner.isDestroyed()) {
			try {
				service.stopFindInPage(record.tabId);
			} catch {
				/* Tab may have closed. */
			}
			owner.focus();
		}
	});
	const query = { findPopover: "1", tabId: tab.id };
	if (options.developmentUrl) {
		const url = new URL(options.developmentUrl);
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value);
		void window.loadURL(url.toString()).catch(() => window.close());
	} else
		void window
			.loadFile(options.renderer, { query })
			.catch(() => window.close());
}
