import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loginCodeField } from '../apps/native-chromium-host/resources/kestrel-ui/login-code-fields.mjs';
import { createBrowserAdapter } from '../apps/native-chromium-host/resources/kestrel-ui/browser.mjs';

class Input {
 constructor(attrs = {}) { this.attrs = attrs; this.type = attrs.type || 'text'; this.id = attrs.id || ''; this.isConnected = true; this.disabled = false; this.readOnly = false; this.events = []; }
 getAttribute(name) { return this.attrs[name] ?? null; }
 getBoundingClientRect() { return { width: 100, height: 20 }; }
 getClientRects() { return [this.getBoundingClientRect()]; }
 dispatchEvent(event) { this.events.push(event.type); return true; }
 set value(value) { this.written = value; }
}
let fields;
let windowEvents;
let navigationEvents;
beforeEach(() => {
 delete globalThis.__kestrelLoginCodeFieldsV1;
 windowEvents = new EventTarget();
 navigationEvents = new EventTarget();
 globalThis.addEventListener = windowEvents.addEventListener.bind(windowEvents);
 globalThis.navigation = navigationEvents;
 navigation.currentEntry = { key: 'first', id: 'entry1' };
 globalThis.HTMLInputElement = Input;
 globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
 globalThis.location = { href: 'https://example.com/login' };
 fields = [new Input({ autocomplete: 'one-time-code' })];
 const documentEvents = new EventTarget();
 globalThis.document = { querySelectorAll: () => fields, activeElement: null, getElementById: () => null,
  addEventListener: documentEvents.addEventListener.bind(documentEvents), visibilityState: 'visible', hasFocus: () => true };
});
test('selects only unambiguous eligible fields, and rejects sensitive and hidden fields', () => {
 fields.push(new Input({ 'aria-label': 'Verification code' }));
 assert.equal(loginCodeField('inspect').ok, false);
 document.activeElement = fields[1];
 assert.equal(loginCodeField('inspect').ok, true);
 fields = [new Input({ 'aria-label': 'Credit card security code' })];
 assert.equal(loginCodeField('inspect').ok, false);
 fields = [new Input({ autocomplete: 'one-time-code', type: 'password' })];
 assert.equal(loginCodeField('inspect').ok, false);
});
test('binds field identity and URL, consumes fill before effect, and emits only input/change', () => {
 let token = loginCodeField('inspect').fieldId;
 assert.equal(loginCodeField('validate', token).ok, true);
 location.href += '#changed';
 assert.equal(loginCodeField('fill', token, '123456').ok, false);
 location.href = 'https://example.com/login';
 assert.equal(loginCodeField('fill', token, '123456').ok, false);
 token = loginCodeField('inspect').fieldId;
 fields[0].attrs.maxlength = '4';
 assert.equal(loginCodeField('validate', token).ok, false);
 token = loginCodeField('inspect').fieldId;
 assert.equal(loginCodeField('fill', token, '123456').ok, false);
 assert.equal(loginCodeField('fill', token, '1234').ok, false);
 token = loginCodeField('inspect').fieldId;
 assert.equal(loginCodeField('fill', token, '1234').ok, true);
 assert.equal(fields[0].written, '1234');
 assert.deepEqual(fields[0].events, ['input', 'change']);
 assert.equal(loginCodeField('fill', token, '1234').ok, false);
});
test('rejects payment form context even with one-time-code autocomplete', () => {
 const card = new Input({ autocomplete: 'cc-number' });
 fields[0].form = { id: 'checkout', textContent: 'Payment details', getAttribute: () => null, querySelectorAll: () => [fields[0], card] };
 assert.equal(loginCodeField('inspect').ok, false);
 fields[0].form = null;
 fields[0].attrs = { 'aria-label': 'Security code' };
 assert.equal(loginCodeField('inspect').ok, false);
});
test('invalidates on blur and history changes and refuses an unfocused write', () => {
 let token = loginCodeField('inspect').fieldId;
 windowEvents.dispatchEvent(new Event('blur'));
 assert.equal(loginCodeField('fill', token, '123456').ok, false);
 token = loginCodeField('inspect').fieldId;
 document.hasFocus = () => false;
 assert.equal(loginCodeField('fill', token, '123456').ok, false);
 assert.equal(fields[0].written, undefined);
 document.hasFocus = () => true;
 token = loginCodeField('inspect').fieldId;
 navigation.currentEntry = { key: 'second', id: 'entry2' };
 assert.equal(loginCodeField('validate', token).ok, false);
 token = loginCodeField('inspect').fieldId;
 navigationEvents.dispatchEvent(new Event('currententrychange'));
 assert.equal(loginCodeField('validate', token).ok, false);
});
function fixture() {
 const tab = { id: 7, windowId: 2, active: true, status: 'complete', url: 'https://example.com/login' };
 const frame = { documentId: 'doc_1', documentLifecycle: 'active', url: tab.url };
 const data = {};
 const callback = fn => (...args) => { const cb = args.pop(); cb(fn(...args)); };
 let afterExecute = () => {};
 let historyListener;
 const historyEvent = { addListener: fn => { historyListener = fn; } };
 const api = {
  storage: { local: {}, session: { get: callback(k => ({ [k]: data[k] })), set: callback(value => Object.assign(data, value)) } },
  tabs: { query: callback(() => [tab]), get: callback(() => ({ ...tab })) },
  windows: { getLastFocused: callback(() => ({ id: 2, focused: true })) },
  webNavigation: { getFrame: callback(() => ({ ...frame })), onHistoryStateUpdated: historyEvent },
  scripting: { executeScript: callback(({ func, args, target }) => { const result = func(...args); afterExecute(); return [{ frameId: 0, documentId: target.documentIds[0], result }]; }) },
 };
 const adapter = createBrowserAdapter(api, { uiUrl: 'chrome-extension://abcdef/index.html' });
 return { adapter, tab, frame, data, setAfter: fn => { afterExecute = fn; }, navigate: () => historyListener({ tabId: 7, frameId: 0 }) };
}
test('adapter binds active document and rejects navigation or changed tab', async () => {
 const f = fixture();
 // Initialize the session mapping through a rejected lookup, then use its generated ID.
 await assert.rejects(f.adapter.loginCode({ operation: 'inspect', tabId: 'tab-00000000-0000-4000-8000-000000000000' }));
 const id = f.data['kestrel.native.browser.tabIds.v1']['7'];
 const authority = await f.adapter.loginCode({ operation: 'inspect', tabId: id });
 assert.deepEqual(await f.adapter.loginCode({ operation: 'validate', authority }), { valid: true });
 f.frame.documentId = 'doc_2';
 await assert.rejects(f.adapter.loginCode({ operation: 'fill', authority, code: '123456' }), /unavailable or has changed/);
 assert.equal(fields[0].written, undefined);
 f.frame.documentId = 'doc_1';
 f.setAfter(() => { f.tab.active = false; });
 await assert.rejects(f.adapter.loginCode({ operation: 'validate', authority }), /unavailable or has changed/);
});

test('adapter rejects a same-URL history revision', async () => {
 const f = fixture();
 await assert.rejects(f.adapter.loginCode({ operation: 'inspect', tabId: 'tab-00000000-0000-4000-8000-000000000000' }));
 const id = f.data['kestrel.native.browser.tabIds.v1']['7'];
 const authority = await f.adapter.loginCode({ operation: 'inspect', tabId: id });
 f.navigate();
 await assert.rejects(f.adapter.loginCode({ operation: 'fill', authority, code: '123456' }));
 assert.equal(fields[0].written, undefined);
});
