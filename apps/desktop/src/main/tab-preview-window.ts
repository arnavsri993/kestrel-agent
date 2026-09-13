import { BrowserWindow, screen, type Rectangle } from "electron";
import type { UserBrowserTab } from "@kestrel/shared-types";

const previews = new WeakMap<BrowserWindow, { window: BrowserWindow; timer: ReturnType<typeof setInterval> }>();
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const signals = [
 ["microphone", "Using microphone", "M9 5a3 3 0 016 0v7a3 3 0 01-6 0z M5 10v2a7 7 0 0014 0v-2 M12 19v3 M8 22h8"],
 ["camera", "Using camera", "M3 6h12v12H3z M15 10l6-4v12l-6-4"],
 ["screen", "Sharing screen", "M3 4h18v13H3z M8 21h8 M12 17v4"],
 ["location", "Using location", "M12 22s8-9 8-14A8 8 0 004 8c0 5 8 14 8 14z M12 5a3 3 0 100 6 3 3 0 000-6"],
 ["playing", "Playing media", "M8 4l12 8-12 8z"],
 ["downloading", "Downloading", "M12 3v12 M7 10l5 5 5-5 M4 18v3h16v-3"],
 ["busy", "Work in progress", "M8 3v4 M16 3v4 M4 7h16v13H4z M8 12h8 M8 16h5"],
 ["dirty", "Unsaved edits", "M4 20l4-1L20 7l-3-3L5 16z"],
] as const;

export function tabPreviewHtml(tab: UserBrowserTab): string {
 const icons = signals.filter(([key]) => tab.activity?.[key]).map(([, label, path]) => `<span tabindex="0" aria-label="${label}" data-label="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></span>`).join("");
 const image = tab.preview?.image;
 const safeImage = image && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image);
 const memory = tab.discarded && tab.estimatedSavedMemoryBytes ? `<div class="memory">≈ ${Math.max(1, Math.round(tab.estimatedSavedMemoryBytes / 1048576))} MB saved <small>estimated</small></div>` : "";
 let host = ""; try { host = new URL(tab.url).hostname; } catch { /* Internal tab. */ }
 return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
 *{box-sizing:border-box}body{margin:0;padding:8px;color:#f6f6f8;font:12px -apple-system,BlinkMacSystemFont,sans-serif;background:transparent}article{overflow:hidden;border-radius:16px;border:1px solid #ffffff32;background:linear-gradient(140deg,#33363cf7,#202227fa);box-shadow:0 5px 18px #0005}img,.empty{width:100%;height:170px;object-fit:cover;object-position:top;display:block;background:#30333a}.empty{display:grid;place-content:center;color:#abaeb6}section{padding:12px 14px}strong{font-size:13px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}small{color:#b2b4bb;font-size:11px}.host{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.signals{display:flex;gap:14px;margin-top:12px;padding-bottom:24px}.signals:empty{display:none}span[data-label]{position:relative;color:#bfe4d6;outline-offset:3px}svg{width:17px;height:17px;display:block}span[data-label]:hover:after,span[data-label]:focus:after{content:attr(data-label);position:absolute;top:23px;left:0;white-space:nowrap;color:white;background:#101216;border:1px solid #ffffff28;border-radius:5px;padding:4px 6px;font-size:10px;z-index:2}.signals span:nth-child(n+5):after{left:auto;right:0}.memory{border-top:1px solid #ffffff16;padding-top:9px;margin-top:8px;color:#ccd7cc;font-size:11px}.memory small{float:right}@media(prefers-color-scheme:light){article{background:linear-gradient(140deg,#fffffff5,#e9edf3f7);color:#24262c}.host,small{color:#666a73}.signals span{color:#28755e}.memory{color:#45634b;border-color:#0001}}
 </style></head><body><article>${safeImage ? `<img src="${image}" alt="Last view of this tab">` : '<div class="empty">No snapshot yet</div>'}<section><strong>${escape(tab.title)}</strong><small class="host">${escape(host)}${tab.discarded ? " · Sleeping" : ""}</small><div class="signals">${icons}</div>${memory}</section></article></body></html>`;
}

export function updateTabPreview(owner: BrowserWindow, tab?: UserBrowserTab, anchor?: Rectangle): void {
 const previous = previews.get(owner);
 if (previous) { clearInterval(previous.timer); if (!previous.window.isDestroyed()) previous.window.close(); previews.delete(owner); }
 if (!tab || !anchor || owner.isDestroyed() || !owner.isFocused()) return;
 const content = owner.getContentBounds();
 const origin = { x: content.x + anchor.x, y: content.y + anchor.y };
 const area = screen.getDisplayNearestPoint(origin).workArea;
 const width = 306;
 const height = 278 + (Object.values(tab.activity ?? {}).some(Boolean) ? 40 : 0) + (tab.discarded && tab.estimatedSavedMemoryBytes ? 30 : 0);
 const bounds = { x: Math.max(area.x, Math.min(origin.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(origin.y + anchor.height + 5, area.y + area.height - height)), width, height };
 const popup = new BrowserWindow({ ...bounds, parent: owner, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
 popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
 popup.webContents.on("will-navigate", (event) => event.preventDefault());
 popup.once("ready-to-show", () => { if (!popup.isDestroyed() && !owner.isDestroyed() && owner.isFocused()) popup.showInactive(); });
 void popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tabPreviewHtml(tab))}`).catch(() => { if (!popup.isDestroyed()) popup.close(); });
 const inside = (point: {x:number;y:number}, rect: Rectangle, margin = 8) => point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;
 let outsideSince = 0;
 const timer = setInterval(() => {
  if (popup.isDestroyed() || owner.isDestroyed() || !owner.isFocused()) { updateTabPreview(owner); return; }
  const cursor = screen.getCursorScreenPoint();
  if (inside(cursor, popup.getBounds()) || inside(cursor, { ...origin, width: anchor.width, height: anchor.height })) outsideSince = 0;
  else if (!outsideSince) outsideSince = Date.now();
  else if (Date.now() - outsideSince > 180) updateTabPreview(owner);
 }, 100);
 timer.unref();
 previews.set(owner, { window: popup, timer });
 popup.once("closed", () => { clearInterval(timer); if (previews.get(owner)?.window === popup) previews.delete(owner); });
}
