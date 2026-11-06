// The pipe transport answers the launcher's requests with the CDP command
// each /json route stands for, in the shape the launcher reads from the port.
import { describe, expect, it } from 'vitest';
import { CdpPipeMux } from '../CdpPipeMux';
import { PIPE_ENDPOINT, pipeTransport } from '../ChromeTransport';
import { FakeBrowser } from './fakePipeBrowser';

function setup() {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
  return { browser, mux, transport: pipeTransport(mux) };
}

describe('pipeTransport', () => {
  it('is a pipe with no port, and pings with Browser.getVersion', async () => {
    const { browser, mux, transport } = setup();
    expect(transport.kind).toBe('pipe');
    expect(transport.port).toBe(0);
    await transport.ping();
    expect(browser.received.map((c) => c.method)).toEqual(['Target.attachToBrowserTarget', 'Browser.getVersion']);
    expect(await transport.answers()).toBe(true);
    mux.close();
    expect(await transport.answers()).toBe(false);
  });

  it('opens, lists, activates and closes targets in the /json shapes', async () => {
    const { browser, mux, transport } = setup();
    const created = (await transport.createTarget('http://127.0.0.1/x')) as { id: string; type: string; url: string };
    expect(created).toEqual({ id: expect.stringMatching(/^T/), type: 'page', title: '', url: 'http://127.0.0.1/x' });
    const blank = (await transport.createTarget()) as { url: string };
    expect(blank.url).toBe('about:blank');
    expect(await transport.listTargets()).toEqual([
      { id: created.id, type: 'page', title: '', url: 'http://127.0.0.1/x' },
      { id: expect.any(String), type: 'page', title: '', url: 'about:blank' },
    ]);
    await transport.activateTarget(created.id);
    await transport.closeTarget(created.id);
    expect(browser.received.filter((c) => c.method.startsWith('Target.') && c.method !== 'Target.attachToBrowserTarget').map((c) => [c.method, c.params]))
      .toEqual([
        ['Target.createTarget', { url: 'http://127.0.0.1/x' }],
        ['Target.createTarget', { url: 'about:blank' }],
        ['Target.getTargets', {}],
        ['Target.activateTarget', { targetId: created.id }],
        ['Target.closeTarget', { targetId: created.id }],
      ]);
    mux.close();
  });

  it('names the pipe as its endpoint, and connects each caller on the pipe with a browser session of its own', async () => {
    const { browser, mux, transport } = setup();
    expect(await transport.browserEndpoint()).toBe(PIPE_ENDPOINT);
    expect(await transport.browserEndpointIgnoringStatus()).toBe(PIPE_ENDPOINT);
    const watcher = transport.connect(() => 'ignored', { label: 'watcher' });
    await watcher.send('Browser.getVersion');
    const sessions = new Set(browser.received.filter((c) => c.method === 'Browser.getVersion').map((c) => c.sessionId));
    expect(sessions.size).toBe(2);
    mux.close();
    expect(await transport.browserEndpointIgnoringStatus()).toBeNull();
    await expect(transport.ping()).rejects.toThrow('ChromeLauncher: connection closed');
  });

  it('an aborted request rejects at once', async () => {
    const { mux, transport } = setup();
    const stop = new AbortController();
    stop.abort();
    await expect(transport.listTargets(stop.signal)).rejects.toThrow('ChromeLauncher: Target.getTargets aborted');
    mux.close();
  });
});
