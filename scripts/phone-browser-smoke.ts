/** Real Electron webview proof for the phone preview path, isolated from wmux data. */
import { app, BrowserWindow, nativeImage, type WebContents } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { RpcRouter } from '../src/main/pipe/RpcRouter';
import { registerBrowserRpc } from '../src/main/pipe/handlers/browser.rpc';
import { withPhoneBrowserInputFocus, dispatchPhoneBrowserScroll, phoneBrowserNativeBounds } from '../src/main/phone/PhoneBrowserInput';
import { handlePhoneBrowser } from '../src/main/phone/PhoneBrowser';
import { createPhoneBrowserStreams } from '../src/main/phone/PhoneBrowserStream';
import type { RpcMethod } from '../src/shared/rpc';

const root = process.env.WMUX_PHONE_SMOKE_DIR;
if (!root) throw new Error('Run through scripts/run-phone-browser-smoke.mjs');
app.setPath('userData', path.join(root, 'electron-data'));
const timeout = setTimeout(() => { console.error('Phone browser smoke timed out'); app.exit(1); }, 60000);
let window: BrowserWindow | undefined;
let server: http.Server | undefined;

async function run() {
  await app.whenReady();
  server = http.createServer((_req,res) => {
    res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Phone preview fixture</title><style>body{min-height:3000px;margin:0;background:#ece9e3;color:#242424;font:28px system-ui;padding:32px}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{background:#d0dadf;padding:24px}h1{font-size:42px}@media(max-width:500px){main{grid-template-columns:1fr}h1{font-size:30px}}</style><h1>Workspace preview</h1><main><article>Desktop and mobile layout</article><article>Same page, real webview</article></main><input id="entry" aria-label="Test input"><button id="submit" onclick="this.dataset.clicked=String(Number(this.dataset.clicked||0)+1)">Submit</button><div id="nested" style="position:fixed;left:10px;bottom:10px;width:160px;height:140px;overflow:auto;background:white;font-size:16px"><div style="height:1000px">Nested scroll area</div></div>');
  });
  await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  const port = (server.address() as {port:number}).port;
  const url = `http://127.0.0.1:${port}/`;
  window = new BrowserWindow({ width:1000,height:760,show:false,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false} });
  const guestReady = new Promise<WebContents>(resolve => {
    window!.webContents.once('did-attach-webview',(_event,guest) => {
      guest.once('did-finish-load',() => resolve(guest));
    });
  });
  await window.loadURL('data:text/html,'+encodeURIComponent(`<style>html,body{margin:0;height:100%}webview{width:100%;height:100%}</style><webview src="${url}"></webview>`));
  window.showInactive();
  const guest = await guestReady;
  guest.debugger.attach('1.3');
  await new Promise(resolve => setTimeout(resolve,250));
  const target = {surfaceId:'preview-fixture',workspaceId:'ws-fixture',webContentsId:guest.id,targetId:'fixture',wsUrl:''};
  // The registry is a fixture; rendering, CDP, screenshots and viewport reset are real.
  const registry = {
    getTarget: (id?:string,workspace?:string) => (!id || id === target.surfaceId) && (!workspace || workspace === target.workspaceId) ? target : null,
    listTargets: () => [target], getCdpPort: () => 0,
    ensureAwake: async () => null, setCaptureCleanup: () => { /* noop */ }, setCaptureAttach: () => { /* noop */ },
    withAutomationLease: async (_id:string,fn:()=>Promise<unknown>) => fn(),
    acquireRpcLease: () => 'fixture', renewRpcLease: () => true, releaseRpcLease: () => true,
  };
  const router = new RpcRouter();
  registerBrowserRpc(router,() => window!,registry as never,undefined,undefined,() => 'enforce');
  const deps = {
    backend: () => 'builtin',
    clearViewport: async () => { await guest.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); },
    nativeBounds: () => phoneBrowserNativeBounds(guest),
    scroll: async (_id:number,event:{x:number;y:number;deltaX:number;deltaY:number}) => { await dispatchPhoneBrowserScroll(guest,event); },
    input: (_id:number, operation: () => Promise<import('../src/shared/rpc').RpcResponse>) => withPhoneBrowserInputFocus(guest,operation),
    targets: () => [target], page: () => ({title:guest.getTitle(),url:guest.getURL()}),
    invoke: (method:string,params:Record<string,unknown>) => router.dispatch({id:'phone-smoke',method:method as RpcMethod,params},{operator:true}),
  };
  const payload = {workspaceId:'ws-fixture',surfaceId:'preview-fixture'};
  assert.deepEqual(await handlePhoneBrowser('browser.list',payload,deps), {
    pages: [{id:target.surfaceId,title:'Phone preview fixture',url}],
  });
  const viewport = () => guest.executeJavaScript('({width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints})');
  const before = await viewport();
  assert(before.width > 500);
  const capture = async (name:string) => {
    const result = await handlePhoneBrowser('browser.capture',payload,deps) as {data:string;mimeType:string};
    assert.equal(result.mimeType,'image/jpeg');
    const bytes = Buffer.from(result.data,'base64');
    const dimensions = nativeImage.createFromBuffer(bytes).getSize();
    assert(dimensions.width > 100 && dimensions.height > 100);
    fs.writeFileSync(path.join(root,`${name}.jpg`),bytes);
    return dimensions;
  };
  const desktop = await capture('desktop');
  await handlePhoneBrowser('browser.viewport',{...payload,mode:'mobile'},deps);
  const mobileViewport = await viewport();
  assert.equal(mobileViewport.width,Math.min(390,before.width));
  assert.equal(mobileViewport.height,Math.min(844,before.height));
  const mobile = await capture('mobile');
  const mobileCapture = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:{width:number;height:number};pageURL:string};
  const mobilePoint = await guest.executeJavaScript('(() => {const r=document.querySelector("#submit").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await handlePhoneBrowser('browser.tap',{...payload,expectedURL:mobileCapture.pageURL,geometry:mobileCapture.geometry,x:mobilePoint.x/mobileCapture.geometry.width,y:mobilePoint.y/mobileCapture.geometry.height},deps);
  assert.equal(await guest.executeJavaScript('document.querySelector("#submit").dataset.clicked'),'1');
  await handlePhoneBrowser('browser.viewport',{...payload,mode:'desktop'},deps);
  const restored = await viewport();
  assert.equal(restored.width,before.width);
  assert.equal(restored.height,before.height);
  assert.equal(restored.touch,before.touch);
  await capture('restored');
  const destination = `${url}?navigation=verified`;
  const navigated = new Promise<void>(resolve => guest.once('did-finish-load',() => resolve()));
  await handlePhoneBrowser('browser.navigate',{...payload,url:destination},deps);
  await navigated;
  assert.equal(guest.getURL(),destination);
  const keyboardScope = {...payload,expectedURL:destination};
  const tapCapture = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:{width:number;height:number;scrollX:number;scrollY:number};pageURL:string};
  const point = await guest.executeJavaScript('(() => {const r=document.querySelector("#submit").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await handlePhoneBrowser('browser.tap',{...payload,expectedURL:tapCapture.pageURL,geometry:tapCapture.geometry,x:point.x/tapCapture.geometry.width,y:point.y/tapCapture.geometry.height},deps);
  assert.equal(await guest.executeJavaScript('document.querySelector("#submit").dataset.clicked'),'1');
  // Restore keyboard traversal from the start after proving pointer activation.
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'Shift+Tab'},deps);

  assert.equal(await guest.executeJavaScript('document.activeElement.id'),'entry');
  await handlePhoneBrowser('browser.type',{...keyboardScope,text:'한글 input'},deps);
  assert.equal(await guest.executeJavaScript('document.querySelector("#entry").value'),'한글 input');
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'Backspace'},deps);
  assert.equal(await guest.executeJavaScript('document.querySelector("#entry").value'),'한글 inpu');
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'Tab'},deps);
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'Enter'},deps);
  assert.equal(await guest.executeJavaScript('document.querySelector("#submit").dataset.clicked'),'2');
  await assert.rejects(handlePhoneBrowser('browser.type',{...keyboardScope,expectedURL:url,text:'stale'},deps));
  const waitForScroll = async (predicate: (offset:number) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const offset = await guest.executeJavaScript('scrollY') as number;
      if (predicate(offset)) return offset;
      await new Promise(resolve => setTimeout(resolve,20));
    }
    throw new Error('Page key did not move the real viewport');
  };
  const scrollBefore = await guest.executeJavaScript('scrollY') as number;
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'PageDown'},deps);
  const scrollDown = await waitForScroll(offset => offset > scrollBefore + 100);
  await handlePhoneBrowser('browser.key',{...keyboardScope,key:'PageUp'},deps);
  await waitForScroll(offset => offset < scrollDown - 50);
  const settleScroll = () => guest.executeJavaScript('new Promise(resolve => {let last=scrollY,stable=0;function step(){const now=scrollY;stable=now===last?stable+1:0;last=now;if(stable>=8)resolve(now);else requestAnimationFrame(step)}requestAnimationFrame(step)})');
  const wheel = async () => {
    await settleScroll();
    const preview = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:{scrollY:number};pageURL:string};
    assert(preview.geometry);
    await handlePhoneBrowser('browser.scroll',{...payload,expectedURL:preview.pageURL,geometry:preview.geometry,x:0.5,y:0.5,deltaX:0,deltaY:0.5},deps);
    await waitForScroll(offset => offset > preview.geometry.scrollY + 50);
  };
  await wheel();
  await handlePhoneBrowser('browser.viewport',{...payload,mode:'mobile'},deps);
  await wheel();
  await settleScroll();
  const nestedCapture = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:{width:number;height:number;scrollY:number};pageURL:string};
  const nestedPoint = await guest.executeJavaScript('(() => {const r=document.querySelector("#nested").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await handlePhoneBrowser('browser.scroll',{...payload,expectedURL:nestedCapture.pageURL,geometry:nestedCapture.geometry,x:nestedPoint.x/nestedCapture.geometry.width,y:nestedPoint.y/nestedCapture.geometry.height,deltaX:0,deltaY:0.25},deps);
  const nestedDeadline = Date.now()+3000;
  while (await guest.executeJavaScript('document.querySelector("#nested").scrollTop') <= 50) {
    if (Date.now() > nestedDeadline) throw new Error('Nested scroll target did not move: '+JSON.stringify(await guest.executeJavaScript('({root:scrollY,nested:document.querySelector("#nested").scrollTop})')));
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.equal(await guest.executeJavaScript('scrollY'),nestedCapture.geometry.scrollY);
  const beforeResize = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:unknown;pageURL:string};
  window.setSize(800,500);
  const resizeDeadline = Date.now()+3000;
  while ((await phoneBrowserNativeBounds(guest)).height >= before.height) {
    if (Date.now() > resizeDeadline) throw new Error('Native guest did not resize');
    await new Promise(resolve => setTimeout(resolve,20));
  }
  const afterResize = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry?:unknown;data:string};
  assert(afterResize.data);
  assert.equal(afterResize.geometry,undefined);
  await assert.rejects(handlePhoneBrowser('browser.tap',{...payload,expectedURL:beforeResize.pageURL,geometry:beforeResize.geometry,x:0.5,y:0.9},deps));
  await handlePhoneBrowser('browser.viewport',{...payload,mode:'mobile'},deps);
  const refitted = await handlePhoneBrowser('browser.capture',payload,deps) as {geometry:{height:number}};
  assert(refitted.geometry.height <= 468);
  await handlePhoneBrowser('browser.viewport',{...payload,mode:'desktop'},deps);
  const resizedDesktop = await viewport();
  assert.equal(resizedDesktop.width,800);
  assert.equal(resizedDesktop.height,468);
  // The live stream of this pane (PhoneBrowserStream's builtin source) over
  // the real debugger. The daemon is a recorder and the renderer's
  // visibility reports are the fixture's.
  const pushes: Array<Record<string, unknown>> = [];
  let shown = true;
  const observers = new Set<(surfaceId: string, visible: boolean) => void>();
  const report = (value: boolean) => { shown = value; for (const observer of [...observers]) observer(target.surfaceId, value); };
  const streams = createPhoneBrowserStreams({
    push: async params => { pushes.push(params); return {ok:true,known:true}; },
    backend: () => 'builtin',
    builtin: {
      targets: () => [target], contents: id => id === guest.id && !guest.isDestroyed() ? guest : null,
      visible: () => shown, onVisibility: listener => { observers.add(listener); return () => { observers.delete(listener); }; },
      nativeBounds: contents => phoneBrowserNativeBounds(contents),
    },
  });
  type StreamFrame = {pageURL?:string;geometry?:{width:number;height:number;scrollX:number;scrollY:number}};
  const frames = () => pushes.filter(push => push.kind === 'frame') as StreamFrame[];
  const until = async <T>(read: () => T | undefined | null | false, what: string): Promise<T> => {
    const deadline = Date.now()+5000;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Stream: no ${what}: ${JSON.stringify(pushes.map(push => ({...push,data:undefined})))}`);
      await new Promise(resolve => setTimeout(resolve,20));
    }
  };
  const streamDeps = {...deps,streams,
    layoutMetrics: () => guest.debugger.sendCommand('Page.getLayoutMetrics'),
    input: (_id:number, operation: () => Promise<import('../src/shared/rpc').RpcResponse>, options?: import('../src/main/phone/PhoneBrowserInput').PhoneBrowserInputOptions) => withPhoneBrowserInputFocus(guest,operation,options),
  };
  // A fractional offset on a still page.
  await guest.executeJavaScript('window.scrollTo(0,123.5); 0');
  await settleScroll();
  assert.deepEqual(await streams.handle('browser.streamStart',{workspaceId:'ws-fixture',surfaceId:target.surfaceId,streamId:'smoke',maxFps:10}),{backend:'builtin',maxWidth:1280,maxHeight:1280,quality:60});
  const first = await until(() => frames()[0],'first frame on a still page');
  // The frame's geometry is the capture probe's own, scroll offset included.
  const probed = await guest.executeJavaScript('({width:innerWidth,height:innerHeight,scrollX,scrollY})');
  assert.deepEqual(first.geometry,probed);
  const clicks = () => guest.executeJavaScript('Number(document.querySelector("#submit").dataset.clicked||0)') as Promise<number>;
  const clickedBefore = await clicks();
  const streamPoint = await guest.executeJavaScript('(() => {const r=document.querySelector("#submit").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  const tapAt = (frame: StreamFrame) => ({...payload,stream:true,expectedURL:frame.pageURL,geometry:frame.geometry,x:streamPoint.x/frame.geometry!.width,y:streamPoint.y/frame.geometry!.height});
  assert.deepEqual(await handlePhoneBrowser('browser.tap',tapAt(first),streamDeps),{applied:true});
  assert.equal(await clicks(),clickedBefore+1);
  // A same-document move: a url event, and a tap at the earlier URL is a 409.
  await guest.executeJavaScript('history.pushState(null,"","?route=1"); 0');
  await until(() => pushes.some(push => push.kind === 'url' && String(push.pageURL).endsWith('?route=1')),'url event on pushState');
  assert.deepEqual(await handlePhoneBrowser('browser.tap',tapAt(first),streamDeps),{error:'browser-page-changed'});
  // At 125 % the metadata is not in the page's CSS pixels: no geometry.
  guest.setZoomFactor(1.25);
  await guest.executeJavaScript('window.scrollTo(0,300); 0');
  const zoomedFrom = frames().length;
  const zoomed = await until(() => frames().length > zoomedFrom && frames().at(-1),'frame at 125 %');
  assert.equal(zoomed.geometry,undefined);
  guest.setZoomFactor(1);
  // Off screen and back, as the renderer reports it.
  await window.webContents.executeJavaScript('document.querySelector("webview").style.display="none"; 0');
  report(false);
  await until(() => pushes.some(push => push.kind === 'state' && push.state === 'hidden'),'state hidden');
  await window.webContents.executeJavaScript('document.querySelector("webview").style.display=""; 0');
  report(true);
  await until(() => { const at = pushes.findIndex(push => push.kind === 'state' && push.state === 'live'); return at >= 0 && pushes.slice(at+1).some(push => push.kind === 'frame'); },'state live and a frame');
  // The pane closes: its debugger lets go before the guest is destroyed, and the end says gone.
  await window.webContents.executeJavaScript('document.querySelector("webview").remove(); 0');
  const ended = await until(() => pushes.find(push => push.kind === 'end'),'end on close');
  assert.equal(ended.error,'browser-tab-gone');
  assert.equal(pushes.filter(push => push.kind === 'end').length,1);
  const result = {before,mobileViewport,restored,desktop,mobile,navigationVerified:true,keyboardVerified:true,pageScrollVerified:true,pointerVerified:true,mobileTouchVerified:true,desktopAndMobileWheelVerified:true,nestedScrollVerified:true,nativeResizeGuardVerified:true,streamVerified:true};
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,artifactDirectory:root,...result}));
}
run().then(() => {
  clearTimeout(timeout); window?.destroy(); server?.close(); app.exit(0);
}).catch(error => {
  clearTimeout(timeout); console.error(error); window?.destroy(); server?.close(); app.exit(1);
});
