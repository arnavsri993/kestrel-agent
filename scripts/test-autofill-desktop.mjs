import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, expect } from '@playwright/test';
import { openKestrelDestination, selectSettingsSection } from './desktop-browser-test-helpers.mjs';
const root=mkdtempSync(join(tmpdir(),'kestrel-autofill-desktop-'));
const packaged=process.env.KESTREL_DESKTOP_EXECUTABLE;
let app;
try {
 app=await electron.launch({executablePath:packaged || createRequire(resolve('apps/desktop/package.json'))('electron'),args:packaged?['--use-mock-keychain']:[resolve('apps/desktop'),'--use-mock-keychain'],env:{...process.env,KESTREL_TEST_USER_DATA:root,KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES:'1',KESTREL_DISABLE_UPDATES:'1',KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY:'1',KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY:'1'}});
 const page=await app.firstWindow();
 await page.waitForLoadState('domcontentloaded');
 await page.waitForFunction(()=>Boolean(window.kestrel));
 await page.evaluate(()=>{localStorage.setItem('kestrel:onboarded','yes');localStorage.setItem('kestrel:default-browser-prompted','yes');});
 await page.reload();
 const request=(input)=>page.evaluate((input)=>window.kestrel.request(input),input);
 await app.evaluate(async ({session})=>{
  await session.fromPartition('persist:kestrel-user-browser-v1').protocol.handle('https',(request)=>{
   const login=new URL(request.url).pathname==='/login';
   return new Response(`<!doctype html><title>Autofill verification</title><style>body{font:18px system-ui;padding:30px}input{display:block;margin:15px;padding:10px}</style>${login?'<form><input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"><button type="button" onclick="this.form.remove();document.body.insertAdjacentHTML(\'beforeend\',\'<h1>Signed in fixture</h1>\')">Sign in</button></form>':'<form><label>First name<input id="name" autocomplete="given-name"></label><label>Street address<input id="address" autocomplete="street-address"></label><label>Birthday<input id="birth" type="date" autocomplete="bday"></label></form>'}`,{headers:{'content-type':'text/html'}});
  });
 });
 assert.equal((await request({type:'autofill-profile-save',profile:{'given-name':'Fixture','street-address':'12 Test Lane',bday:'2000-02-03'}})).ok,true);
 await openKestrelDestination(page,'Settings');
 await selectSettingsSection(page,'browser-autofill','Autofill');
 await page.getByRole('switch',{name:'Save passwords automatically',exact:true}).waitFor();
 await page.getByText('Saved personal info',{exact:true}).click();
 await expect(page.getByLabel('First name',{exact:true})).toHaveValue('Fixture');
 // Navigate through the real renderer request and show native view.
 await request({type:'browser-create-tab',input:'https://autofill.example.test/form',active:true});
 let remote;
 await expect.poll(()=>{remote=app.context().pages().find(p=>p.url()==='https://autofill.example.test/form');return Boolean(remote);}).toBe(true);
 await remote.locator('#name').focus();
 let overlay;
 await expect.poll(()=>{overlay=app.context().pages().find(p=>p.url().includes('passwordOverlay'));return Boolean(overlay);}).toBe(true);
 await overlay.getByRole('button',{name:'Fill form',exact:true}).click();
 await expect(remote.locator('#name')).toHaveValue('Fixture');
 await expect(remote.locator('#address')).toHaveValue('12 Test Lane');
 await expect(remote.locator('#birth')).toHaveValue('2000-02-03');
 await request({type:'browser-create-tab',input:'https://autofill.example.test/login',active:true});
 await expect.poll(()=>{remote=app.context().pages().find(p=>p.url()==='https://autofill.example.test/login');return Boolean(remote);}).toBe(true);
 await remote.locator('#user').fill('fixture-user');
 await remote.locator('#pass').fill('fixture-password');
 await remote.getByRole('button',{name:'Sign in'}).click();
 await expect.poll(async()=>{const response=await request({type:'password-list'});return response.ok && response.passwords?.some(p=>p.username==='fixture-user');}).toBe(true);
 await request({type:'browser-create-tab',input:'https://autofill.example.test/login',active:true});
 await expect.poll(()=>{const pages=app.context().pages().filter(p=>p.url()==='https://autofill.example.test/login');remote=pages.at(-1);return pages.length;}).toBe(2);
 await remote.locator('#pass').focus();
 await expect.poll(()=>{overlay=app.context().pages().find(p=>p.url().includes('passwordOverlay'));return Boolean(overlay);}).toBe(true);
 await overlay.getByRole('button').filter({hasText:'fixture-user'}).click();
 await expect(remote.locator('#pass')).toHaveValue('fixture-password');
 await expect(remote.locator('#user')).toHaveValue('fixture-user');
 console.log('PASS: full desktop protected profile settings, native profile popup fill, automatic SPA login saving, and saved-login focus popup fill.');
} finally { if(app)await app.close();rmSync(root,{recursive:true,force:true}); }
