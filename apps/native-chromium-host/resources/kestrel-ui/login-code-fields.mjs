// Serialized by chrome.scripting into the extension's isolated world. Keep all
// state and helpers inside this function: page scripts cannot access the registry.
export function loginCodeField(operation, fieldId, code) {
 const key = '__kestrelLoginCodeFieldsV1';
 const now = Date.now();
 let state = globalThis[key];
 if (!state || !(state.registry instanceof Map) || !Number.isSafeInteger(state.generation)) {
  const registry = new Map();
  state = globalThis[key] = { registry, generation: 0 };
  const invalidate = () => { state.generation += 1; registry.clear(); };
  for (const event of ['blur', 'pagehide', 'popstate', 'hashchange']) globalThis.addEventListener(event, invalidate);
  document.addEventListener('visibilitychange', invalidate);
  globalThis.navigation?.addEventListener('currententrychange', invalidate);
 }
 const { registry } = state;
 const navigationEntry = () => [globalThis.navigation?.currentEntry?.key ?? null, globalThis.navigation?.currentEntry?.id ?? null];
 for (const [id, entry] of registry) if (entry.expires <= now) registry.delete(id);
 const fail = () => ({ ok: false });
 const text = element => {
  const labels = element.labels ? Array.from(element.labels, label => label.textContent || '').join(' ') : '';
  const described = (element.getAttribute('aria-labelledby') || '').split(/\s+/).slice(0, 8)
   .map(id => document.getElementById(id)?.textContent || '').join(' ');
  return [element.getAttribute('autocomplete'), element.getAttribute('name'), element.id,
   element.getAttribute('aria-label'), element.getAttribute('placeholder'), labels, described]
   .map(value => String(value || '').slice(0, 256)).join(' ').toLowerCase().slice(0, 1024);
 };
 const paymentContext = element => {
  const form = element.form;
  if (!form) return '';
  const metadata = [form.id, form.getAttribute('name'), form.getAttribute('aria-label'),
   form.getAttribute('autocomplete'), String(form.textContent || '').slice(0, 4096)];
  const inputs = form.querySelectorAll('input');
  for (let index = 0; index < Math.min(inputs.length, 50); index++) metadata.push(text(inputs[index]));
  return metadata.map(value => String(value || '').slice(0, 4096)).join(' ').toLowerCase().slice(0, 16384);
 };
 const payment = value => /(?:\b(?:credit|debit|payment|card|cvv|cvc|cc-number|cc-csc|cc-exp|cardholder)\b)/i.test(value);
 const signature = element => JSON.stringify([paymentContext(element), element.type, element.getAttribute('autocomplete'),
  element.getAttribute('name'), element.id, element.getAttribute('aria-label'),
  element.getAttribute('placeholder'), element.getAttribute('minlength'), element.getAttribute('maxlength'),
  element.getAttribute('pattern'), text(element)]);
 const eligible = element => {
  if (!(element instanceof HTMLInputElement) || !element.isConnected || element.disabled || element.readOnly ||
   !['text', 'tel', 'number'].includes(element.type)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 ||
   (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) ||
   rect.width <= 0 || rect.height <= 0 || !element.getClientRects().length ||
   (Number.isFinite(rect.right) && (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight))) return false;
  const semantic = text(element);
  if (payment(semantic) || payment(paymentContext(element)) || /password|passphrase|private.?key|seed phrase|recovery phrase/i.test(semantic)) return false;
  return /(?:^|\s)one-time-code(?:\s|$)/i.test(element.getAttribute('autocomplete') || '') ||
   /(?:\botp\b|one[ -]?time (?:pass(?:word|code)?|code)|verification code|authentication code|authenticator code|login code|sign[ -]?in code|2fa code|two[ -]?factor code)/i.test(semantic);
 };
 if (operation === 'inspect') {
  const candidates = Array.from(document.querySelectorAll('input')).filter(eligible);
  const focused = candidates.find(element => element === document.activeElement);
  const element = focused || (candidates.length === 1 ? candidates[0] : null);
  if (!element) return fail();
  while (registry.size >= 32) registry.delete(registry.keys().next().value);
  const id = crypto.randomUUID();
  registry.set(id, { element, generation: state.generation, href: location.href, navigationEntry: navigationEntry(), signature: signature(element), expires: now + 120000 });
  return { ok: true, fieldId: id };
 }
 const entry = registry.get(fieldId);
 // Consume before any attempted write, even if validation subsequently fails.
 if (operation === 'fill') registry.delete(fieldId);
 if (!entry || entry.generation !== state.generation || entry.expires <= now || entry.href !== location.href || JSON.stringify(entry.navigationEntry) !== JSON.stringify(navigationEntry()) || !eligible(entry.element) ||
  entry.signature !== signature(entry.element)) return fail();
 if (operation === 'validate') return { ok: true };
 if (operation !== 'fill' || typeof code !== 'string' || !/^[A-Z0-9][A-Z0-9-]{3,15}$/.test(code)) return fail();
 const element = entry.element;
 const min = element.getAttribute('minlength');
 const max = element.getAttribute('maxlength');
 if ((min !== null && /^\d+$/.test(min) && code.length < Number(min)) ||
  (max !== null && /^\d+$/.test(max) && code.length > Number(max)) ||
  (element.type === 'number' && !/^\d+$/.test(code))) return fail();
 const pattern = element.getAttribute('pattern');
 if (pattern) {
  // Reject complex page-provided patterns instead of executing potentially
  // expensive expressions in the extension world.
  try { if (pattern.length > 128 || /[()|*+?]/.test(pattern) || !new RegExp(`^(?:${pattern})$`, 'v').test(code)) return fail(); }
  catch { return fail(); }
 }
 const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
 if (!setter || document.visibilityState !== 'visible') return fail();
 // The user chose this captured field from the companion. Focus that field in
 // the already selected document; never activate a different tab or window.
 // A background window still fails document.hasFocus(). Focus handlers may
 // navigate or replace the field, so repeat authority checks before writing.
 element.focus({ preventScroll: true });
 if (entry.generation !== state.generation || !document.hasFocus() || document.activeElement !== element ||
  entry.href !== location.href || JSON.stringify(entry.navigationEntry) !== JSON.stringify(navigationEntry()) ||
  entry.signature !== signature(element) || !eligible(element) || document.visibilityState !== 'visible') return fail();
 setter.call(element, code);
 element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
 element.dispatchEvent(new Event('change', { bubbles: true }));
 return { ok: true };
}
