import { parseNativeHomeSettingsTransferFile } from '../../../../packages/shared-types/src/contracts.ts';

const categories = { background: ['newTabBackground', 'newTabBackgroundCustomDataUrl'], shortcuts: ['newTabShortcuts'], greeting: ['newTabGreetingActivity'], widgets: ['newTabWidgets'] };
const ttl = 120_000;
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const selected = (value, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));

// Tokens and sensitive snapshots exist only in the authenticated worker memory.
export function createNativeHomeSettingsTransfer({ read, write, response, emit }) {
 let plan, undo;
 async function snapshot() {
  const value = await read();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Home settings are unavailable.');
  return copy(value);
 }
 async function verifiedWrite(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024 * 1024) throw Error('Home settings exceed available transfer capacity.');
  try {
   await write(value);
   if (!same(await snapshot(), value)) throw Error('Verification failed.');
  } catch { throw Error('The Home settings result is uncertain. Check Home before reviewing another import.'); }
 }
 return async input => {
  if (input.type === 'browser-discard-home-settings-import') { if (plan?.id === input.planId) plan = undefined; return { ok: true }; }
  if (input.type === 'browser-plan-home-settings-import') {
   plan = undefined;
   const parsed = parseNativeHomeSettingsTransferFile({ format: 'kestrel-home-settings', version: 1, settings: input.settings });
   if (!Array.isArray(input.categories) || !input.categories.length || new Set(input.categories).size !== input.categories.length || !input.categories.every(category => parsed.availableCategories.includes(category))) throw Error('Choose settings present in the file.');
   const before = await snapshot();
   const keys = input.categories.flatMap(category => categories[category]).filter(key => Object.hasOwn(parsed.settings, key));
   const next = { ...before, ...selected(parsed.settings, keys) };
   if (next.newTabBackground === 'custom' && !next.newTabBackgroundCustomDataUrl) throw Error('A custom background requires an image.');
   const changedCategories = input.categories.filter(category => !same(selected(before, categories[category].filter(k => keys.includes(k))), selected(next, categories[category].filter(k => keys.includes(k)))));
   const id = crypto.randomUUID(), expires = Date.now() + ttl;
   plan = { id, expires, before, next, keys, categories: [...input.categories], changedCategories };
   return { ok: true, homeSettingsImportPlan: { planId: id, expiresAt: new Date(expires).toISOString(), categories: input.categories, changedCategories } };
  }
  if (input.type === 'browser-apply-home-settings-import') {
   const p = plan; plan = undefined; undo = undefined;
   if (!p || p.id !== input.planId || Date.now() >= p.expires) throw Error('This review has expired. Review the import again.');
   if (!same(await snapshot(), p.before)) throw Error('Home settings changed after review. Review the import again.');
   await verifiedWrite(p.next);
   const id = crypto.randomUUID(), expires = Date.now() + ttl;
   undo = { id, expires, keys: p.keys, before: selected(p.before, p.keys), applied: selected(p.next, p.keys), categories: p.categories };
   await emit();
   return { ...(await response()), homeSettingsImportResult: { changedCategories: p.changedCategories, undoId: id, undoExpiresAt: new Date(expires).toISOString() } };
  }
  if (input.type === 'browser-undo-home-settings-import') {
   const u = undo; undo = undefined;
   if (!u || u.id !== input.undoId || Date.now() >= u.expires) throw Error('Undo has expired.');
   const current = await snapshot();
   if (!same(selected(current, u.keys), u.applied)) throw Error('Imported settings changed. Undo was not applied.');
   const next = { ...current }; for (const key of u.keys) delete next[key]; Object.assign(next, u.before);
   await verifiedWrite(next); await emit();
   return { ...(await response()), homeSettingsUndoResult: { restoredCategories: u.categories } };
  }
  throw Error('Unsupported Home settings transfer.');
 };
}
