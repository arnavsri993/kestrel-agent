import { useRef, useState } from "react";
import type { UserBrowserSettings } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import { CUSTOM_BACKGROUND_MAX_BYTES, NEW_TAB_BACKGROUND_OPTIONS, SUPPORTED_BACKGROUND_MIME_TYPES, readBackgroundFile, type FrequentBrowserSite } from "./new-tab";
import { homeShortcuts, normalizeShortcutUrl } from "./home-shortcuts";

type Props = {
 frequent: FrequentBrowserSite[];
 showFrequent?: boolean;
 shortcuts: NonNullable<UserBrowserSettings["newTabShortcuts"]>;
 background: UserBrowserSettings["newTabBackground"];
 onUpdate(next: Partial<UserBrowserSettings>): Promise<unknown>;
 onNavigate(url: string): void;
 onEditWidgets(): void;
};

export function NewTabPersonalization({ frequent, showFrequent = true, shortcuts, background, onUpdate, onNavigate, onEditWidgets }: Props) {
 const panel = useRef<HTMLDetailsElement>(null);
 const [adding, setAdding] = useState(false);
 const [title, setTitle] = useState("");
 const [url, setUrl] = useState("");
 const [error, setError] = useState("");
 const [saving, setSaving] = useState(false);
 const links = homeShortcuts(shortcuts, frequent, showFrequent);
 async function save(next: Partial<UserBrowserSettings>) {
  setSaving(true); setError("");
  try { await onUpdate(next); return true; }
  catch (error) { setError(error instanceof Error ? error.message : "Could not save changes. Try again."); return false; }
  finally { setSaving(false); }
 }
 return <>
  <details className="home-personalize" ref={panel} onKeyDown={(event) => {
   if (event.key === "Escape") { event.preventDefault(); panel.current!.open = false; panel.current?.querySelector("summary")?.focus(); }
  }}>
   <summary aria-label="Customize New Tab"><Icon name="sliders" /><span>Customize</span></summary>
   <div className="home-personalize-panel">
    <strong>Make this space yours</strong>
    <label>Wallpaper<select aria-label="Wallpaper" value={background} disabled={saving} onChange={(event) => void save({ newTabBackground: event.target.value as Props["background"] })}>
     {NEW_TAB_BACKGROUND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
     {background === "custom" && <option value="custom">Your photo</option>}
    </select></label>
    <label className="home-upload">Choose a photo<input type="file" accept={SUPPORTED_BACKGROUND_MIME_TYPES.join(",")} disabled={saving} onChange={async (event) => {
     const file = event.target.files?.[0]; event.target.value = "";
     if (!file) return;
     if (file.size > CUSTOM_BACKGROUND_MAX_BYTES || !SUPPORTED_BACKGROUND_MIME_TYPES.some((type) => type === file.type)) { setError("Choose an image smaller than 5 MB."); return; }
     try { await save({ newTabBackground: "custom", newTabBackgroundCustomDataUrl: await readBackgroundFile(file) }); }
     catch { setError("That photo could not be read."); }
    }} /></label>
    <button type="button" onClick={() => { panel.current!.open = false; onEditWidgets(); }}>Arrange widgets<Icon name="chevron" /></button>
    <button type="button" onClick={() => { setAdding(true); panel.current!.open = false; }}>Add a shortcut<Icon name="plus" /></button>
   </div>
  </details>
  <nav className={`home-site-shortcuts${links.length === 0 ? " is-empty" : ""}`} aria-label="Site shortcuts">
   {links.map((link) => <div className="home-site-shortcut" key={link.url}>
    <button type="button" title={link.title + " · " + link.url} onClick={() => onNavigate(link.url)}>
     <span className="home-site-glyph">{link.faviconDataUrl ? <img src={link.faviconDataUrl} alt="" /> : link.title.slice(0, 1).toUpperCase()}</span>
     <span className="home-site-label">{link.title}</span>
    </button>
    {link.pinned && <button type="button" className="home-shortcut-remove" aria-label={`Remove ${link.title} shortcut`} disabled={saving} onClick={() => void save({ newTabShortcuts: shortcuts.filter((item) => item.url !== link.url) })}><Icon name="close" /></button>}
   </div>)}
   {shortcuts.length < 12 && <div className="home-site-shortcut"><button type="button" onClick={() => setAdding((value) => !value)} aria-expanded={adding}><span className="home-site-glyph"><Icon name="plus" /></span><span className="home-site-label">Add shortcut</span></button></div>}
  </nav>
  {adding && <form className="home-shortcut-form" onSubmit={async (event) => {
   event.preventDefault();
   const normalized = normalizeShortcutUrl(url);
   if (!normalized) { setError("Enter a website address without a username or password."); return; }
   if (await save({ newTabShortcuts: [...shortcuts.filter((item) => item.url !== normalized), { title: title.trim() || new URL(normalized).hostname, url: normalized }].slice(0, 12) })) { setAdding(false); setTitle(""); setUrl(""); }
  }}>
   <label>Name<input autoFocus value={title} maxLength={80} placeholder="My website" onChange={(event) => setTitle(event.target.value)} /></label>
   <label>Website<input value={url} maxLength={8192} required placeholder="example.com" onChange={(event) => setUrl(event.target.value)} /></label>
   <button type="submit" disabled={saving}>{saving ? "Saving…" : "Add"}</button>
   <button type="button" onClick={() => { setAdding(false); setError(""); }}>Cancel</button>
  </form>}
  {error && <p className="home-personalize-error" role="alert">{error}</p>}
 </>;
}
