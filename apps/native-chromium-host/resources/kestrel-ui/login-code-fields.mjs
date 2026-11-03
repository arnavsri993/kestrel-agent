// Serialized by chrome.scripting into the extension's isolated world. Keep all
// state and helpers inside this function: page scripts cannot access the registry.
export function loginCodeField(operation, fieldId, code) {
 const key = '__kestrelLoginCodeFieldsV1';
 const now = Date.now();
 const registry = globalThis[key] instanceof Map ? globalThis[key] : (globalThis[key] = new Map());
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
 const signature = element => JSON.stringify([element.type, element.getAttribute('autocomplete'),
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
  if (/password|passphrase|credit|debit|card|cvv|cvc|security code.*card|private.?key|seed phrase|recovery phrase/i.test(semantic)) return false;
  return /(?:^|\s)one-time-code(?:\s|$)/i.test(element.getAttribute('autocomplete') || '') ||
   /(?:\botp\b|one[ -]?time (?:pass(?:word|code)?|code)|verification code|authentication code|authenticator code|security code|login code|sign[ -]?in code|2fa code|two[ -]?factor code)/i.test(semantic);
 };
 if (operation === 'inspect') {
  const candidates = Array.from(document.querySelectorAll('input')).filter(eligible);
  const focused = candidates.find(element => element === document.activeElement);
  const element = focused || (candidates.length === 1 ? candidates[0] : null);
  if (!element) return fail();
  while (registry.size >= 32) registry.delete(registry.keys().next().value);
  const id = crypto.randomUUID();
  registry.set(id, { element, href: location.href, signature: signature(element), expires: now + 120000 });
  return { ok: true, fieldId: id };
 }
 const entry = registry.get(fieldId);
 // Consume before any attempted write, even if validation subsequently fails.
 if (operation === 'fill') registry.delete(fieldId);
 if (!entry || entry.expires <= now || entry.href !== location.href || !eligible(entry.element) ||
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
 if (!setter) return fail();
 setter.call(element, code);
 element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
 element.dispatchEvent(new Event('change', { bubbles: true }));
 return { ok: true };
}
