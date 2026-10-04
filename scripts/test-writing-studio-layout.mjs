import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Actual renderer component with owned deterministic responses. No Electron,
// real profile, provider generation, message transmission or clipboard write.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { createServer } = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
const output = join(root, ".tmp/writing-studio-layout");
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(root, ".tmp/writing-layout-renderer-"));
const styles = [...readFileSync(join(root, "apps/desktop/src/renderer/src.tsx"), "utf8")
  .matchAll(/import "(\.\/[^\"]+\.css)";/g)]
  .map(match => `import '/apps/desktop/src/renderer/${match[1].slice(2)}';`).join("\n");
writeFileSync(join(fixture, "index.html"), '<!doctype html><html data-platform="macos"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>');
writeFileSync(join(fixture, "fixture.js"), `
${styles}
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WritingStudio} from '/apps/desktop/src/renderer/components/browser/WritingStudio.tsx';
window.fixture = {calls:[], drafts:0};
const profile={status:'disabled',config:{enabled:false,useSelectedExemplars:false,maxExemplars:3},sampleCount:0,wordCount:0,exemplarCount:0};
const context = input => ({categories:[],confirmedProfileFacts:0,memories:0,calendarEvents:0,sensitiveIncluded:input.includeSensitive,restrictedIncluded:false,notes:['Owned fixture context only.']});
window.kestrel={request:async input=>{
  window.fixture.calls.push(input);
  if(input.type==='writing-profile-get') return {ok:true,writingProfile:profile};
  if(input.type==='runtime-list-providers') return {ok:true,providerAccounts:[]};
  if(input.type==='writing-context-preview') return {ok:true,writingContextPreview:context(input)};
  if(input.type==='writing-generate') {
    const id='owned-draft-'+(++window.fixture.drafts);
    return {ok:true,writingResult:{id,genre:input.genre,subject:'Owned subject',body:'Owned editable draft '+id,sourceMode:input.sourceText?'adapt':'compose',context:context(input),quality:{status:'passed',reviewerIssues:[],modelReviewed:false}}};
  }
  throw Error('Unexpected owned fixture request '+input.type);
}};
const sidebar=innerWidth<900?56:216;
createRoot(document.getElementById('root')).render(createElement('div',{id:'owned-stage',className:'ai-browser-app unified-ui agent-sidebar-collapsed',style:{display:'block',width:'calc(100vw - '+sidebar+'px)',marginLeft:sidebar,marginTop:80,height:'calc(100vh - 80px)',overflow:'auto'}},createElement(WritingStudio)));
`);
// A preceding renderer fixture can leave a different optimized React graph.
// Keep this graph private and discover Motion before the browser loads it.
const server = await createServer({ root, configFile: false, logLevel: "error",
  cacheDir: join(fixture, "vite-cache"),
  optimizeDeps: {
    entries: [join(fixture, "index.html")],
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "motion/react"],
  },
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: /^react$/, replacement: desktopRequire.resolve("react") },
    { find: /^react\/jsx-runtime$/, replacement: desktopRequire.resolve("react/jsx-runtime") },
    { find: /^react\/jsx-dev-runtime$/, replacement: desktopRequire.resolve("react/jsx-dev-runtime") },
    { find: /^react-dom$/, replacement: desktopRequire.resolve("react-dom") },
    { find: /^react-dom\/client$/, replacement: desktopRequire.resolve("react-dom/client") },
    { find: /^motion\/react$/, replacement: desktopRequire.resolve("motion/react") },
  ] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, appType: "mpa" });
let browser;
let activePage;
const report = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{width:1280,height:800},{width:800,height:660},{width:390,height:844}]) {
    const page = await browser.newPage({ viewport });
    activePage = page;
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${fixture.slice(root.length+1)}/index.html`);
    await page.getByRole("heading", {name:"What do you want to say?",exact:true}).waitFor();
    const source = page.locator(".writing-draft-disclosure").first();
    const options = page.locator(".writing-draft-disclosure").last();
    const voice = page.locator(".writing-profile-panel");
    for (const disclosure of [source,options,voice]) assert.equal(await disclosure.evaluate(node=>node.open),false);
    const initialGeometry = await page.getByRole("button",{name:"Create draft",exact:true}).evaluate(node=>{
      const box=node.getBoundingClientRect(),stage=document.querySelector('#owned-stage').getBoundingClientRect();
      return {top:box.top,bottom:box.bottom,stageTop:stage.top,stageBottom:stage.bottom,windowHeight:innerHeight};
    });
    assert(initialGeometry.top>=initialGeometry.stageTop && initialGeometry.bottom<=Math.min(initialGeometry.stageBottom,initialGeometry.windowHeight),"Create draft must be in the initial owned viewport.");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:join(output,`initial-${viewport.width}.png`)});
    await page.getByLabel("Purpose",{exact:true}).fill("Prepare an owned check-in draft.");
    await page.getByRole("button",{name:"Create draft",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.id)).toBe("writing-result-title");
    assert(await page.locator("#writing-result-title").evaluate(node=>{
      const box=node.getBoundingClientRect(),stage=document.querySelector('#owned-stage').getBoundingClientRect();
      return box.top>=stage.top && box.bottom<=Math.min(stage.bottom,innerHeight);
    }),"New draft heading must be visible in the owned viewport.");
    const first = await page.evaluate(()=>window.fixture.calls.find(call=>call.type==='writing-generate'));
    assert.deepEqual(first,{type:"writing-generate",purpose:"Prepare an owned check-in draft.",genre:"email",adaptationStrength:"balanced",includeSensitive:false,providerIds:["auto"]});
    await page.screenshot({path:join(output,`draft-${viewport.width}.png`)});
    await page.getByLabel("Body",{exact:true}).fill("My owned edited draft.");
    assert(await page.getByLabel("Body",{exact:true}).evaluate(node=>document.activeElement===node),"Editing must keep focus in the draft.");
    await source.locator("summary").focus(); await page.keyboard.press("Enter");
    await page.getByLabel(/Starting text/).fill("Owned starting draft.");
    await source.locator("summary").focus(); await page.keyboard.press("Enter");
    await options.locator("summary").focus(); await page.keyboard.press("Enter");
    await page.getByLabel(/Tone/).fill("Concise");
    const strength = page.getByRole("radio",{name:/Strong/});
    await strength.focus(); await page.keyboard.press("Space");
    await expect(strength).toBeChecked();
    await page.locator(".writing-sensitive-toggle input").check();
    await options.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".writing-submit-row")).toContainText("Sensitive context included.");
    await expect(source.locator("summary")).toHaveText("Existing draft added");
    await page.getByRole("button",{name:"Adapt draft",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.id)).toBe("writing-result-title");
    const second=await page.evaluate(()=>window.fixture.calls.filter(call=>call.type==='writing-generate')[1]);
    assert.deepEqual(second,{...first,sourceText:"Owned starting draft.",tone:"Concise",adaptationStrength:"strong",includeSensitive:true});
    await voice.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Add a sample you wrote")).toBeDisabled();
    await voice.locator("summary").focus(); await page.keyboard.press("Enter");
    assert.equal(await voice.evaluate(node=>node.open),false);
    assert.equal(await page.evaluate(()=>window.fixture.calls.some(call=>/configure|ingest|reset|send/.test(call.type))),false);
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.type==='writing-generate').length),2,"Disclosures and choices must not submit extra drafts.");
    assert.deepEqual(errors,[]);
    report.push({viewport,initialGeometry,keyboardDisclosure:"pass",retainedOptions:"pass",sensitiveDefaultAndExplicitOptIn:"pass",automaticRouting:"pass",resultFocusAndEditing:"pass",rendererErrors:errors});
    await page.close();
  }
  writeFileSync(join(output,"report.json"),JSON.stringify(report,null,2));
  console.log(`Writing Studio first-draft flow passed at ${report.length} viewports.`);
} catch(error) {
  await activePage?.screenshot({path:join(output,`failure-${Date.now()}.png`)}).catch(()=>{});
  const fields=await activePage?.locator(".writing-result-editor label").evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,field:node.querySelector('textarea,input')?.outerHTML}))).catch(()=>[]);
  console.error("Owned writing failure fields",JSON.stringify(fields));
  throw error;
} finally { await browser?.close(); await server.close(); rmSync(fixture,{recursive:true,force:true}); }
