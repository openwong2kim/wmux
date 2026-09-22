import { PHONE_BROWSER_GEOMETRY, phoneBrowserGeometry, phoneBrowserPoint } from './PhoneBrowserGeometry';
import type { CdpTargetInfo } from '../browser-session/WebviewCdpManager';
import type { RpcResponse } from '../../shared/rpc';

interface BrowserDeps {
  backend: () => string;
  clearViewport: (webContentsId: number) => Promise<void>;
  nativeBounds: (webContentsId: number) => Promise<{width:number;height:number}>;
  scroll: (webContentsId: number, event: {x:number;y:number;deltaX:number;deltaY:number}) => Promise<void>;
  targets: () => CdpTargetInfo[];
  page: (webContentsId: number) => { title: string; url: string } | null;
  input: (webContentsId: number, operation: () => Promise<RpcResponse>) => Promise<RpcResponse>;
  invoke: (method: string, params: Record<string, unknown>) => Promise<RpcResponse>;
}
/** 700 KiB of base64, so the whole `daemon.phone.complete` envelope stays under
 * the daemon control pipe's 1 MiB per-line limit. */
const CAPTURE_BASE64_LIMIT = 700 * 1024;
function pageURL(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = ''; url.password = '';
    return url.href;
  } catch { return null; }
}

/** Workspace-bound preview, with a closed set of browser operations. */
export async function handlePhoneBrowser(command: string, payload: Record<string, unknown>, deps: BrowserDeps): Promise<unknown> {
  const workspaceId = payload.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('Missing workspace');
  const targets = deps.targets().filter(target => target.workspaceId === workspaceId);
  if (command === 'browser.open') {
    if (deps.backend() !== 'builtin') throw new Error('Embedded browser backend required');
    if (typeof payload.url !== 'string' || payload.url.length > 4096) throw new Error('Invalid URL');
    const url = new URL(payload.url);
    if (!pageURL(payload.url) || url.username || url.password) throw new Error('Only HTTP URLs without embedded credentials are supported');
    const opened = await deps.invoke('browser.tabs',{workspaceId,action:'new',url:url.href});
    if (!opened.ok) throw new Error('Browser creation unconfirmed');
    const result = opened.result as {ok?:unknown;tab?:{surfaceId?:unknown}} | undefined;
    if (result?.ok !== true || typeof result.tab?.surfaceId !== 'string' || !result.tab.surfaceId) throw new Error('Browser creation unconfirmed');
    return {surfaceId:result.tab.surfaceId};
  }

  if (command === 'browser.list') {
    return { pages: targets.slice(0, 30).flatMap(target => {
      const page = deps.page(target.webContentsId);
      const url = page && pageURL(page.url);
      return page && url ? [{ id: target.surfaceId, title: page.title.slice(0, 200), url }] : [];
    }) };
  }
  if (!['browser.capture','browser.viewport','browser.navigate','browser.type','browser.key','browser.tap','browser.scroll'].includes(command)) throw new Error('Unsupported browser operation');
  if (typeof payload.surfaceId !== 'string') throw new Error('Missing surface');
  const target = targets.find(target => target.surfaceId === payload.surfaceId);
  if (!target) throw new Error('Browser does not belong to workspace');
  const current = deps.page(target.webContentsId);
  if (!current || !pageURL(current.url)) throw new Error('Only HTTP browser previews are supported');
  const scope = { surfaceId: target.surfaceId, workspaceId };
  let result: RpcResponse;
  const geometry = async () => {
    const page = phoneBrowserGeometry(await deps.invoke('browser.evaluate',{...scope,expression:PHONE_BROWSER_GEOMETRY}));
    const native = await deps.nativeBounds(target.webContentsId);
    if (page.width > native.width + 1 || page.height > native.height + 1) throw new Error('Browser viewport exceeds visible input bounds; reset viewport');
    return page;
  };
  if (command === 'browser.capture') {
    const before = await geometry().catch(() => null);
    const shoot = async (quality: number, scale: number) => {
      const response = await deps.invoke('browser.screenshot', { ...scope, format: 'jpeg', quality, scale, fullPage: false });
      if (!response.ok || !response.result || typeof response.result !== 'object') throw new Error('Browser capture unavailable');
      const shot = response.result as {data?:unknown;mimeType?:unknown};
      if (typeof shot.data !== 'string' || shot.mimeType !== 'image/jpeg') throw new Error('Browser capture exceeds preview limit');
      return shot as {data:string;mimeType:'image/jpeg'};
    };
    let capture = await shoot(65, 0.75);
    // The reply travels as ONE line on the daemon control pipe, whose reader
    // drops the connection past MAX_LINE_BUFFER (1 MiB, DaemonPipeServer.ts).
    // A capture that fits an old 2 MiB check therefore cost the desktop its
    // daemon connection rather than the phone a preview. Keep the base64 far
    // enough under the line limit that the rest of the envelope still fits;
    // if the first shot is over, retake once smaller, then give up in words.
    if (capture.data.length > CAPTURE_BASE64_LIMIT) capture = await shoot(50, 0.5);
    if (capture.data.length > CAPTURE_BASE64_LIMIT) throw new Error('Browser capture too large for preview');
    const after = await geometry().catch(() => null);
    let capturedGeometry;
    if (before && after) {
      try { phoneBrowserPoint(0,0,before,after); capturedGeometry = after; } catch { /* Preview remains readable, but cannot be tapped. */ }
    }
    const page = deps.page(target.webContentsId);
    if (!page || pageURL(page.url) !== pageURL(current.url)) throw new Error('Browser page changed during capture');
    return { data: capture.data, mimeType: 'image/jpeg', capturedAt: Date.now(), geometry:capturedGeometry, pageURL:pageURL(page.url) };
  }
  if (command === 'browser.viewport') {
    if (payload.mode !== 'mobile' && payload.mode !== 'desktop') throw new Error('Invalid viewport');
    result = await deps.invoke('browser.emulate', {...scope,deviceReset:true});
    if (!result.ok) throw new Error('Browser viewport reset failed');
    // Discard the RPC's remembered pre-preset dimensions: the native widget
    // may have been resized since that snapshot.
    await deps.clearViewport(target.webContentsId);
    if (payload.mode === 'mobile') {
      // A viewport taller than the Electron guest can capture pixels outside
      // its input hit-test bounds. Fit the mobile viewport to the real guest.
      const available = await deps.nativeBounds(target.webContentsId);
      const width = Math.min(390,Math.floor(available.width));
      const height = Math.min(844,Math.floor(available.height));
      result = await deps.invoke('browser.emulate', {...scope,deviceMetrics:{
        width,height,deviceScaleFactor:1,mobile:true,hasTouch:true,screenWidth:width,screenHeight:height,
      }});
    }
  } else if (command === 'browser.type' || command === 'browser.key' || command === 'browser.tap' || command === 'browser.scroll') {
    if (typeof payload.expectedURL !== 'string' || payload.expectedURL !== pageURL(current.url)) throw new Error('Browser page changed; refresh before input');
    const input = (method: string, args: Record<string,unknown>) => deps.input(target.webContentsId, async () => {
      const owned = deps.targets().some(item => item.surfaceId === target.surfaceId && item.webContentsId === target.webContentsId && item.workspaceId === workspaceId);
      const page = deps.page(target.webContentsId);
      if (!owned || !page || pageURL(page.url) !== payload.expectedURL) throw new Error('Browser page changed; refresh before input');
      if (command === 'browser.tap' || command === 'browser.scroll') {
        phoneBrowserPoint(payload.x,payload.y,payload.geometry,await geometry());
        const latest = deps.page(target.webContentsId);
        if (!latest || pageURL(latest.url) !== payload.expectedURL || !deps.targets().some(item => item.surfaceId === target.surfaceId && item.webContentsId === target.webContentsId && item.workspaceId === workspaceId)) throw new Error('Browser page changed; refresh before input');
      }
      if (method === 'phone.scroll') {
        await deps.scroll(target.webContentsId,args as {x:number;y:number;deltaX:number;deltaY:number});
        return {id:'phone-scroll',ok:true,result:{applied:true}};
      }
      return deps.invoke(method,{...scope,...args});
    });
    if (command === 'browser.tap' || command === 'browser.scroll') {
      const point = phoneBrowserPoint(payload.x,payload.y,payload.geometry,await geometry());
      if (command === 'browser.scroll') {
        if (typeof payload.deltaX !== 'number' || !Number.isFinite(payload.deltaX) || Math.abs(payload.deltaX) > 1 ||
            typeof payload.deltaY !== 'number' || !Number.isFinite(payload.deltaY) || Math.abs(payload.deltaY) > 1) throw new Error('Invalid browser scroll');
        const size = payload.geometry as {width:number;height:number};
        result = await input('phone.scroll',{...point,deltaX:payload.deltaX * size.width,deltaY:payload.deltaY * size.height});
      } else result = await input('browser.click.cdp',point);
    } else if (command === 'browser.type') {
      // eslint-disable-next-line no-control-regex
      if (typeof payload.text !== 'string' || !payload.text || payload.text.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload.text)) throw new Error('Invalid browser text');
      result = await input('browser.type.cdp', {text:payload.text});
    } else {
      if (!['Tab','Shift+Tab','Enter','Backspace','Escape','PageUp','PageDown'].includes(payload.key as string)) throw new Error('Unsupported browser key');
      result = await input('browser.press.cdp', {key:payload.key});
    }
  } else {
    if (typeof payload.url !== 'string' || payload.url.length > 4096) throw new Error('Invalid URL');
    const url = new URL(payload.url);
    if (!pageURL(payload.url) || url.username || url.password) throw new Error('Only HTTP URLs without embedded credentials are supported');
    result = await deps.invoke('browser.navigate', { ...scope, url: url.href });
  }
  if (!result.ok) throw new Error('Browser operation failed');
  return { applied: true };
}
