import type { UserBrowserCommand } from "@kestrel/shared-types";
import type { MenuItemConstructorOptions } from "electron";

export interface ApplicationMenuActions {
	command(command: UserBrowserCommand): void;
	newTab(): void;
	closeTab(): void;
	reload(): void;
}

export function applicationMenuTemplate(
	actions: ApplicationMenuActions,
	options: { platform: string; productName: string; packaged: boolean },
): MenuItemConstructorOptions[] {
	const command = (value: UserBrowserCommand) => () => actions.command(value);
	const settings: MenuItemConstructorOptions = { id: "kestrel-settings", label: "Settings…", accelerator: "CommandOrControl+,", click: command("open-settings") };
	return [
		...(options.platform === "darwin" ? [{ label: options.productName, submenu: [
			{ role: "about" }, { type: "separator" }, settings,
			{ type: "separator" }, { role: "services" }, { type: "separator" },
			{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
			{ type: "separator" }, { role: "quit" },
		] } as MenuItemConstructorOptions] : []),
		{ label: "File", submenu: [
			{ id: "kestrel-new-tab", label: "New Tab", accelerator: "CommandOrControl+T", click: actions.newTab },
			{ label: "New Task", accelerator: "CommandOrControl+N", click: command("new-agent") },
			{ label: "Reopen Closed Tab", accelerator: "CommandOrControl+Shift+T", click: command("reopen-closed-tab") },
			{ type: "separator" },
			{ label: "Close Tab", accelerator: "CommandOrControl+W", click: actions.closeTab },
			{ role: "close", label: "Close Window", accelerator: "CommandOrControl+Shift+W" },
			...(options.platform === "darwin" ? [] : [{ type: "separator" }, settings, { role: "quit" }] as MenuItemConstructorOptions[]),
		] },
		{ role: "editMenu", submenu: [
			{ role: "undo" }, { role: "redo" }, { type: "separator" },
			{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" },
			{ type: "separator" }, { label: "Find in Page…", accelerator: "CommandOrControl+F", click: command("find-in-page") },
		] },
		{ label: "View", submenu: [
			{ label: "Focus Address Bar", accelerator: "CommandOrControl+L", click: command("focus-address") },
			{ label: "Search Kestrel…", accelerator: "CommandOrControl+K", click: command("open-commands") },
			{ label: "Toggle Sidebar", accelerator: "CommandOrControl+Shift+S", click: command("toggle-sidebar") },
			{ type: "separator" }, { label: "Reload Page", accelerator: "CommandOrControl+R", click: actions.reload },
			{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
			{ type: "separator" }, { role: "togglefullscreen" },
			...(!options.packaged ? [{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[] : []),
		] },
		{ label: "History", submenu: [
			{ label: "History", accelerator: options.platform === "darwin" ? "CommandOrControl+Y" : "CommandOrControl+H", click: command("open-history") },
			{ label: "Downloads", accelerator: "CommandOrControl+J", click: command("open-downloads") },
			{ label: "Bookmarks", click: command("open-bookmarks") },
		] },
		{ role: "windowMenu" },
		{ role: "help", submenu: [{ label: "Keyboard Shortcuts", accelerator: "CommandOrControl+/", click: command("show-shortcuts") }] },
	];
}
