import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import type { AppInfo, AppState, HelperMethod, WindowInfo } from '../../../shared/computer/protocol';
import { ApprovalQueue } from '../../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { createComputerConsentRequester } from '../computerConsent';
import {
  ABORT_COOLDOWN_MS,
  ComputerService,
  INPUT_LOCK_IDLE_MS,
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
    createHelper: () => helper,
    requestConsent: consent,
    stopKey,
    blockContext: () => ({ selfPids: new Set([1]) }),
    now: () => now,
    platform: opts.platform ?? 'win32',
  });
  return { service, calls, consent, stopKey, advance: (ms: number) => { now += ms; } };
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

  it('refuses OS-wide chords on Windows before consent, lock or helper', async () => {
    const { service, calls, consent } = makeService({ platform: 'win32' });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    consent.mockClear();
    const before = calls.length;
    for (const keys of [['win', 'r'], ['meta', 'd'], ['alt', 'tab'], ['alt', 'shift', 'Tab'], ['alt', 'esc'], ['ctrl', 'Escape'], ['ctrl', 'shift', 'esc'], ['ctrl', 'alt', 'shift', 'esc'], ['ctrl', 'alt', 'delete']]) {
      const err = await service.control(AGENT_A, { action: 'hotkey', snapshotId, keys }).catch((e: unknown) => e);
      expect(err, keys.join('+')).toBeInstanceOf(ComputerError);
      expect((err as ComputerError).message).toMatch(/refused because/);
    }
    expect(calls.length).toBe(before);
    expect(service.inputHolder()).toBeNull();
    // App-level chords still go through.
    for (const keys of [['ctrl', 's'], ['alt', 'F4'], ['ctrl', 'shift', 'Tab']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys }))).toBe('resolved');
    }
  });

  it('refuses OS-wide chords on macOS but keeps Cmd shortcuts', async () => {
    const { service } = makeService({ platform: 'darwin' });
    const { snapshotId } = await service.getAppState(AGENT_A, { app: 'Notepad' });
    for (const keys of [['cmd', 'tab'], ['cmd', 'space'], ['ctrl', 'space'], ['cmd', 'option', 'esc'], ['ctrl', 'cmd', 'q'], ['cmd', 'shift', 'q'], ['cmd', 'opt', 'd'], ['cmd', 'shift', '4'], ['ctrl', 'up'], ['ctrl', 'F2'], ['ctrl', 'alt', 'shift', 'esc']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys })), keys.join('+')).toBe('invalid_argument');
    }
    for (const keys of [['cmd', 's'], ['cmd', 'q'], ['ctrl', 'cmd', 'f'], ['cmd', 'shift', 't'], ['alt', 'tab']]) {
      expect(await codeOf(service.control(AGENT_A, { action: 'hotkey', snapshotId, keys })), keys.join('+')).toBe('resolved');
    }
  });

  it('a call during quit starts no helper and does not take the stop key again', async () => {
    let created = 0;
    const stopKey = fakeStopKey();
    const service = new ComputerService({
      isEnabled: () => true,
      createHelper: () => { created += 1; return fakeHelper({}).helper; },
      requestConsent: async () => 'approved',
      stopKey,
      blockContext: () => ({}),
    });
    service.dispose();
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
