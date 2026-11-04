import { describe, expect, it } from 'vitest';
import { parseNativeHomeSettingsTransferFile, UserBrowserSettingsSchema } from './contracts';
const dedicated = (settings: unknown) => ({ format: 'kestrel-home-settings', version: 1, settings });
const legacy = (settings: unknown) => ({format:'kestrel-browser-data',version:1,exportedAt:'2026-01-01T00:00:00Z',bookmarks:[],bookmarkFolders:[],history:[],sitePermissions:[],settings});
describe('Home settings transfer', () => {
 it('retains only explicitly present keys despite schema defaults', () => {
  expect(parseNativeHomeSettingsTransferFile(dedicated({newTabShortcuts:[]}))).toEqual({source:'home-settings',settings:{newTabShortcuts:[]},availableCategories:['shortcuts']});
  expect(parseNativeHomeSettingsTransferFile(legacy({newTabBackground:'paper'})).settings).toEqual({newTabBackground:'paper'});
 });
 it('rejects invalid caught values, nested unknowns, unknown top-level keys and incomplete images', () => {
  for (const settings of [{newTabGreetingActivity:'invalid'},{newTabWidgets:{version:5}},{newTabWidgets:{version:1, unknown:true}},{newTabBackground:'custom'},{newTabBackground:'paper',password:'secret'},{newTabShortcuts:[{title:'X',url:'https://a:b@example.com'}]}])
   expect(() => parseNativeHomeSettingsTransferFile(dedicated(settings))).toThrow();
  expect(() => parseNativeHomeSettingsTransferFile({...legacy(UserBrowserSettingsSchema.parse({})),cookies:[]})).toThrow();
 });
 it('bounds and validates image data, rejects future versions, and normalizes shortcuts', () => {
  expect(parseNativeHomeSettingsTransferFile(dedicated({newTabBackground:'custom',newTabBackgroundCustomDataUrl:'data:image/png;base64,AAAA'})).availableCategories).toEqual(['background']);
  expect(() => parseNativeHomeSettingsTransferFile(dedicated({newTabBackgroundCustomDataUrl:'data:image/png;base64,'+'A'.repeat(7_000_000)}))).toThrow();
  expect(() => parseNativeHomeSettingsTransferFile({...dedicated({newTabBackground:'paper'}),version:2})).toThrow();
  expect(parseNativeHomeSettingsTransferFile(dedicated({newTabShortcuts:[{title:' Hello ',url:'https://example.com'}]})).settings.newTabShortcuts?.[0]?.title).toBe('Hello');
 });
});
