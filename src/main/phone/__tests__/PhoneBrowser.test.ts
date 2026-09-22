import { describe, expect, it, vi } from 'vitest';
import { handlePhoneBrowser } from '../PhoneBrowser';
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

});
