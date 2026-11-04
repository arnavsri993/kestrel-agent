import { NativeBookmarkTransferSchema } from "../../../../packages/shared-types/src/contracts.ts";

const IDS = "kestrel.native.browser.bookmarkIds.v1";
const MODES = "kestrel.native.browser.bookmarkModes.v1";
const TTL = 120_000;
const text = (value, max, fallback) => {
  if (!value) return fallback;
  if (typeof value !== "string" || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Some bookmark labels cannot be preserved in this file. Use trimmed titles up to 500 characters and folder names up to 80 characters without control characters.");
  return value;
};
function url(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\//i.test(value)) return undefined;
  try { const parsed = new URL(value); return !parsed.username && !parsed.password && ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined; }
  catch { return undefined; }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const record = node => ({ id: node.id, parentId: node.parentId, title: node.title, url: node.url,
  dateAdded: node.dateAdded, folderType: node.folderType, unmodifiable: node.unmodifiable });
const canonicalJson = value => JSON.stringify(canonical(value));

// Plans live only in this browser worker, contain no persistent browser IDs in
// exported data, and are consumed before the first native mutation.
export function createNativeBookmarkTransfer({ chromeApi, invoke, stored, readBookmarks, presentation, savePresentation, response, emitState }) {
  let plan;
  async function snapshot(destinationFolderId) {
    await readBookmarks();
    const tree = await invoke(chromeApi.bookmarks, "getTree");
    const root = tree?.[0];
    if (!root || root.url || !Array.isArray(root.children)) throw new Error("Native bookmarks are unavailable.");
    const modes = await stored(MODES, {}), ids = await stored(IDS, {});
    if (!modes || typeof modes !== "object" || Array.isArray(modes) || Object.keys(modes).length > 4000) throw new Error("Bookmark presentation is unavailable.");
    const nodes = new Map(), witness = [];
    function walk(node, depth, locked) {
      if (nodes.size >= 10_000 || nodes.has(String(node.id))) throw new Error("Native bookmark tree cannot be transferred safely.");
      const entry = { node, depth, locked: locked || Boolean(node.unmodifiable) };
      nodes.set(String(node.id), entry);
      witness.push(record(node));
      for (const child of node.children ?? []) walk(child, depth + 1, entry.locked);
    }
    walk(root, 0, false);
    let destination = root.children.find(node => !node.url && !node.unmodifiable && node.folderType === "bookmarks-bar")
      ?? root.children.find(node => !node.url && !node.unmodifiable);
    if (destinationFolderId !== undefined) {
      const key = Object.keys(ids).find(key => key.startsWith("folder:") && ids[key] === destinationFolderId);
      const entry = key && nodes.get(key.slice(7));
      if (!entry || entry.locked || entry.depth === 0 || entry.node.url || !Array.isArray(entry.node.children)) throw new Error("Choose an existing writable bookmark folder.");
      destination = entry.node;
    }
    if (!destination || nodes.get(String(destination.id))?.locked) throw new Error("A writable bookmark folder is unavailable.");
    const witnessJson = canonicalJson({ nodes: witness, modes, destinationId: destination.id });
    if (witnessJson.length > 8 * 1024 * 1024) throw new Error("Native bookmark tree cannot be transferred safely.");
    return { nodes, records: witness, modes: { ...modes }, destination, witness: witnessJson };
  }
  function additions(data, state) {
    const seen = new Set([...state.nodes.values()].map(({ node }) => url(node.url)).filter(Boolean));
    const bookmarks = [], folders = [...state.nodes.values()].filter(({ node, depth, locked }) => !locked && depth > 1 && !node.url && Array.isArray(node.children) && !node.folderType);
    let duplicateBookmarks = 0;
    for (const bookmark of data.bookmarks) {
      const normalized = url(bookmark.url);
      if (seen.has(normalized)) duplicateBookmarks++;
      else { seen.add(normalized); bookmarks.push({ ...bookmark, url: normalized }); }
    }
    const bookmarkCount = [...state.nodes.values()].filter(({ node, locked }) => !locked && url(node.url)).length;
    if (bookmarkCount + bookmarks.length > 2000 || folders.length + data.folders.length > 100) throw new Error("Import would exceed 2,000 bookmarks or 100 bookmark folders.");
    const byId = new Map(data.folders.map(folder => [folder.id, folder]));
    for (const folder of data.folders) {
      let depth = state.nodes.get(String(state.destination.id)).depth - 1, current = folder;
      while (current) { depth++; current = current.parentId ? byId.get(current.parentId) : undefined; }
      if (depth > 8) throw new Error("Import would exceed eight folder levels at this destination. Choose a shallower folder.");
    }
    return { bookmarks, summary: { bookmarksToAdd: bookmarks.length, duplicateBookmarks, foldersToAdd: data.folders.length } };
  }
  async function exportBookmarks() {
    const state = await snapshot();
    const folders = [], bookmarks = [], localIds = new Map();
    const excluded = { bookmarks: 0, folders: 0 };
    for (const { node, depth, locked } of state.nodes.values()) {
      if (!locked && depth > 1 && !node.url && Array.isArray(node.children) && !node.folderType) localIds.set(String(node.id), `f${localIds.size}`);
    }
    for (const { node, depth, locked } of state.nodes.values()) {
      if (locked) {
        if (node.url) excluded.bookmarks++;
        else if (depth > 1 && Array.isArray(node.children) && !node.folderType) excluded.folders++;
        continue;
      }
      const folderId = localIds.get(String(node.parentId));
      if (localIds.has(String(node.id))) folders.push({ id: localIds.get(String(node.id)), name: text(node.title, 80, "Bookmarks"), ...(folderId ? { parentId: folderId } : {}) });
      else if (node.url) {
        const normalized = url(node.url);
        if (!normalized) { excluded.bookmarks++; continue; }
        const friendly = presentation(node, state.modes[node.id]);
        bookmarks.push({ url: normalized, title: text(friendly?.title || node.title, 500, normalized.length <= 500 ? normalized : "Bookmark"),
          displayMode: friendly?.mode ?? "title", ...(folderId ? { folderId } : {}) });
      }
    }
    const parsed = NativeBookmarkTransferSchema.safeParse({ format: "kestrel-bookmarks", version: 1, folders, bookmarks });
    if (!parsed.success) throw new Error("Bookmark export supports up to 100 folders, 2,000 HTTP(S) bookmarks and eight folder levels within 512 KiB.");
    return { ok: true, bookmarkTransfer: parsed.data, bookmarkExportExcluded: excluded };
  }
  async function request(input) {
    if (input.type === "browser-export-bookmarks") return exportBookmarks();
    if (input.type === "browser-discard-bookmark-import") {
      if (plan?.id === input.planId) plan = undefined;
      return { ok: true };
    }
    if (input.type === "browser-plan-bookmark-import") {
      plan = undefined;
      const data = NativeBookmarkTransferSchema.parse(input.data);
      const state = await snapshot(input.destinationFolderId), { bookmarks, summary } = additions(data, state);
      const expires = Date.now() + TTL, id = crypto.randomUUID();
      plan = { id, data, bookmarks, summary, expires, witness: state.witness, destinationFolderId: input.destinationFolderId };
      return { ok: true, bookmarkImportPlan: { planId: id, summary, expiresAt: new Date(expires).toISOString() } };
    }
    const selected = plan;
    // Even forged/stale apply attempts consume the current plan. No retry can
    // accidentally replay a partially completed import.
    plan = undefined;
    if (!selected || input.planId !== selected.id || Date.now() >= selected.expires) throw new Error("This bookmark import preview expired. Preview the file again.");
    const state = await snapshot(selected.destinationFolderId);
    if (state.witness !== selected.witness) throw new Error("Bookmarks changed after the preview. Preview the file again.");
    if (Date.now() >= selected.expires) throw new Error("This bookmark import preview expired. Preview the file again.");
    additions(selected.data, state); // Enforce combined limits again before mutation.
    const result = { bookmarksAdded: 0, duplicateBookmarks: selected.summary.duplicateBookmarks, foldersAdded: 0, complete: true };
    const createdFolders = new Map();
    const expectedRecords = new Map(state.records.map(node => [String(node.id), canonicalJson(node)]));
    const expectedModes = JSON.parse(JSON.stringify(state.modes));
    async function recheckProgress() {
      const fresh = await snapshot(selected.destinationFolderId);
      if (fresh.destination.id !== state.destination.id || fresh.records.length !== expectedRecords.size ||
        fresh.records.some(node => expectedRecords.get(String(node.id)) !== canonicalJson(node)) ||
        canonicalJson(fresh.modes) !== canonicalJson(expectedModes)) throw new Error("Bookmarks changed during import.");
    }
    try {
      const pending = [...selected.data.folders];
      while (pending.length) {
        const index = pending.findIndex(folder => !folder.parentId || createdFolders.has(folder.parentId));
        if (index < 0) throw new Error();
        const [folder] = pending.splice(index, 1);
        await recheckProgress();
        const created = await invoke(chromeApi.bookmarks, "create", { parentId: folder.parentId ? createdFolders.get(folder.parentId) : state.destination.id, title: folder.name });
        result.foldersAdded++;
        expectedRecords.set(String(created.id), canonicalJson(record(created)));
        createdFolders.set(folder.id, created.id);
      }
      for (const bookmark of selected.bookmarks) {
        await recheckProgress();
        const created = await invoke(chromeApi.bookmarks, "create", { parentId: bookmark.folderId ? createdFolders.get(bookmark.folderId) : state.destination.id, title: bookmark.title, url: bookmark.url });
        result.bookmarksAdded++;
        expectedRecords.set(String(created.id), canonicalJson(record(created)));
        await savePresentation(created, bookmark.displayMode, bookmark.title, state.modes);
        expectedModes[created.id] = { mode: bookmark.displayMode, title: bookmark.title, dateAdded: created.dateAdded };
        expectedRecords.set(String(created.id), canonicalJson(record({ ...created, title: bookmark.displayMode === "icon" ? "" : bookmark.displayMode === "full" ? bookmark.url : bookmark.title })));
      }
      await recheckProgress();
    } catch {
      result.complete = false;
      result.error = "Import stopped before completion. Added bookmarks were kept; check bookmarks before importing again.";
    }
    try {
      await emitState();
      return { ...await response(), bookmarkImportResult: result };
    } catch {
      result.complete = false;
      result.error = "Added bookmarks were kept, but their latest state could not be read. Check bookmarks before importing again.";
      return { ok: true, bookmarkImportResult: result };
    }
  }
  return { request };
}
