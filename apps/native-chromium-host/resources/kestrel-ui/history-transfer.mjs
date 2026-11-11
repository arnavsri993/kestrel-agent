import { NativeHistoryTransferSchema, NativeHistoryTransferEntrySchema, RendererRequestSchema, UserBrowserHistoryEntrySchema } from '../../../../packages/shared-types/src/contracts.ts';

export const NATIVE_IMPORTED_HISTORY_KEY = 'kestrel.native.browser.importedHistory.v1';
const ttl = 120_000;
const copy = value => structuredClone(value);
// Chrome storage preserves JSON values, but may enumerate object fields in a
// different order on read-back. Keep array order and every scalar significant.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
 ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const semanticJSON = value => JSON.stringify(canonical(value));
const same = (left, right) => semanticJSON(left) === semanticJSON(right);
const portable = ({ url, title, visitedAt }) => ({ url, title, visitedAt });
const key = entry => { let url; try { url = new URL(entry.url).href; } catch { url = entry.url; } return `${url}\n${new Date(entry.visitedAt).toISOString()}`; };
const transfer = entries => ({ format: 'kestrel-history', version: 1, entries: entries.map(portable) });
const witness = snapshot => semanticJSON({ imported: snapshot.imported, native: snapshot.native.witness ?? snapshot.native.entries.map(portable).sort((a, b) => key(a).localeCompare(key(b))), excluded: snapshot.native.excluded, truncated: Boolean(snapshot.native.truncated), unavailable: Boolean(snapshot.native.unavailable) });

// Imported dates are archival metadata. They never create Chromium visits or
// feed Chromium's omnibox. One worker queue owns every history read and write.
export function createNativeHistoryTransfer({ read, write, readNative, clearNative, response, emit, clock = Date.now }) {
 let plan, syncError, queue = Promise.resolve();
 const enqueue = action => { const work = queue.then(action); queue = work.catch(() => undefined); return work; };
 async function imported() {
  const value = await read();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'entries,version' || value.version !== 1 || !Array.isArray(value.entries)) throw Error('Imported history storage is invalid. It was left unchanged.');
  NativeHistoryTransferSchema.parse(transfer(value.entries));
  const ids = new Set(), keys = new Set();
  for (const entry of value.entries) {
   UserBrowserHistoryEntrySchema.strict().parse(entry);
   if (entry.provenance !== 'imported' || ids.has(entry.id) || keys.has(key(entry))) throw Error('Imported history storage is invalid. It was left unchanged.');
   ids.add(entry.id); keys.add(key(entry));
  }
  return copy(value);
 }
 async function snapshot() { return { imported: await imported(), native: await readNative() }; }
 function visible(s) {
  // Storage preserves the entire imported archive. The bounded Kestrel view
  // shows the newest native and imported entries together, like live history.
  const importedKeys = new Set(s.imported.entries.map(key));
  const live = s.native.entries.filter(entry => !importedKeys.has(key(entry)));
  return [...s.imported.entries, ...live].sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt)).slice(0, 5000);
 }
 async function verifiedWrite(value) {
  try {
   await write(value);
   if (!same(await imported(), value)) throw Error('Verification failed.');
  } catch { throw Error('Imported history could not be saved or verified. Check history before reviewing another import.'); }
 }
 async function operation(input) {
  // Even malformed/wrong-ID apply and discard requests retire a pending token.
  const previous = plan;
  if (['browser-plan-history-import', 'browser-apply-history-import', 'browser-discard-history-import', 'browser-clear-history'].includes(input.type)) plan = undefined;
  const parsed = RendererRequestSchema.safeParse(input);
  if (!parsed.success) throw Error('Invalid history request. Use a Kestrel history file up to 1 MiB.');
  input = parsed.data;
  if (input.type === 'browser-discard-history-import') return { ok: true };
  if (input.type === 'browser-clear-history') {
   // Neither store is skipped when the other fails. Never report a partial
   // clear as success, and always publish the remaining current state.
   const failures = [];
   try { await clearNative(); } catch { failures.push('Chromium history'); }
   try { await verifiedWrite({ version: 1, entries: [] }); } catch { failures.push('imported history'); }
   syncError = failures.length ? `History was only partially cleared or could not be cleared (${failures.join(' and ')}). Check history before trying again.` : undefined;
   return { refresh: true, cleared: true, ...(syncError ? { error: syncError } : {}) };
  }
  if (input.type === 'browser-export-history') {
   const s = await snapshot();
   if (s.native.unavailable) throw Error('Native Chromium history is unavailable. History export was not prepared.');
   const importedKeys = new Set(s.imported.entries.map(key));
   const nativePortable = (s.native.portableEntries ?? s.native.entries).filter(entry => !importedKeys.has(key(entry)));
   const entries = [...s.imported.entries, ...nativePortable].sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt)).slice(0, 5000);
   // Refuse an oversized export rather than silently dropping metadata.
   const data = NativeHistoryTransferSchema.parse(transfer(entries));
   return { ok: true, historyTransfer: data, historyExportExcluded: { entries: s.native.excluded + Math.max(0, nativePortable.length + s.imported.entries.length - 5000), nativeTruncated: Boolean(s.native.truncated) } };
  }
  if (input.type === 'browser-plan-history-import') {
   const s = await snapshot();
   if (s.native.unavailable) throw Error('Native Chromium history is unavailable. History import was not prepared.');
   const seen = new Set([...s.native.entries, ...s.imported.entries].map(key));
   const additions = [], summary = { entriesToAdd: 0, duplicateEntries: 0 };
   for (const entry of input.data.entries) {
    if (seen.has(key(entry))) { summary.duplicateEntries++; continue; }
    seen.add(key(entry)); additions.push(portable(entry)); summary.entriesToAdd++;
   }
   const nextPortable = transfer([...s.imported.entries, ...additions]);
   NativeHistoryTransferSchema.parse(nextPortable);
   // Include the native API sentinel in the capacity decision, even if its
   // URL is ineligible for portable transfer. No current records are hidden.
   const importedKeys = new Set(s.imported.entries.map(key));
   const nativeOnly = s.native.entries.filter(entry => !importedKeys.has(key(entry))).length;
   if (s.native.truncated || nativeOnly + s.imported.entries.length + additions.length > 5000) throw Error('This import cannot fit in Kestrel’s 5,000-entry history view with current Chromium history. Clear history or use a smaller file.');
   const id = crypto.randomUUID(), expires = clock() + ttl;
   plan = { id, expires, before: witness(s), additions: copy(additions) };
   return { ok: true, historyImportPlan: { planId: id, expiresAt: new Date(expires).toISOString(), summary } };
  }
  if (input.type === 'browser-apply-history-import') {
   if (!previous || previous.id !== input.planId || clock() >= previous.expires) throw Error('This history review has expired or is invalid. Review the import again.');
   const s = await snapshot();
   if (witness(s) !== previous.before) throw Error('History changed after review. Review the import again.');
   const next = { version: 1, entries: [...s.imported.entries, ...previous.additions.map(entry => ({ id: `visit-${crypto.randomUUID()}`, tabId: `tab-${crypto.randomUUID()}`, ...entry, provenance: 'imported' }))] };
   // Native snapshot acquisition awaits several APIs. Recheck the stored
   // collection after those awaits, immediately before its single write.
   if (!same(await imported(), s.imported)) throw Error('Imported history changed after review. Review the import again.');
   if (clock() >= previous.expires) throw Error('This history review has expired. Review the import again.');
   if (previous.additions.length) await verifiedWrite(next);
   return { refresh: true };
  }
  throw Error('Unsupported history request.');
 }
 return {
  // Chrome Settings and chrome://history own their own deletion APIs. Mirror
  // their removal event into the archive without invoking those APIs again.
  nativeHistoryRemoved: details => enqueue(async () => {
   plan = undefined;
   try {
    if (details?.allHistory === true) {
     await verifiedWrite({ version: 1, entries: [] });
     syncError = undefined;
    }
    else {
     const urls = new Set((Array.isArray(details?.urls) ? details.urls : []).flatMap(url => {
      if (!NativeHistoryTransferEntrySchema.shape.url.safeParse(url).success) return [];
      return [new URL(url).href];
     }));
     if (urls.size) {
      const before = await imported();
      const entries = before.entries.filter(entry => !urls.has(new URL(entry.url).href));
      if (entries.length !== before.entries.length) await verifiedWrite({ version: 1, entries });
     }
    }
    return { ok: true };
   } catch {
    syncError = 'Chromium history changed, but matching imported history could not be removed. Check history and try clearing it again.';
    return { ok: false, error: syncError };
   }
  }),
  // Worker-owned status is replayed with each initial renderer refresh. It is
  // intentionally in memory: unwritable storage cannot promise durable status.
  getSyncError: () => syncError,
  read: () => enqueue(async () => visible(await snapshot())),
  request: async input => {
   let result;
   try { result = await enqueue(() => operation(input)); } catch (error) {
    if (input.type === 'browser-apply-history-import' || input.type === 'browser-clear-history') { try { await emit(); } catch { /* preserve the operation's known failure */ } }
    throw error;
   }
   // Reading state re-enters the queue, so publish only after releasing it.
   if (!result.refresh) return result;
   try { await emit(); } catch { /* explicit response below retries the state read */ }
   let current;
   try { current = await response(); } catch {
    return { ok: false, error: result.error ? `${result.error} Current history could not be refreshed.` : `History was ${result.cleared ? 'cleared' : 'saved'}, but current history could not be refreshed.` };
   }
   if (result.error) return { ok: false, error: result.error, browserState: current.browserState };
   return current;
  },
 };
}

/** Preserve native display semantics separately from strict portable metadata. */
export function normalizeNativeHistory(entries, tabId) {
 const output = [], portableEntries = []; let excluded = 0;
 for (const entry of entries) {
  const date = new Date(entry.lastVisitTime);
  const hasDate = typeof entry.lastVisitTime === 'number' && Number.isFinite(date.getTime());
  const original = { url: entry.url, title: entry.title || entry.url || '', visitedAt: hasDate ? date.toISOString() : '' };
  const displayable = typeof entry.url === 'string' && entry.url.length <= 8192 && /^https?:/i.test(entry.url);
  const id = `visit-${crypto.randomUUID()}`;
  if (displayable) output.push({ id, tabId, url: entry.url, title: String(entry.title || entry.url).slice(0, 500), visitedAt: hasDate ? date.toISOString() : new Date().toISOString() });
  if (NativeHistoryTransferEntrySchema.safeParse(original).success) portableEntries.push({ id, tabId, ...original });
  else excluded++;
 }
 return { entries: output, portableEntries, excluded, truncated: entries.length > 5000,
  // Compare original API metadata, never generated IDs or display fallbacks.
  witness: entries.map(({ url, title, lastVisitTime }) => [url, title, lastVisitTime]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
