import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import { SNAPSHOT_TTL_MS, type AppInfo, type AppState, type HelperMethod, type WindowInfo } from '../../../shared/computer/protocol';
import { ApprovalQueue } from '../../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { createComputerConsentRequester } from '../computerConsent';
import {
  ABORT_COOLDOWN_MS,
  ComputerService,
  capabilitiesForAgent,
  INPUT_LOCK_IDLE_MS,
  computerUseShutDown,
  type ComputerAgent,
  type ConsentAnswer,
  type HelperLike,
} from '../ComputerService';

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

function fakeStopKey(holds = true) {
  return { arm: vi.fn(() => holds), release: vi.fn() };
}

function makeService(opts: {
  enabled?: boolean;
  consent?: ConsentAnswer | (() => Promise<ConsentAnswer>);
  elevated?: boolean;
  stopKeyHolds?: boolean;
  platform?: string;
  askPerApp?: boolean;
} = {}) {
  let now = 1_000_000;
  const { helper, calls } = fakeHelper({
    Notepad: { app: notepad, window: win(notepad, { elevated: opts.elevated }) },
    KeePassXC: { app: keepass, window: win(keepass) },
  });
  const stopKey = fakeStopKey(opts.stopKeyHolds ?? true);
  const consent = vi.fn(async () => {
    if (typeof opts.consent === 'function') return opts.consent();
    return opts.consent ?? 'approved';
  });
  const service = new ComputerService({
    isEnabled: () => opts.enabled ?? true,
    askPerApp: () => opts.askPerApp ?? true,
    createHelper: () => helper,
    requestConsent: consent,
    stopKey,
    blockContext: () => ({ selfPids: new Set([1]) }),
    now: () => now,
    platform: opts.platform ?? 'win32',
  });
  return { service, calls, consent, stopKey, helperRef: helper, advance: (ms: number) => { now += ms; } };
}

const AGENT_A: ComputerAgent = { key: 'agent-a', label: 'agent-a' };
const AGENT_B: ComputerAgent = { key: 'agent-b', label: 'agent-b' };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof ComputerError ? err.code : `non-computer error: ${String(err)}`;
  }
}

describe('ComputerService', () => {
  it('refuses everything while computer use is turned off, and gives the stop key back', async () => {
    const { service, calls, stopKey } = makeService({ enabled: false });
    expect(await codeOf(service.listApps())).toBe('helper_unavailable');
    expect(calls).toHaveLength(0);
    expect(stopKey.release).toHaveBeenCalled();
    expect(stopKey.arm).not.toHaveBeenCalled();
  });

  it('holds the stop key while computer use is on', async () => {
    const { service, stopKey } = makeService();
    await service.listApps();
    expect(stopKey.arm).toHaveBeenCalled();
    expect(stopKey.release).not.toHaveBeenCalled();
  });

  it('refuses input, but not observation, while the stop key cannot be held', async () => {
    const { service, calls } = makeService({ stopKeyHolds: false });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId, index: 1 }))).toBe('stop_key_unavailable');
    expect(calls.map((c) => c.method)).not.toContain('click');
  });

  it('reports an unsupported platform when there is no helper', async () => {
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: null,
      requestConsent: async () => 'approved',
      stopKey: fakeStopKey(),
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
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    const { windows } = await service.listWindows(AGENT_A);
    expect(windows.find((w) => w.pid === keepass.pid)).toMatchObject({ title: '', blocked: expect.stringMatching(/password/) });
    expect(windows.find((w) => w.pid === notepad.pid)?.title).toBe('Notepad window');
  });

  it('sends window titles only for apps this agent has consent for', async () => {
    const { service } = makeService();
    const before = await service.listWindows(AGENT_A);
    // Ids and bounds stay; the title waits for the person's consent.
    expect(before.windows.find((w) => w.pid === notepad.pid)).toMatchObject({ id: `w-${notepad.pid}`, title: '', bounds: { width: 1600 } });
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect((await service.listWindows(AGENT_A)).windows.find((w) => w.pid === notepad.pid)?.title).toBe('Notepad window');
    // Consent is per agent: another session still sees a blank title.
    expect((await service.listWindows(AGENT_B)).windows.find((w) => w.pid === notepad.pid)?.title).toBe('');
    // An unidentified caller (empty key) never gets a title.
    expect((await service.listWindows({ key: '', label: 'x' })).windows.every((w) => w.title === '')).toBe(true);
  });

  it('blanks titles again after the stop key clears consent', async () => {
    const { service } = makeService();
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    service.abort();
    expect((await service.listWindows(AGENT_A)).windows.find((w) => w.pid === notepad.pid)?.title).toBe('');
  });

  it('blocks a password manager before consent is asked or the tree is read', async () => {
    const { service, calls, consent } = makeService();
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'KeePassXC' }))).toBe('app_blocked');
    expect(consent).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(['resolveTarget']);
  });

  it('refuses an elevated target window', async () => {
    const { service } = makeService({ elevated: true });
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('target_elevated');
  });

  it('asks consent once per agent and app, and remembers it', async () => {
    const { service, consent } = makeService();
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(1);
    await service.getAppState(AGENT_B, { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent consent requests for the same agent and app', async () => {
    let release!: (v: ConsentAnswer) => void;
    const { service, consent } = makeService({ consent: () => new Promise<ConsentAnswer>((r) => { release = r; }) });
    const a = service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = service.getAppState(AGENT_A, { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    release('approved');
    await Promise.all([a, b]);
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit Deny as a block and does not ask again', async () => {
    const { service, consent } = makeService({ consent: 'denied' });
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('app_blocked');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('app_blocked');
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('requires a snapshot this agent took before any input', async () => {
    const { service } = makeService();
    expect(await codeOf(service.control(AGENT_A, { action: 'click', index: 1 }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId: 'nope', index: 1 }))).toBe('snapshot_unknown');
    const state = await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(service.control(AGENT_B, { action: 'click', snapshotId: state.snapshotId, index: 1 }))).toBe('snapshot_unknown');
  });

  it('expires snapshots', async () => {
    const { service, advance } = makeService();
    const state = await service.getAppState(AGENT_A, { app: 'Notepad' });
    advance(121_000);
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId: state.snapshotId, index: 1 }))).toBe('snapshot_unknown');
  });

  it('converts screenshot pixels to window points using the snapshot scale', async () => {
    const { service, calls } = makeService();
    const state = await service.getAppState(AGENT_A, { app: 'Notepad' });
    await service.control(AGENT_A, { action: 'click', snapshotId: state.snapshotId, x: 400, y: 200 });
    const click = calls.find((c) => c.method === 'click')!;
    expect(click.params).toMatchObject({ point: { x: 500, y: 250 }, button: 'left', clickCount: 1, modifiers: [] });
  });

  it('refuses coordinates outside the screenshot and index+coordinates together', async () => {
    const { service } = makeService();
    const state = await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId: state.snapshotId, x: 1280, y: 10 }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId: state.snapshotId, x: 1, y: 1, index: 2 }))).toBe('invalid_argument');
  });

  it('validates per-action arguments', async () => {
    const { service } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(service.control(AGENT_A, { action: 'setValue', snapshotId, value: 'x' }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'type', snapshotId, text: '' }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId, index: 1, modifiers: ['hyper' as never] }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'setValue', snapshotId, index: 3, value: '안녕' }))).toBe('resolved');
  });

  it('sends only canonical keys, with the vetted window as the target', async () => {
    const { service, calls } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    await service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'return' });
    await service.control(AGENT_A, { action: 'hotkey', snapshotId, keys: ['S', 'Control'] });
    const sent = calls.filter((c) => c.method === 'pressKey' || c.method === 'hotkey').map((c) => c.params);
    expect(sent).toEqual([
      { snapshotId, target: { pid: notepad.pid, windowId: `w-${notepad.pid}` }, key: 'Enter', repeat: 1 },
      { snapshotId, target: { pid: notepad.pid, windowId: `w-${notepad.pid}` }, modifiers: ['ctrl'], key: 's' },
    ]);
  });

  it('refuses keys outside the vocabulary before they reach the helper', async () => {
    const { service, calls } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const before = calls.length;
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'PrintScreen' }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'meta' }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys: ['ctrl', 'shift'] }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys: ['ctrl', 'a', 'b'] }))).toBe('invalid_argument');
    expect(calls.length).toBe(before);
  });

  it('refuses only lock, sign-out and force-quit chords on Windows, before consent, lock or helper', async () => {
    const { service, calls, consent } = makeService({ platform: 'win32' });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    consent.mockClear();
    const before = calls.length;
    for (const keys of [['win', 'l'], ['meta', 'x'], ['ctrl', 'shift', 'esc'], ['ctrl', 'alt', 'shift', 'esc'], ['ctrl', 'alt', 'delete']]) {
      const err = await service.control(AGENT_A, { action: 'hotkey', snapshotId, keys }).catch((e: unknown) => e);
      expect(err, keys.join('+')).toBeInstanceOf(ComputerError);
      expect((err as ComputerError).code).toBe('shortcut_blocked');
    }
    expect(calls.length).toBe(before);
    expect(service.inputHolder()).toBeNull();
    // App-level chords, app switching and Start go through.
    for (const keys of [['ctrl', 's'], ['alt', 'F4'], ['ctrl', 'shift', 'Tab'], ['alt', 'tab'], ['win', 'r'], ['ctrl', 'Escape']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys })), keys.join('+')).toBe('resolved');
    }
  });

  it('refuses only lock, log-out and force-quit chords on macOS', async () => {
    const { service } = makeService({ platform: 'darwin' });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    for (const keys of [['cmd', 'option', 'esc'], ['ctrl', 'cmd', 'q'], ['cmd', 'shift', 'q'], ['ctrl', 'alt', 'shift', 'esc']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys })), keys.join('+')).toBe('shortcut_blocked');
    }
    for (const keys of [['cmd', 's'], ['cmd', 'q'], ['ctrl', 'cmd', 'f'], ['cmd', 'shift', 't'], ['alt', 'tab'], ['cmd', 'tab'], ['cmd', 'space'], ['ctrl', 'up']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys })), keys.join('+')).toBe('resolved');
    }
  });

  it('refuses modifiers on actions that would drop them, and sends modified clicks', async () => {
    const { service, calls } = makeService({ platform: 'win32' });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const before = calls.length;
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'a', modifiers: ['ctrl'] }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'type', snapshotId, text: 'x', modifiers: ['shift'] }))).toBe('invalid_argument');
    expect(await codeOf(service.control(AGENT_A, { action: 'scroll', snapshotId, index: 1, modifiers: ['ctrl'] }))).toBe('invalid_argument');
    expect(calls.length).toBe(before);
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId, index: 1, modifiers: ['ctrl'] }))).toBe('resolved');
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId, index: 1, modifiers: ['meta'] }))).toBe('resolved');
  });

  it('re-checks the snapshot and the stop cooldown after a long consent wait', async () => {
    let resolveConsent: (a: ConsentAnswer) => void = () => undefined;
    const { service, advance, consent } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    // Consent is dropped (as after a stop) and the next prompt waits long.
    (service as unknown as { grants: Map<string, boolean> }).grants.clear();
    consent.mockImplementationOnce(() => new Promise<ConsentAnswer>((r) => { resolveConsent = r; }));
    const parked = service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'Enter' });
    await Promise.resolve();
    advance(SNAPSHOT_TTL_MS + 1);
    resolveConsent('approved');
    expect(await codeOf(parked)).toBe('snapshot_unknown');
    expect(service.inputHolder()).toBeNull();
  });

  it('always re-vets the window the helper answered for and refuses one that is not the app\'s', async () => {
    const { service, helperRef } = makeService();
    const original = helperRef.request;
    helperRef.request = (async (method: HelperMethod, params: never) => {
      const result = await original(method as never, params);
      if (method === 'getAppState') return { ...(result as AppState), window: { ...(result as AppState).window, pid: 999 } };
      return result;
    }) as HelperLike['request'];
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('internal');
    helperRef.request = (async (method: HelperMethod, params: never) => {
      const result = await original(method as never, params);
      if (method === 'getAppState') return { ...(result as AppState), window: { ...(result as AppState).window, elevated: true } };
      return result;
    }) as HelperLike['request'];
    // Same ids as the resolved pair, but now elevated: re-vetted and refused.
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('target_elevated');
  });

  it('a call during quit starts no helper and does not take the stop key again', async () => {
    let created = 0;
    const stopKey = fakeStopKey();
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: () => { created += 1; return fakeHelper({}).helper; },
      requestConsent: async () => 'approved',
      stopKey,
      blockContext: () => ({}),
    });
    service.dispose();
    expect(computerUseShutDown()).toBe(true);
    expect(await codeOf(service.listApps())).toBe('helper_unavailable');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('helper_unavailable');
    expect(created).toBe(0);
    expect(stopKey.arm).not.toHaveBeenCalled();
  });

  it('lets one agent drive at a time until its lock goes idle', async () => {
    const { service, advance } = makeService();
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    await service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'Enter' });
    expect(await codeOf(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'Enter' }))).toBe('input_busy');
    expect(service.inputHolder()).toBe('agent-a');
    advance(INPUT_LOCK_IDLE_MS + 1);
    expect(await codeOf(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'Enter' }))).toBe('resolved');
  });

  it('abort stops the helper, refuses input for a cooldown, and asks consent again', async () => {
    const { service, consent, advance } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    service.abort();
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'a' }))).toBe('aborted');
    advance(ABORT_COOLDOWN_MS + 1);
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'a' }))).toBe('resolved');
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('a call parked on a consent prompt cannot continue after the stop key', async () => {
    let release!: (v: ConsentAnswer) => void;
    const { service, calls, consent, advance } = makeService({
      consent: () => new Promise<ConsentAnswer>((r) => { release = r; }),
    });
    const pending = service.getAppState(AGENT_A, { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    service.abort();
    release('approved');
    expect(await codeOf(pending)).toBe('aborted');
    expect(calls.map((c) => c.method)).not.toContain('getAppState');
    // The late "yes" was not kept: the next call (after the cooldown) asks again.
    advance(ABORT_COOLDOWN_MS + 1);
    const again = service.getAppState(AGENT_A, { app: 'Notepad' });
    await new Promise((r) => setTimeout(r, 0));
    release('approved');
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
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('target_elevated');
    expect(calls.map((c) => c.method)).toEqual(['resolveTarget', 'getAppState']);
  });

  it('keeps two sessions of one client apart even when the person sees the same label', async () => {
    const { service, consent } = makeService();
    const paneA: ComputerAgent = { key: 'claude-code @ ws-1/pty-1', label: 'claude-code in workspace "api"' };
    const paneB: ComputerAgent = { key: 'claude-code @ ws-1/pty-2', label: 'claude-code in workspace "api"' };
    const a = await service.getAppState(paneA, { app: 'Notepad' });
    // Consent is per session: B is asked for itself.
    const b = await service.getAppState(paneB, { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(2);
    expect(consent.mock.calls.map((c) => (c as unknown as [{ agent: ComputerAgent }])[0].agent.key)).toEqual([paneA.key, paneB.key]);
    // Snapshots are per session.
    expect(await codeOf(service.control(paneB, { action: 'click', snapshotId: a.snapshotId, index: 1 }))).toBe('snapshot_unknown');
    // The input lock is per session, and the holder is named by label, never by key.
    await service.control(paneA, { action: 'pressKey', snapshotId: a.snapshotId, key: 'Enter' });
    const busy = await service.control(paneB, { action: 'pressKey', snapshotId: b.snapshotId, key: 'Enter' }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ComputerError);
    expect((busy as ComputerError).code).toBe('input_busy');
    expect((busy as ComputerError).message).toBe('claude-code in workspace "api" is using the desktop');
    expect((busy as ComputerError).message).not.toContain('pty-');
    expect(service.inputHolder()).toBe('claude-code in workspace "api"');
  });

  it('keeps the rate cap per session', async () => {
    const { service } = makeService();
    const paneA: ComputerAgent = { key: 'c @ ws-1/pty-1', label: 'c' };
    const paneB: ComputerAgent = { key: 'c @ ws-1/pty-2', label: 'c' };
    const { snapshotId } = await service.getAppState(paneA, { app: 'Notepad' });
    for (let i = 0; i < 120; i++) await service.control(paneA, { action: 'pressKey', snapshotId, key: 'a' });
    expect(await codeOf(service.control(paneA, { action: 'pressKey', snapshotId, key: 'a' }))).toBe('input_busy');
    const b = await service.getAppState(paneB, { app: 'Notepad' });
    // B is not throttled by A's actions (only by A's lock, which has gone idle here).
    (service as unknown as { lock: unknown }).lock = null;
    expect(await codeOf(service.control(paneB, { action: 'pressKey', snapshotId: b.snapshotId, key: 'a' }))).toBe('resolved');
  });

  it('does not remember an unanswered or unshowable prompt: the next call asks again', async () => {
    const answers: ConsentAnswer[] = ['expired', 'unavailable', 'approved'];
    const { service, consent } = makeService({ consent: async () => answers.shift() ?? 'approved' });
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('timeout');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('internal');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('resolved');
    expect(consent).toHaveBeenCalledTimes(3);
  });

  it('a requester that throws is treated as unanswered, not as a refusal', async () => {
    let first = true;
    const { service, consent } = makeService({
      consent: async () => {
        if (first) { first = false; throw new Error('queue gone'); }
        return 'approved';
      },
    });
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('internal');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('resolved');
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('opens no new consent prompt during the stop cooldown', async () => {
    const { service, consent, advance } = makeService();
    service.abort();
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('aborted');
    expect(consent).not.toHaveBeenCalled();
    advance(ABORT_COOLDOWN_MS + 1);
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('resolved');
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('caps input actions per minute', async () => {
    const { service } = makeService();
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    for (let i = 0; i < 120; i++) {
      await service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'a' });
    }
    expect(await codeOf(service.control(AGENT_A, { action: 'pressKey', snapshotId, key: 'a' }))).toBe('input_busy');
  });
});

// The review's repro scenarios, run against the real ApprovalQueue and the real
// consent requester rather than a stubbed answer.
describe('ComputerService with the real approval queue', () => {
  function realQueueService(deadlineMs: number) {
    let now = 5_000_000;
    const opened: Array<{ promptId: string; title?: string }> = [];
    const closed: string[] = [];
    const queue = new ApprovalQueue({} as PluginTrustStore, {
      openPrompt: (p) => { opened.push({ promptId: p.promptId, title: p.title }); },
      closePrompt: (id) => { closed.push(id); },
    });
    const dedupeKeys: string[] = [];
    const realRequestConsent = queue.requestConsent.bind(queue);
    queue.requestConsent = (input) => {
      dedupeKeys.push(input.dedupeKey);
      return realRequestConsent(input);
    };
    const { helper } = fakeHelper({ Notepad: { app: notepad, window: win(notepad) } });
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: () => helper,
      requestConsent: createComputerConsentRequester({ queue: () => queue, deadlineMs }),
      stopKey: fakeStopKey(),
      blockContext: () => ({}),
      now: () => now,
    });
    return { service, queue, opened, closed, dedupeKeys, advance: (ms: number) => { now += ms; } };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a timeout then a retry asks again instead of reporting a refusal', async () => {
    const { service, queue, opened } = realQueueService(30);
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('timeout');
    expect(queue.inflightCount()).toBe(0);
    const retry = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(0);
    expect(opened).toHaveLength(2);
    await queue.resolvePrompt(opened[1].promptId, true);
    expect(await codeOf(retry)).toBe('resolved');
  });

  it('remembers an explicit Deny without asking again', async () => {
    const { service, queue, opened } = realQueueService(60_000);
    const first = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(0);
    await queue.resolvePrompt(opened[0].promptId, false);
    expect(await codeOf(first)).toBe('app_blocked');
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'Notepad' }))).toBe('app_blocked');
    expect(opened).toHaveLength(1);
  });

  it('the stop key takes the prompt down and fails the parked call at once', async () => {
    const { service, queue, opened, closed } = realQueueService(60_000);
    const parked = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(0);
    expect(queue.inflightCount()).toBe(1);
    const stoppedAt = Date.now();
    service.abort();
    expect(await codeOf(parked)).toBe('aborted');
    // Not at the prompt's own 60 s deadline: right away.
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(queue.inflightCount()).toBe(0);
    expect(closed).toEqual([opened[0].promptId]);
  });

  it('a call after the stop never joins the pre-stop prompt, and is not failed at its deadline', async () => {
    const deadlineMs = 1_000;
    const { service, queue, opened, dedupeKeys, advance } = realQueueService(deadlineMs);
    const a = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(deadlineMs * 0.7); // stop at t=700 ms, as in the review's repro2
    service.abort();
    // Right after the stop (the agent retries at once): refused, no prompt.
    const b = service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(a)).toBe('aborted');
    expect(await codeOf(b)).toBe('aborted');
    expect(opened).toHaveLength(1);
    // After the cooldown: a fresh prompt with its own dedupe key.
    advance(ABORT_COOLDOWN_MS + 1);
    const c = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(0);
    expect(opened).toHaveLength(2);
    expect(dedupeKeys[1]).not.toBe(dedupeKeys[0]);
    // A's old deadline (t=1000 ms) passes; C's own (about t=1700 ms) has not: C still waits.
    await sleep(deadlineMs * 0.45);
    expect(queue.inflightCount()).toBe(1);
    await queue.resolvePrompt(opened[1].promptId, true);
    expect(await codeOf(c)).toBe('resolved');
  });

  it('dispose also takes open prompts down', async () => {
    const { service, queue } = realQueueService(60_000);
    const parked = service.getAppState(AGENT_A, { app: 'Notepad' });
    await sleep(0);
    service.dispose();
    expect(await codeOf(parked)).toBe('aborted');
    expect(queue.inflightCount()).toBe(0);
  });
});

describe('explorer.exe windows', () => {
  const explorer: AppInfo = { id: 'c:\\windows\\explorer.exe', name: 'Explorer', pid: 20, path: 'C:\\Windows\\explorer.exe' };
  const folder = win(explorer, { className: 'CabinetWClass', shellLocation: 'C:\\Users\\me\\Documents' });
  const runDialog = win(explorer, { id: 'w-22', className: '#32770', ownerId: '65552' });

  it('are ordinary windows now, with locations still behind consent', async () => {
    const { helper } = fakeHelper({ Explorer: { app: explorer, window: folder } });
    const request = helper.request;
    helper.request = (async (method: HelperMethod, params: Record<string, unknown>) =>
      method === 'listWindows'
        ? { windows: [folder, runDialog] }
        : (request as (m: HelperMethod, p: unknown) => Promise<unknown>)(method, params)) as HelperLike['request'];
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: () => helper,
      requestConsent: vi.fn(async () => 'approved' as ConsentAnswer),
      stopKey: fakeStopKey(),
      blockContext: () => ({}),
      platform: 'win32',
    });
    const { windows } = await service.listWindows(AGENT_A);
    expect(windows.every((w) => w.blocked === undefined)).toBe(true);
    expect(windows.every((w) => w.shellLocation === undefined && w.title === '')).toBe(true);
    const state = await service.getAppState(AGENT_A, { app: 'Explorer' });
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId: state.snapshotId, index: 1 }))).toBe('resolved');
  });
});

describe('consent is opt-in (askPerApp)', () => {
  it('asks no one and sends every unblocked title while askPerApp is off', async () => {
    const { service, consent, calls } = makeService({ askPerApp: false });
    const { windows } = await service.listWindows({ key: '', label: 'anon' });
    expect(windows.find((w) => w.pid === notepad.pid)?.title).toBe('Notepad window');
    // A blocked app stays blank and marked.
    expect(windows.find((w) => w.pid === keepass.pid)).toMatchObject({ title: '', blocked: expect.any(String) });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(await codeOf(service.control(AGENT_A, { action: 'click', snapshotId, index: 1 }))).toBe('resolved');
    expect(consent).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'click')).toBe(true);
    // The blocklist still applies.
    expect(await codeOf(service.getAppState(AGENT_A, { app: 'KeePassXC' }))).toBe('app_blocked');
  });

  it('asks once per agent and app while askPerApp is on', async () => {
    const { service, consent } = makeService({ askPerApp: true });
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    await service.getAppState(AGENT_A, { app: 'Notepad' });
    expect(consent).toHaveBeenCalledTimes(1);
    const { windows } = await service.listWindows({ key: '', label: 'anon' });
    expect(windows.every((w) => w.title === '')).toBe(true);
  });
});

describe('openApp', () => {
  const textEdit: AppInfo = { id: 'com.apple.TextEdit', name: 'TextEdit', pid: 30, path: '/System/Applications/TextEdit.app', bundleId: 'com.apple.TextEdit' };
  const passwords: AppInfo = { id: 'com.apple.Passwords', name: 'Passwords', pid: 31, path: '/System/Applications/Passwords.app', bundleId: 'com.apple.Passwords' };

  function openAppService(opts: {
    actions?: string[];
    opens?: AppInfo;
    askPerApp?: boolean;
    running?: boolean;
    bundleIds?: Record<string, string | null>;
  } = {}) {
    const calls: Array<{ method: HelperMethod; params: unknown }> = [];
    const opened = opts.opens ?? textEdit;
    const window = win(opened);
    const helper: HelperLike = {
      request: (async (method: HelperMethod, params: unknown) => {
        calls.push({ method, params });
        if (method === 'capabilities') {
          return { actions: opts.actions ?? ['capabilities', 'openApp'], modes: ['ax'], permissions: { accessibility: true, screenRecording: true } };
        }
        if (method === 'resolveTarget') {
          if (!opts.running) throw new ComputerError('app_not_found', 'not running');
          return { app: opened, window };
        }
        if (method === 'openApp') return { app: opened, window };
        throw new Error(`unexpected ${method}`);
      }) as HelperLike['request'],
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const consent = vi.fn(async (): Promise<ConsentAnswer> => 'approved');
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => opts.askPerApp ?? false,
      readBundleId: async (appPath) => opts.bundleIds?.[appPath] ?? null,
      createHelper: () => helper,
      requestConsent: consent,
      stopKey: fakeStopKey(),
      blockContext: () => ({}),
      platform: 'darwin',
    });
    return { service, calls, consent };
  }

  it('refuses a blocked selector before anything launches', async () => {
    const { service, calls } = openAppService();
    for (const app of ['1Password', 'com.apple.Passwords', '/Applications/Bitwarden.app', 'wmux']) {
      expect(await codeOf(service.openApp(AGENT_A, { app })), app).toBe('app_blocked');
    }
    expect(calls).toEqual([]);
  });

  it('judges an absolute .app path by its bundle id before launching, whatever the file is called', async () => {
    const { service, calls } = openAppService({
      bundleIds: { '/Users/me/Notes.app': 'com.1password.1password', '/Applications/TextEdit.app': 'com.apple.TextEdit' },
    });
    expect(await codeOf(service.openApp(AGENT_A, { app: '/Users/me/Notes.app' }))).toBe('app_blocked');
    // Unreadable: refused, never launched.
    expect(await codeOf(service.openApp(AGENT_A, { app: '/tmp/Unknown.app/' }))).toBe('app_not_found');
    expect(calls).toEqual([]);
    expect(await codeOf(service.openApp(AGENT_A, { app: '/Applications/TextEdit.app' }))).toBe('resolved');
    expect(calls.map((c) => c.method)).toEqual(['capabilities', 'openApp']);
  });

  it('answers unsupported_action when the helper does not list openApp', async () => {
    const { service, calls } = openAppService({ actions: ['capabilities', 'click'] });
    expect(await codeOf(service.openApp(AGENT_A, { app: 'TextEdit' }))).toBe('unsupported_action');
    expect(calls.map((c) => c.method)).toEqual(['capabilities']);
  });

  it('opens an app and returns what the helper opened, without asking while askPerApp is off', async () => {
    const { service, calls, consent } = openAppService();
    const result = await service.openApp(AGENT_A, { app: 'TextEdit' });
    expect(result.app.id).toBe('com.apple.TextEdit');
    expect(calls.map((c) => c.method)).toEqual(['capabilities', 'openApp']);
    expect(calls[1].params).toEqual({ app: 'TextEdit' });
    expect(consent).not.toHaveBeenCalled();
    expect(service.inputHolder()).toBe('agent-a');
  });

  it('uses the hello the helper already gave instead of asking for capabilities', async () => {
    const { service, calls } = openAppService();
    const helper = (service as unknown as { deps: { createHelper: () => HelperLike } }).deps.createHelper();
    helper.supports = () => true;
    await service.openApp(AGENT_A, { app: 'TextEdit' });
    expect(calls.map((c) => c.method)).toEqual(['openApp']);
  });

  it('refuses after the fact when the opened app turns out to be blocked', async () => {
    const { service } = openAppService({ opens: passwords });
    expect(await codeOf(service.openApp(AGENT_A, { app: 'Keys' }))).toBe('app_blocked');
  });

  it('asks consent like other control actions while askPerApp is on', async () => {
    const running = openAppService({ askPerApp: true, running: true });
    await running.service.openApp(AGENT_A, { app: 'TextEdit' });
    // Asked before bringing a running app forward, and not again after.
    expect(running.consent).toHaveBeenCalledTimes(1);
    expect(running.calls.map((c) => c.method)).toEqual(['capabilities', 'resolveTarget', 'openApp']);

    const denied = openAppService({ askPerApp: true, running: true });
    denied.consent.mockResolvedValue('denied');
    expect(await codeOf(denied.service.openApp(AGENT_A, { app: 'TextEdit' }))).toBe('app_blocked');
    expect(denied.calls.some((c) => c.method === 'openApp')).toBe(false);

    // Not running yet: asked right after the launch.
    const cold = openAppService({ askPerApp: true });
    await cold.service.openApp(AGENT_A, { app: 'TextEdit' });
    expect(cold.consent).toHaveBeenCalledTimes(1);
  });

  it('is refused on computer.act-style control calls that carry a snapshot', async () => {
    const { service } = openAppService();
    expect(await codeOf(service.control(AGENT_A, { action: 'openApp', snapshotId: 's1' }))).toBe('invalid_argument');
  });
});

describe('capabilities for the agent', () => {
  const caps = (accessibility: boolean, screenRecording: boolean) => ({
    actions: ['capabilities', 'listApps', 'listWindows', 'getAppState', 'openApp', 'click', 'type', 'scroll'],
    modes: ['ax', 'vision', 'both'] as Array<'ax' | 'vision' | 'both'>,
    permissions: { accessibility, screenRecording },
  });

  it('passes a fully granted helper through unchanged', () => {
    expect(capabilitiesForAgent(caps(true, true))).toEqual(caps(true, true));
  });

  it('drops input and the tree without Accessibility', () => {
    const out = capabilitiesForAgent(caps(false, true));
    expect(out.missingPermissions).toEqual(['accessibility']);
    expect(out.actions).toEqual(['capabilities', 'listApps', 'listWindows', 'getAppState']);
    expect(out.modes).toEqual(['vision']);
  });

  it('drops screenshots without Screen Recording, and getAppState with neither', () => {
    expect(capabilitiesForAgent(caps(true, false))).toMatchObject({ missingPermissions: ['screenRecording'], modes: ['ax'] });
    const none = capabilitiesForAgent(caps(false, false));
    expect(none.missingPermissions).toEqual(['accessibility', 'screenRecording']);
    expect(none.actions).toEqual(['capabilities', 'listApps', 'listWindows']);
    expect(none.modes).toEqual([]);
  });

  it('is what service.capabilities() answers', async () => {
    const { service, helperRef } = makeService();
    helperRef.request = (async () => caps(false, true)) as HelperLike['request'];
    expect((await service.capabilities()).missingPermissions).toEqual(['accessibility']);
  });
});

describe('settings push', () => {
  it('forwards reconfigure to a helper that exists, and starts none', async () => {
    const reconfigure = vi.fn(async () => undefined);
    const createHelper = vi.fn((): HelperLike => ({ request: vi.fn() as never, abort: vi.fn(), dispose: vi.fn(), reconfigure }));
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => false,
      createHelper,
      requestConsent: vi.fn(),
      stopKey: fakeStopKey(),
      blockContext: () => ({}),
    });
    await service.reconfigure();
    expect(createHelper).not.toHaveBeenCalled();
    await service.capabilities().catch(() => undefined);
    await service.reconfigure();
    expect(reconfigure).toHaveBeenCalledTimes(1);
  });
});
