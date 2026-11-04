import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { withPhoneBrowserInputFocus, type PhoneBrowserInputOptions } from '../PhoneBrowserInput';
import type { RpcResponse } from '../../../shared/rpc';
function fixture() {
  return {
    backend: () => 'builtin',
    clearViewport: vi.fn(async () => { /* noop */ }),
    nativeBounds: async () => ({width:1000,height:728}),
    scroll: vi.fn(async () => { /* noop */ }),
    input: (_id: number, operation: () => Promise<RpcResponse>) => operation(),
    targets: () => [
      { surfaceId: 'own', workspaceId: 'ws-1', webContentsId: 1, targetId: 'secret-cdp', wsUrl: 'ws://private' },
      { surfaceId: 'other', workspaceId: 'ws-2', webContentsId: 2, targetId: 'other', wsUrl: 'ws://other' },
    ],
    page: (id: number) => ({ title: 'Page', url: id === 1 ? 'http://user:password@localhost:3000/' : 'https://other.invalid' }),
    invoke: vi.fn(async (method: string): Promise<RpcResponse> => ({ id: 'rpc', ok: true, result: method === 'browser.evaluate' ? {value:{width:1000,height:728,scrollX:0,scrollY:0,scale:1}} : { data: 'aGVsbG8=', mimeType: 'image/jpeg' } })),
  };
}
describe('workspace browser preview boundary', () => {
  it('lists only owned HTTP pages without embedded credentials or debugger endpoints', async () => {
    const result = await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1' }, fixture());
    expect(result).toEqual({ pages: [{ id: 'own', title: 'Page', url: 'http://localhost:3000/' }] });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('password');
  });
  it('refuses capture from another workspace before invoking a browser operation', async () => {
    const deps = fixture();
    await expect(handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'other' }, deps)).rejects.toThrow('does not belong');
    expect(deps.invoke).not.toHaveBeenCalled();
  });
  it('uses fixed viewport options and ignores injected CDP arguments', async () => {
    const deps = fixture();
    await handlePhoneBrowser('browser.viewport', { workspaceId: 'ws-1', surfaceId: 'own', mode: 'mobile', headers: { Authorization: 'secret' }, expression: 'bad' }, deps);
    expect(deps.invoke).toHaveBeenCalledWith('browser.emulate', { workspaceId: 'ws-1', surfaceId: 'own', deviceMetrics: { width: 390, height: 728, deviceScaleFactor: 1, mobile: true, hasTouch: true, screenWidth: 390, screenHeight: 728 } });
    await handlePhoneBrowser('browser.viewport', { workspaceId: 'ws-1', surfaceId: 'own', mode: 'desktop' }, deps);
    expect(deps.invoke).toHaveBeenLastCalledWith('browser.emulate', { workspaceId: 'ws-1', surfaceId: 'own', deviceReset: true });
  });
  it.each(['javascript:alert(1)', 'file:///private/file', 'https://user:password@example.com'])('refuses non-web or credential-bearing navigation %s', async url => {
    const deps = fixture();
    await expect(handlePhoneBrowser('browser.navigate', { workspaceId: 'ws-1', surfaceId: 'own', url }, deps)).rejects.toThrow();
    expect(deps.invoke).not.toHaveBeenCalled();
  });
  it('rejects arbitrary evaluation and oversized images', async () => {
    const deps = fixture();
    await expect(handlePhoneBrowser('browser.evaluate', { workspaceId: 'ws-1', surfaceId: 'own' }, deps)).rejects.toThrow('Unsupported');
    deps.invoke.mockImplementation(async method => ({ id: 'rpc', ok: true, result: method === 'browser.evaluate' ? {value:{width:1000,height:728,scrollX:0,scrollY:0,scale:1}} : { data: 'x'.repeat(2 * 1024 * 1024 + 1), mimeType: 'image/jpeg' } }));
    await expect(handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'own' }, deps)).rejects.toThrow('too large for preview');
  });
  // The reply is one line on the daemon control pipe, which drops the connection
  // past 1 MiB. An oversized capture must cost the phone its preview, not the
  // desktop its daemon connection.
  it('retakes an oversized capture smaller before giving up', async () => {
    const deps = fixture();
    const geometry = {value:{width:1000,height:728,scrollX:0,scrollY:0,scale:1}};
    let shots = 0;
    deps.invoke.mockImplementation(async method => {
      if (method === 'browser.evaluate') return { id: 'rpc', ok: true, result: geometry };
      shots += 1;
      return { id: 'rpc', ok: true, result: { data: shots === 1 ? 'x'.repeat(800 * 1024) : 'aGVsbG8=', mimeType: 'image/jpeg' } };
    });
    const result = await handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'own' }, deps) as {data:string};
    expect(result.data).toBe('aGVsbG8=');
    const shotsOf = (mock: typeof deps.invoke) =>
      (mock.mock.calls as unknown as Array<[string, Record<string,unknown>]>).filter(call => call[0] === 'browser.screenshot');
    const screenshots = shotsOf(deps.invoke);
    expect(screenshots).toHaveLength(2);
    expect(screenshots[0][1]).toMatchObject({ quality: 65, scale: 0.75 });
    expect(screenshots[1][1]).toMatchObject({ quality: 50, scale: 0.5 });

    const stubborn = fixture();
    stubborn.invoke.mockImplementation(async method => ({ id: 'rpc', ok: true,
      result: method === 'browser.evaluate' ? geometry : { data: 'x'.repeat(800 * 1024), mimeType: 'image/jpeg' } }));
    await expect(handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'own' }, stubborn))
      .rejects.toThrow('Browser capture too large for preview');
    expect(shotsOf(stubborn.invoke)).toHaveLength(2);
  });
  it('limits keyboard input to owned unchanged pages and fixed operations', async () => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/'};
    await handlePhoneBrowser('browser.type',{...scope,text:'한글 input',expression:'bad'},deps);
    expect(deps.invoke).toHaveBeenLastCalledWith('browser.type.cdp',{workspaceId:'ws-1',surfaceId:'own',text:'한글 input'});
    await handlePhoneBrowser('browser.key',{...scope,key:'PageDown'},deps);
    expect(deps.invoke).toHaveBeenLastCalledWith('browser.press.cdp',{workspaceId:'ws-1',surfaceId:'own',key:'PageDown'});
    deps.invoke.mockClear();
    await expect(handlePhoneBrowser('browser.type',{...scope,text:'secret',expectedURL:'https://old.invalid/'},deps)).rejects.toThrow('page changed');
    await expect(handlePhoneBrowser('browser.type',{...scope,text:'x'.repeat(4097)},deps)).rejects.toThrow('Invalid');
    await expect(handlePhoneBrowser('browser.key',{...scope,key:'Control+l'},deps)).rejects.toThrow('Unsupported');
    await expect(handlePhoneBrowser('browser.type',{...scope,surfaceId:'other',text:'secret'},deps)).rejects.toThrow('does not belong');
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it.each(['navigation','ownership'])('rechecks %s after asynchronous focus setup', async change => {
    const deps = fixture();
    deps.input = async (_id,operation) => {
      if (change === 'navigation') deps.page = () => ({title:'Changed',url:'https://changed.invalid/'});
      else deps.targets = () => [];
      return operation();
    };
    await expect(handlePhoneBrowser('browser.type',{
      workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/',text:'private text',
    },deps)).rejects.toThrow('page changed');
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('binds a tap to the captured geometry and rejects viewport movement', async () => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own'};
    const capture = await handlePhoneBrowser('browser.capture',scope,deps) as {geometry:unknown;pageURL:string};
    await handlePhoneBrowser('browser.tap',{...scope,expectedURL:capture.pageURL,geometry:capture.geometry,x:0.5,y:0.25},deps);
    expect(deps.invoke).toHaveBeenLastCalledWith('browser.click.cdp',{...scope,x:500,y:182});
    await expect(handlePhoneBrowser('browser.tap',{...scope,expectedURL:capture.pageURL,geometry:{...capture.geometry as object,scrollY:1},x:0.5,y:0.25},deps)).rejects.toThrow('viewport changed');
  });

  it('creates only a new embedded tab in the named workspace', async () => {
    const deps = fixture();
    deps.targets = () => [];
    deps.invoke.mockResolvedValue({id:'rpc',ok:true,result:{ok:true,tab:{surfaceId:'new-browser'}}});
    expect(await handlePhoneBrowser('browser.open',{workspaceId:'ws-1',url:'https://example.com',partition:'forged',action:'close'},deps)).toEqual({surfaceId:'new-browser'});
    expect(deps.invoke).toHaveBeenCalledWith('browser.tabs',{workspaceId:'ws-1',action:'new',url:'https://example.com/'});
    deps.invoke.mockClear();
    deps.backend = () => 'external';
    await expect(handlePhoneBrowser('browser.open',{workspaceId:'ws-1',url:'https://example.com/'},deps)).rejects.toThrow('Embedded');
    expect(deps.invoke).not.toHaveBeenCalled();
  });
  it.each(['javascript:alert(1)','file:///private/file','https://user:secret@example.com'])('rejects unsafe new-page URL %s', async url => {
    const deps = fixture();
    await expect(handlePhoneBrowser('browser.open',{workspaceId:'ws-1',url},deps)).rejects.toThrow();
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('scrolls at the captured point with bounded viewport-relative deltas', async () => {
    const deps = fixture();
    const payload = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/',geometry:{width:1000,height:728,scrollX:0,scrollY:0},x:0.5,y:0.25,deltaX:0,deltaY:0.5};
    await handlePhoneBrowser('browser.scroll',payload,deps);
    expect(deps.scroll).toHaveBeenCalledWith(1,{x:500,y:182,deltaX:0,deltaY:364});
    deps.scroll.mockClear();
    await expect(handlePhoneBrowser('browser.scroll',{...payload,deltaY:2},deps)).rejects.toThrow('Invalid browser scroll');
    await expect(handlePhoneBrowser('browser.scroll',{...payload,geometry:{...payload.geometry,scrollY:1}},deps)).rejects.toThrow('viewport changed');
    expect(deps.scroll).not.toHaveBeenCalled();
  });

  it('keeps oversized captures viewable but refuses input after native guest shrink', async () => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own'};
    const before = await handlePhoneBrowser('browser.capture',scope,deps) as {geometry:unknown;pageURL:string};
    deps.nativeBounds = async () => ({width:800,height:468});
    const after = await handlePhoneBrowser('browser.capture',scope,deps) as {geometry?:unknown;data:string};
    expect(after.data).toBeTruthy();
    expect(after.geometry).toBeUndefined();
    await expect(handlePhoneBrowser('browser.tap',{...scope,expectedURL:before.pageURL,geometry:before.geometry,x:0.5,y:0.8},deps)).rejects.toThrow('input bounds');
    expect(deps.invoke.mock.calls.some(([method]) => method === 'browser.click.cdp')).toBe(false);
  });

  it('a capture leaves out a pageURL over 4096 characters, and its geometry, and stays inside the bridge allowance', async () => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own'};
    const at = (length: number) => { const base = 'https://a.example.com/?q='; return base + 'a'.repeat(length - base.length); };
    let url = at(4096);
    deps.page = () => ({title:'Long',url});
    expect(await handlePhoneBrowser('browser.capture',scope,deps)).toMatchObject({pageURL:url,geometry:{width:1000,height:728,scrollX:0,scrollY:0}});
    // A ~300 KiB URL (pushState can make one) beside the largest image a capture may carry.
    url = at(300 * 1024);
    deps.invoke.mockImplementation(async method => ({id:'rpc',ok:true,result:method === 'browser.evaluate'
      ? {value:{width:1000,height:728,scrollX:0,scrollY:0,scale:1}} : {data:'x'.repeat(700 * 1024),mimeType:'image/jpeg'}}));
    const result = await handlePhoneBrowser('browser.capture',scope,deps) as Record<string,unknown>;
    expect(result.data).toHaveLength(700 * 1024);
    expect(result).not.toHaveProperty('pageURL');
    expect(result).not.toHaveProperty('geometry');
    // The bridge's capture allowance covers the whole `daemon.phone.complete` envelope.
    expect(Buffer.byteLength(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000000',ok:true,result}))).toBeLessThanOrEqual(900 * 1024);
  });

});

/** Main's real input lock over a fake guest, so the focus order is main's own. */
function guest() {
  const events: string[] = [];
  const contents = {
    id: 1, isDestroyed: () => false, focus: vi.fn(() => { events.push('focus'); }),
    debugger: { sendCommand: vi.fn(async (method: string) => { events.push(method); return method === 'Runtime.evaluate' ? { result: { value: true } } : {}; }) },
  };
  const wc = contents as unknown as WebContents;
  return {
    events, contents, wc,
    input: (_id: number, operation: () => Promise<RpcResponse>, options?: PhoneBrowserInputOptions) => withPhoneBrowserInputFocus(wc, operation, options),
  };
}

const STREAM_KEYS = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Delete'];
const BASE_KEYS = ['Tab','Shift+Tab','Enter','Backspace','Escape','PageUp','PageDown'];
const live = {width:1000,height:728,scrollX:0,scrollY:0};
const pointed = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/',x:0.5,y:0.25};
const clicks = (deps: ReturnType<typeof fixture>) => deps.invoke.mock.calls.filter(([method]) => method === 'browser.click.cdp');

describe('workspace browser preview: stream input (stream:true)', () => {
  it.each(STREAM_KEYS)('presses %s on stream input only', async key => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/'};
    expect(await handlePhoneBrowser('browser.key',{...scope,key,stream:true},deps)).toEqual({applied:true});
    expect(deps.invoke).toHaveBeenLastCalledWith('browser.press.cdp',{workspaceId:'ws-1',surfaceId:'own',key});
    deps.invoke.mockClear();
    await expect(handlePhoneBrowser('browser.key',{...scope,key},deps)).rejects.toThrow('Unsupported browser key');
    // Anything but the boolean is no gate.
    await expect(handlePhoneBrowser('browser.key',{...scope,key,stream:'true'},deps)).rejects.toThrow('Unsupported browser key');
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('without the gate, the key list is exactly the base seven', async () => {
    const deps = fixture();
    const scope = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/'};
    for (const key of BASE_KEYS) expect(await handlePhoneBrowser('browser.key',{...scope,key},deps)).toEqual({applied:true});
    for (const key of [...STREAM_KEYS,'Control+l']) await expect(handlePhoneBrowser('browser.key',{...scope,key},deps)).rejects.toThrow('Unsupported browser key');
    expect(deps.invoke).toHaveBeenCalledTimes(BASE_KEYS.length);
  });

  it('an overlapping input is browser-input-busy, with nothing dispatched; without the gate, the old failure', async () => {
    const deps = fixture();
    const pane = guest();
    deps.input = pane.input;
    const typed = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/',text:'piece'};
    await withPhoneBrowserInputFocus(pane.wc, async () => {
      expect(await handlePhoneBrowser('browser.type',{...typed,stream:true},deps)).toEqual({error:'browser-input-busy'});
      expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:live,stream:true},deps)).toEqual({error:'browser-input-busy'});
      await expect(handlePhoneBrowser('browser.type',typed,deps)).rejects.toThrow('Browser input unavailable');
    });
    expect(deps.invoke.mock.calls.filter(([method]) => method !== 'browser.evaluate')).toEqual([]);
  });

  it('a viewport that moved since the frame is browser-viewport-changed; without the gate, the old failure', async () => {
    const deps = fixture();
    const moved = {...pointed,geometry:{...live,width:999}};
    expect(await handlePhoneBrowser('browser.tap',{...moved,stream:true},deps)).toEqual({error:'browser-viewport-changed'});
    expect(await handlePhoneBrowser('browser.scroll',{...moved,deltaX:0,deltaY:0.5,stream:true},deps)).toEqual({error:'browser-viewport-changed'});
    await expect(handlePhoneBrowser('browser.tap',moved,deps)).rejects.toThrow('Browser viewport changed; refresh before input');
    // A bad point is not a moved viewport.
    await expect(handlePhoneBrowser('browser.tap',{...pointed,x:1,geometry:live,stream:true},deps)).rejects.toThrow('Invalid browser point');
    expect(clicks(deps)).toEqual([]);
    expect(deps.scroll).not.toHaveBeenCalled();
  });

  it('a stream scroll ignores the scroll offset sent; a tap still checks it', async () => {
    const deps = fixture();
    const stale = {...live,scrollY:300};
    expect(await handlePhoneBrowser('browser.scroll',{...pointed,geometry:stale,deltaX:0.1,deltaY:0.5,stream:true},deps)).toEqual({applied:true});
    expect(deps.scroll).toHaveBeenCalledWith(1,{x:500,y:182,deltaX:100,deltaY:364});
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:stale,stream:true},deps)).toEqual({error:'browser-viewport-changed'});
    expect(clicks(deps)).toEqual([]);
    // Without the gate a scroll is as strict as a tap.
    deps.scroll.mockClear();
    await expect(handlePhoneBrowser('browser.scroll',{...pointed,geometry:stale,deltaX:0,deltaY:0.5},deps)).rejects.toThrow('viewport changed');
    expect(deps.scroll).not.toHaveBeenCalled();
  });

  it('a builtin pane: the 409 is decided before anything focuses or raises the tab', async () => {
    const deps = fixture();
    const pane = guest();
    deps.input = pane.input;
    // The viewport moves after the first check, before the recheck under the lock.
    let probes = 0;
    deps.invoke.mockImplementation(async method => ({id:'rpc',ok:true,result:method === 'browser.evaluate'
      ? {value:{...live,scrollY:probes++ === 0 ? 0 : 5,scale:1}} : {ok:true}}));
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:live,stream:true},deps)).toEqual({error:'browser-viewport-changed'});
    expect(probes).toBe(2);
    expect(pane.contents.focus).not.toHaveBeenCalled();
    expect(pane.events).toEqual([]);
    expect(clicks(deps)).toEqual([]);
    // The viewport moves while the tab is focused: still a 409, and no tap goes out.
    probes = 0;
    deps.invoke.mockImplementation(async method => ({id:'rpc',ok:true,result:method === 'browser.evaluate'
      ? {value:{...live,scrollY:probes++ < 2 ? 0 : 5,scale:1}} : {ok:true}}));
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:live,stream:true},deps)).toEqual({error:'browser-viewport-changed'});
    expect(probes).toBe(3);
    expect(pane.events.slice(0,2)).toEqual(['focus','Page.bringToFront']);
    expect(clicks(deps)).toEqual([]);
    pane.events.length = 0;
    // A tap that matches: checked, then focused, then dispatched.
    deps.invoke.mockImplementation(async method => ({id:'rpc',ok:true,result:method === 'browser.evaluate' ? {value:{...live,scale:1}} : {ok:true}}));
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:live,stream:true},deps)).toEqual({applied:true});
    expect(pane.events.slice(0,2)).toEqual(['focus','Page.bringToFront']);
    expect(clicks(deps)).toEqual([['browser.click.cdp',{workspaceId:'ws-1',surfaceId:'own',x:500,y:182}]]);
  });

  it('a streamed builtin pane maps by the latest frame\'s geometry, within a pixel of the live scroll, and still refuses a viewport past the widget', async () => {
    const deps = fixture();
    // The frame's metadata at a fractional offset; the live viewport a quarter pixel on, the probe somewhere else entirely.
    const frame = {width:1000,height:728,scrollX:0,scrollY:123.5};
    let viewport = {clientWidth:1000,clientHeight:728,pageX:0,pageY:123.25,scale:1,zoom:1};
    const view = {url:'http://localhost:3000/',docUrls:new Set(['http://localhost:3000/']),geometry:frame as typeof frame | null};
    const streamed = {...deps,
      layoutMetrics: vi.fn(async () => ({cssVisualViewport:viewport})),
      streams: {tab: (surfaceId: string, workspaceId: string) => surfaceId === 'own' && workspaceId === 'ws-1' ? view : null},
    };
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:frame,stream:true},streamed)).toEqual({applied:true});
    expect(clicks(deps)).toEqual([['browser.click.cdp',{workspaceId:'ws-1',surfaceId:'own',x:500,y:182}]]);
    expect(await handlePhoneBrowser('browser.scroll',{...pointed,geometry:frame,deltaX:0,deltaY:0.5,stream:true},streamed)).toEqual({applied:true});
    expect(deps.scroll).toHaveBeenCalledWith(1,{x:500,y:182,deltaX:0,deltaY:364});
    // A frame at another zoom carried no geometry: the sent one is checked live, and moved.
    view.geometry = null;
    viewport = {...viewport,zoom:1.25};
    expect(await handlePhoneBrowser('browser.tap',{...pointed,geometry:frame,stream:true},streamed)).toEqual({error:'browser-viewport-changed'});
    // An emulated viewport wider than the pane: the capture's own refusal, nothing dispatched.
    view.geometry = frame;
    viewport = {...viewport,zoom:1,clientWidth:1920};
    await expect(handlePhoneBrowser('browser.tap',{...pointed,geometry:frame,stream:true},streamed)).rejects.toThrow('exceeds visible input bounds');
    expect(clicks(deps)).toHaveLength(1);
    // Without the gate (no stream view) the probe decides, as before.
    await expect(handlePhoneBrowser('browser.tap',{...pointed,geometry:frame},streamed)).rejects.toThrow('viewport changed');
  });

  describe('history', () => {
    const plain = {workspaceId:'ws-1',surfaceId:'own',expectedURL:'http://localhost:3000/',direction:'back'};
    const asked = {...plain,stream:true};
    function withHistory(url: string | null) {
      const go = vi.fn();
      const deps = {...fixture(),
        historyEntry: vi.fn<(id: number, offset: -1 | 1) => {url:string;go:() => void} | null>(() => (url === null ? null : {url,go})),
        validateNavigation: vi.fn<(url: string) => Promise<void>>(async () => undefined)};
      return {deps,go};
    }

    it('goes one entry back or forward, through the navigation policy', async () => {
      const {deps,go} = withHistory('https://prev.example.com/a');
      expect(await handlePhoneBrowser('browser.history',asked,deps)).toEqual({applied:true});
      expect(deps.historyEntry).toHaveBeenLastCalledWith(1,-1);
      expect(deps.validateNavigation).toHaveBeenCalledWith('https://prev.example.com/a');
      expect(go).toHaveBeenCalledTimes(1);
      expect(await handlePhoneBrowser('browser.history',{...asked,direction:'forward'},deps)).toEqual({applied:true});
      expect(deps.historyEntry).toHaveBeenLastCalledWith(1,1);
    });

    it('nothing to go to is applied:false', async () => {
      const {deps} = withHistory(null);
      expect(await handlePhoneBrowser('browser.history',asked,deps)).toEqual({applied:false});
      expect(deps.validateNavigation).not.toHaveBeenCalled();
    });

    it.each(['file:///private/file','chrome://settings/','about:blank'])('refuses an entry that is not an http(s) page: %s', async url => {
      const {deps,go} = withHistory(url);
      await expect(handlePhoneBrowser('browser.history',asked,deps)).rejects.toThrow('Only HTTP');
      expect(deps.validateNavigation).not.toHaveBeenCalled();
      expect(go).not.toHaveBeenCalled();
    });

    it('an entry the navigation policy refuses is not gone to', async () => {
      const {deps,go} = withHistory('http://10.0.0.1/admin');
      deps.validateNavigation.mockRejectedValue(new Error('Navigation refused'));
      await expect(handlePhoneBrowser('browser.history',asked,deps)).rejects.toThrow('Navigation refused');
      expect(go).not.toHaveBeenCalled();
    });

    it('runs the owner and expectedURL checks first, and exists only on stream input', async () => {
      const {deps} = withHistory('https://prev.example.com/');
      await expect(handlePhoneBrowser('browser.history',{...asked,expectedURL:'https://old.invalid/'},deps)).rejects.toThrow('page changed');
      await expect(handlePhoneBrowser('browser.history',{...asked,surfaceId:'other'},deps)).rejects.toThrow('does not belong');
      await expect(handlePhoneBrowser('browser.history',{...asked,direction:'up'},deps)).rejects.toThrow('Invalid browser history');
      await expect(handlePhoneBrowser('browser.history',plain,deps)).rejects.toThrow('Unsupported browser operation');
      expect(deps.historyEntry).not.toHaveBeenCalled();
      // A pane that moved while the input waited for focus.
      deps.input = async (_id,operation) => { deps.page = () => ({title:'Changed',url:'https://changed.invalid/'}); return operation(); };
      await expect(handlePhoneBrowser('browser.history',asked,deps)).rejects.toThrow('page changed');
      expect(deps.historyEntry).not.toHaveBeenCalled();
    });
  });
});
