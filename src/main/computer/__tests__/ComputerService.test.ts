import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import type { AppInfo, AppState, HelperMethod, WindowInfo } from '../../../shared/computer/protocol';
import { ABORT_COOLDOWN_MS, ComputerService, INPUT_LOCK_IDLE_MS, type HelperLike } from '../ComputerService';

const notepad: AppInfo = { id: 'c:\\windows\\notepad.exe', name: 'Notepad', pid: 10, path: 'C:\\Windows\\notepad.exe' };
const keepass: AppInfo = { id: 'c:\\keepassxc.exe', name: 'KeePassXC', pid: 11, path: 'C:\\KeePassXC.exe' };
const win = (app: AppInfo, extra: Partial<WindowInfo> = {}): WindowInfo => ({
  id: `w-${app.pid}`,
  appId: app.id,
  pid: app.pid,
  title: `${app.name} window`,
  bounds: { x: 0, y: 0, width: 1600, height: 900 },
  ...extra,
});

function fakeHelper(apps: Record<string, { app: AppInfo; window: WindowInfo }>) {
  let snapshotSeq = 0;
  const calls: Array<{ method: HelperMethod; params: unknown }> = [];
  const helper: HelperLike = {
    request: (async (method: HelperMethod, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const target = apps[params.app as string];
      switch (method) {
        case 'resolveTarget':
          if (!target) throw new ComputerError('app_not_found', 'no such app');
          return target;
        case 'getAppState': {
          const found = Object.values(apps).find((t) => t.app.id === params.app)!;
          const state: AppState = {
            snapshotId: `s${++snapshotSeq}`,
            app: found.app,
            window: found.window,
            tree: '0 window',
            screenshot: { mime: 'image/jpeg', data: 'AAAA', width: 1280, height: 720, scale: 0.8 },
            screenshotStatus: { status: 'captured' },
          };
          return state;
        }
        case 'listApps':
          return { apps: Object.values(apps).map((t) => t.app) };
        case 'listWindows':
          return { windows: Object.values(apps).map((t) => t.window) };
        default:
          return { method: 'synthetic', verification: 'unverified' };
      }
    }) as HelperLike['request'],
    abort: vi.fn(),
    dispose: vi.fn(),
  };
  return { helper, calls };
}

function makeService(opts: { enabled?: boolean; consent?: boolean | (() => Promise<boolean>); elevated?: boolean } = {}) {
  let now = 1_000_000;
  const { helper, calls } = fakeHelper({
    Notepad: { app: notepad, window: win(notepad, { elevated: opts.elevated }) },
    KeePassXC: { app: keepass, window: win(keepass) },
  });
  const consent = vi.fn(async () => {
    if (typeof opts.consent === 'function') return opts.consent();
    return opts.consent ?? true;
  });
  const service = new ComputerService({
    isEnabled: () => opts.enabled ?? true,
    createHelper: () => helper,
    requestConsent: consent,
    blockContext: () => ({ selfPids: new Set([1]) }),
    now: () => now,
  });
  return { service, calls, consent, advance: (ms: number) => { now += ms; } };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof ComputerError ? err.code : `non-computer error: ${String(err)}`;
  }
}

describe('ComputerService', () => {
  it('refuses everything while computer use is turned off', async () => {
    const { service, calls } = makeService({ enabled: false });
    expect(await codeOf(service.listApps())).toBe('helper_unavailable');
    expect(calls).toHaveLength(0);
  });

  it('reports an unsupported platform when there is no helper', async () => {
    const service = new ComputerService({
      isEnabled: () => true,
      createHelper: null,
      requestConsent: async () => true,
      blockContext: () => ({}),
    });
    expect(await codeOf(service.capabilities())).toBe('unsupported_platform');
  });

  it('marks blocked apps in listApps instead of hiding them', async () => {
    const { service } = makeService();
    const { apps } = await service.listApps();
    expect(apps.find((a) => a.name === 'KeePassXC')?.blocked).toMatch(/password managers/);
    expect(apps.find((a) => a.name === 'Notepad')?.blocked).toBeUndefined();
  });

  it('lists a blocked app\'s windows without their titles', async () => {
    const { service } = makeService();
    const { windows } = await service.listWindows();
    expect(windows.find((w) => w.pid === keepass.pid)).toMatchObject({ title: '', blocked: expect.stringMatching(/password/) });
    expect(windows.find((w) => w.pid === notepad.pid)?.title).toBe('Notepad window');
  });

  it('blocks a password manager before consent is asked or the tree is read', async () => {
    const { service, calls, consent } = makeService();
    expect(await codeOf(service.getAppState('agent-a', { app: 'KeePassXC' }))).toBe('app_blocked');
    expect(consent).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(['resolveTarget']);
  });

  it('refuses an elevated target window', async () => {
    const { service } = makeService({ elevated: true });
    expect(await codeOf(service.getAppState('agent-a', { app: 'Notepad' }))).toBe('target_elevated');
  });

  it('asks consent once per agent and app, and remembers it', async () => {
    const { service, consent } = makeService();
    await service.getAppState('agent-a', { app: 'Notepad' });
    await service.getAppState('agent-a', { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(1);
    await service.getAppState('agent-b', { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent consent requests for the same agent and app', async () => {
    let release!: (v: boolean) => void;
    const { service, consent } = makeService({ consent: () => new Promise<boolean>((r) => { release = r; }) });
    const a = service.getAppState('agent-a', { app: 'Notepad' });
    const b = service.getAppState('agent-a', { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    release(true);
    await Promise.all([a, b]);
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('treats a declined consent as a block and does not ask again', async () => {
    const { service, consent } = makeService({ consent: false });
    expect(await codeOf(service.getAppState('agent-a', { app: 'Notepad' }))).toBe('app_blocked');
    expect(await codeOf(service.getAppState('agent-a', { app: 'Notepad' }))).toBe('app_blocked');
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('requires a snapshot this agent took before any input', async () => {
    const { service } = makeService();
    expect(await codeOf(service.control('agent-a', { action: 'click', index: 1 }))).toBe('invalid_argument');
    expect(await codeOf(service.control('agent-a', { action: 'click', snapshotId: 'nope', index: 1 }))).toBe('snapshot_unknown');
    const state = await service.getAppState('agent-a', { app: 'Notepad' });
    expect(await codeOf(service.control('agent-b', { action: 'click', snapshotId: state.snapshotId, index: 1 }))).toBe('snapshot_unknown');
  });

  it('expires snapshots', async () => {
    const { service, advance } = makeService();
    const state = await service.getAppState('agent-a', { app: 'Notepad' });
    advance(121_000);
    expect(await codeOf(service.control('agent-a', { action: 'click', snapshotId: state.snapshotId, index: 1 }))).toBe('snapshot_unknown');
  });

  it('converts screenshot pixels to window points using the snapshot scale', async () => {
    const { service, calls } = makeService();
    const state = await service.getAppState('agent-a', { app: 'Notepad' });
    await service.control('agent-a', { action: 'click', snapshotId: state.snapshotId, x: 400, y: 200 });
    const click = calls.find((c) => c.method === 'click')!;
    expect(click.params).toMatchObject({ point: { x: 500, y: 250 }, button: 'left', clickCount: 1, modifiers: [] });
  });

  it('refuses coordinates outside the screenshot and index+coordinates together', async () => {
    const { service } = makeService();
    const state = await service.getAppState('agent-a', { app: 'Notepad' });
    expect(await codeOf(service.control('agent-a', { action: 'click', snapshotId: state.snapshotId, x: 1280, y: 10 }))).toBe('invalid_argument');
    expect(await codeOf(service.control('agent-a', { action: 'click', snapshotId: state.snapshotId, x: 1, y: 1, index: 2 }))).toBe('invalid_argument');
  });

  it('validates per-action arguments', async () => {
    const { service } = makeService();
    const { snapshotId } = await service.getAppState('agent-a', { app: 'Notepad' });
    expect(await codeOf(service.control('agent-a', { action: 'setValue', snapshotId, value: 'x' }))).toBe('invalid_argument');
    expect(await codeOf(service.control('agent-a', { action: 'type', snapshotId, text: '' }))).toBe('invalid_argument');
    expect(await codeOf(service.control('agent-a', { action: 'click', snapshotId, index: 1, modifiers: ['hyper' as never] }))).toBe('invalid_argument');
    expect(await codeOf(service.control('agent-a', { action: 'setValue', snapshotId, index: 3, value: '안녕' }))).toBe('resolved');
  });

  it('lets one agent drive at a time until its lock goes idle', async () => {
    const { service, advance } = makeService();
    const a = await service.getAppState('agent-a', { app: 'Notepad' });
    const b = await service.getAppState('agent-b', { app: 'Notepad' });
    await service.control('agent-a', { action: 'pressKey', snapshotId: a.snapshotId, key: 'Enter' });
    expect(await codeOf(service.control('agent-b', { action: 'pressKey', snapshotId: b.snapshotId, key: 'Enter' }))).toBe('input_busy');
    expect(service.inputHolder()).toBe('agent-a');
    advance(INPUT_LOCK_IDLE_MS + 1);
    expect(await codeOf(service.control('agent-b', { action: 'pressKey', snapshotId: b.snapshotId, key: 'Enter' }))).toBe('resolved');
  });

  it('abort stops the helper, refuses input for a cooldown, and asks consent again', async () => {
    const { service, consent, advance } = makeService();
    const { snapshotId } = await service.getAppState('agent-a', { app: 'Notepad' });
    service.abort();
    expect(await codeOf(service.control('agent-a', { action: 'pressKey', snapshotId, key: 'a' }))).toBe('aborted');
    advance(ABORT_COOLDOWN_MS + 1);
    expect(await codeOf(service.control('agent-a', { action: 'pressKey', snapshotId, key: 'a' }))).toBe('resolved');
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('a call parked on a consent prompt cannot continue after the stop key', async () => {
    let release!: (v: boolean) => void;
    const { service, calls, consent } = makeService({
      consent: () => new Promise<boolean>((r) => { release = r; }),
    });
    const pending = service.getAppState('agent-a', { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    service.abort();
    release(true);
    expect(await codeOf(pending)).toBe('aborted');
    expect(calls.map((c) => c.method)).not.toContain('getAppState');
    // The late "yes" was not kept: the next call asks again.
    const again = service.getAppState('agent-a', { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    release(true);
    await again;
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('re-vets when the helper answers for a different window of the same app', async () => {
    const { service, calls } = makeService();
    const realRequest = (service as unknown as { ensureReady: () => { request: (...a: unknown[]) => Promise<unknown> } })
      .ensureReady();
    const original = realRequest.request.bind(realRequest);
    realRequest.request = async (method: unknown, params: unknown) => {
      const result = await original(method, params);
      if (method === 'getAppState') {
        const state = result as AppState;
        return { ...state, window: { ...state.window, id: 'w-other', elevated: true } };
      }
      return result;
    };
    expect(await codeOf(service.getAppState('agent-a', { app: 'Notepad' }))).toBe('target_elevated');
    expect(calls.map((c) => c.method)).toEqual(['resolveTarget', 'getAppState']);
  });

  it('caps input actions per minute', async () => {
    const { service } = makeService();
    const { snapshotId } = await service.getAppState('agent-a', { app: 'Notepad' });
    for (let i = 0; i < 120; i++) {
      await service.control('agent-a', { action: 'pressKey', snapshotId, key: 'a' });
    }
    expect(await codeOf(service.control('agent-a', { action: 'pressKey', snapshotId, key: 'a' }))).toBe('input_busy');
  });
});
