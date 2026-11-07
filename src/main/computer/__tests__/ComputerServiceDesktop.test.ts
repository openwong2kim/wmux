import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import type { AppInfo, HelperMethod, WindowInfo } from '../../../shared/computer/protocol';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { CONTROL_RATE_PER_MINUTE, ComputerService, DESKTOP_MAX_RUNS, DESKTOP_QUEUE_PER_AGENT, type ComputerAgent, type DesktopDeps, type HelperLike } from '../ComputerService';
import type { RunnerResult } from '../RunnerProcess';

const textEdit: AppInfo = { id: 'com.apple.TextEdit', name: 'TextEdit', pid: 501, path: '/System/Applications/TextEdit.app' };
const keepass: AppInfo = { id: 'org.keepassxc.keepassxc', name: 'KeePassXC', pid: 502, path: '/Applications/KeePassXC.app', bundleId: 'org.keepassxc.keepassxc' };
const win = (app: AppInfo): WindowInfo => ({
  id: String(app.pid * 10),
  appId: app.id,
  pid: app.pid,
  title: `${app.name} window`,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
});
const targets: Record<string, { app: AppInfo; window: WindowInfo }> = {
  TextEdit: { app: textEdit, window: win(textEdit) },
  KeePassXC: { app: keepass, window: win(keepass) },
};

const ACTIONS = ['click', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll'] as const;
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

const AGENT_A: ComputerAgent = { key: 'agent-a', label: 'agent-a' };
const AGENT_B: ComputerAgent = { key: 'agent-b', label: 'agent-b' };

const refmapFor = (pid: number) => JSON.stringify({ inner: { '@e1': { pid }, '@e2': { pid } }, counter: 2 });
const ok = (command: string, data: Record<string, unknown>): RunnerResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ version: '2.6', ok: true, command, data }),
  stderr: '',
});

/**
 * agent-desktop as the service sees it. `answer` decides what a run prints;
 * by default a snapshot of the window it was pointed at, refs owned by the
 * app the service vetted.
 */
type Listed = { name: string; pid: number; bundle_id?: string };
const listedTextEdit: Listed = { name: 'TextEdit', pid: textEdit.pid, bundle_id: textEdit.id };

function makeService(opts: {
  answer?: (argv: string[]) => RunnerResult | Promise<RunnerResult>;
  /** What `list-apps --app=…` prints on its nth run (from 1). */
  apps?: (n: number) => Listed[];
  askPerApp?: boolean;
  withDesktop?: boolean;
  /** The refmap a snapshot or find writes; by default two bare entries of TextEdit's. */
  refmap?: string;
  /** Extra fields of a snapshot's data (complete). */
  snapshotData?: Record<string, unknown>;
  /** The runner never reports a run as started (it failed before spawning). */
  neverStarts?: boolean;
  /** What a ref action prints; the default answer covers everything else. */
  act?: (argv: string[]) => RunnerResult | Promise<RunnerResult>;
} = {}) {
  const calls: Array<{ method: HelperMethod; params: unknown }> = [];
  const helper: HelperLike = {
    request: (async (method: HelperMethod, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method !== 'resolveTarget') throw new Error(`unexpected ${method}`);
      const t = targets[params.app as string];
      if (!t) throw new ComputerError('app_not_found', 'no such app');
      return t;
    }) as HelperLike['request'],
    abort: vi.fn(),
    dispose: vi.fn(),
  };
  const refmaps = new Map<string, string>();
  let seq = 0;
  let listed = 0;
  const runs: string[][] = [];
  const defaultAnswer = (argv: string[]): RunnerResult => {
    if (argv[0] === 'snapshot' || argv[0] === 'find') {
      const id = `s${++seq}`;
      const windowId = argv.find((a) => a.startsWith('--window-id='))?.slice('--window-id='.length);
      refmaps.set(id, opts.refmap ?? refmapFor(textEdit.pid));
      // A find reply names no window (agent-desktop find_live.rs).
      if (argv[0] === 'find') return ok('find', { matches: [{ ref_id: `@${id}:e1`, name: 'Save' }], snapshot_id: id, total_matches: 1, truncated: false });
      return ok('snapshot', { app: 'TextEdit', snapshot_id: id, window: { id: windowId, title: 'Untitled' }, tree: {}, complete: true, ...opts.snapshotData });
    }
    if (argv[0] === 'list-surfaces') return ok('list-surfaces', { pid: textEdit.pid, surfaces: [] });
    return ok(argv[0], { value: 'Hello' });
  };
  const desktop: DesktopDeps = {
    run: vi.fn(async (argv: string[], _timeoutMs: number, onStarted?: () => void) => {
      runs.push(argv);
      if (!opts.neverStarts) onStarted?.();
      if (argv[0] === 'list-apps') return ok('list-apps', { apps: (opts.apps ?? (() => [listedTextEdit]))(++listed) });
      if (opts.act && ACTION_SET.has(argv[0])) return opts.act(argv);
      return (opts.answer ?? defaultAnswer)(argv);
    }),
    readRefmap: vi.fn(async (id: string) => refmaps.get(id) ?? ''),
    abort: vi.fn(),
    dispose: vi.fn(),
  };
  const consent = vi.fn(async () => 'approved' as const);
  let enabled = true;
  const service = new ComputerService({
    isEnabled: () => enabled,
    askPerApp: () => opts.askPerApp ?? true,
    createHelper: () => helper,
    requestConsent: consent,
    stopKey: { arm: vi.fn(() => true), release: vi.fn() },
    blockContext: () => ({ selfPids: new Set([1]) }),
    platform: 'darwin',
    ...(opts.withDesktop !== false && { desktop }),
  });
  return {
    service, calls, desktop, refmaps, runs, consent,
    setRefmap: (id: string, text: string) => refmaps.set(id, text),
    setEnabled: (on: boolean) => { enabled = on; },
  };
}

const snapshotOf = async (service: ComputerService, agent = AGENT_A) =>
  (await service.desktop(agent, { command: 'snapshot', app: 'TextEdit' })).data.snapshot_id as string;

describe('ComputerService.desktop', () => {
  it('vets the app, points agent-desktop at the vetted window, and takes refs from that snapshot', async () => {
    const { service, runs, consent, calls } = makeService();
    const id = await snapshotOf(service);
    expect(calls).toEqual([{ method: 'resolveTarget', params: { app: 'TextEdit' } }]);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(runs[0]).toEqual(['snapshot', '--app=TextEdit', '--window-id=w-5010']);
    const got = await service.desktop(AGENT_A, { command: 'get', args: { ref: `@${id}:e2`, property: 'value' } });
    expect(got.data).toEqual({ value: 'Hello' });
    expect(runs[1]).toEqual(['get', `@${id}:e2`, '--property=value']);
  });

  it('refuses a blocked app before anything runs', async () => {
    const { service, desktop } = makeService();
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'KeePassXC' })).rejects.toMatchObject({ code: 'app_blocked' });
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('refuses a ref whose refmap changed since the snapshot (a forged refmap)', async () => {
    const { service, desktop, setRefmap } = makeService();
    const id = await snapshotOf(service);
    setRefmap(id, refmapFor(keepass.pid));
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    expect(desktop.run).toHaveBeenCalledTimes(1);
  });

  it('discards a reply whose refs belong to another process (a same-named decoy), and keeps none of them', async () => {
    const decoy = (argv: string[]): RunnerResult => {
      if (argv[0] !== 'snapshot') return ok(argv[0], {});
      return ok('snapshot', { app: 'TextEdit', snapshot_id: 'sdecoy', window: { id: 'w-5010' } });
    };
    const { service, setRefmap } = makeService({ answer: decoy });
    setRefmap('sdecoy', refmapFor(999));
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: '@sdecoy:e1' } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
  });

  it('keeps a find reply, which names no window, when its refs are the vetted app\'s', async () => {
    const { service } = makeService();
    const found = await service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { name: 'Save' } });
    const ref = (found.data.matches as Array<{ ref_id: string }>)[0].ref_id;
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref } })).resolves.toBeTruthy();
  });

  it('discards refs whose refmap is missing, unless the window itself was checked', async () => {
    const answer = (argv: string[]): RunnerResult => ok('snapshot', { app: 'TextEdit', snapshot_id: 'snomap', window: { id: argv.includes('--surface=menu') ? 'w-1' : 'w-5010' } });
    const { service } = makeService({ answer });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { surface: 'menu' } })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).resolves.toBeTruthy();
  });

  it('runs one agent\'s calls one after another, so a run that rewrites a refmap does not spoil the next call', async () => {
    let releaseWait: (() => void) | null = null;
    const { service, setRefmap, refmaps } = makeService({
      answer: async (argv) => {
        if (argv[0] === 'snapshot') {
          refmaps.set('s1', refmapFor(textEdit.pid));
          return ok('snapshot', { app: 'TextEdit', snapshot_id: 's1', window: { id: 'w-5010' } });
        }
        if (argv[0] === 'wait') {
          // agent-desktop re-identifies the element and rewrites the refmap
          // while the wait is still running.
          setRefmap('s1', JSON.stringify({ inner: { '@e1': { pid: textEdit.pid, healed: true }, '@e2': { pid: textEdit.pid } }, counter: 2 }));
          await new Promise<void>((r) => { releaseWait = r; });
          return ok('wait', { found: true });
        }
        return ok(argv[0], { value: 'x' });
      },
    });
    await service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' });
    const waiting = service.desktop(AGENT_A, { command: 'wait', args: { element: '@s1:e1' } });
    // The wait is running and has rewritten the refmap; the get comes now.
    await vi.waitFor(() => expect(releaseWait).not.toBeNull(), { timeout: 5_000 });
    const getting = service.desktop(AGENT_A, { command: 'get', args: { ref: '@s1:e1' } });
    releaseWait!();
    await expect(waiting).resolves.toMatchObject({ data: { found: true } });
    await expect(getting).resolves.toMatchObject({ data: { value: 'x' } });
  });

  it('refuses a call past the limit of desktop runs in flight', async () => {
    const never = new Promise<RunnerResult>(() => undefined);
    const { service } = makeService({ answer: () => never });
    const agents = Array.from({ length: DESKTOP_MAX_RUNS }, (_, i) => ({ key: `agent-${i}`, label: `agent-${i}` }));
    for (const a of agents) void service.desktop(a, { command: 'wait', args: { ms: 30_000 } });
    await expect(service.desktop(AGENT_A, { command: 'wait', args: { ms: 10 } })).rejects.toMatchObject({ code: 'input_busy' });
  });

  it('discards a snapshot of another window than the vetted one', async () => {
    const { service } = makeService({ answer: () => ok('snapshot', { app: 'TextEdit', snapshot_id: 'sx', window: { id: 'w-1' } }) });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('discards a surface list when, after the run, another process has the name', async () => {
    const { service } = makeService({ apps: (n) => (n === 1 ? [listedTextEdit] : [{ name: 'TextEdit', pid: 999 }]) });
    await expect(service.desktop(AGENT_A, { command: 'list-surfaces', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('discards a reply that names another process even when the name check before and after is clean', async () => {
    const { service, runs } = makeService({ answer: () => ok('list-surfaces', { pid: 999, surfaces: [{ id: 'w-1', type: 'window', title: 'Vault' }] }) });
    await expect(service.desktop(AGENT_A, { command: 'list-surfaces', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(runs.map((argv) => argv[0])).toEqual(['list-apps', 'list-surfaces', 'list-apps']);
  });

  it('keeps a snapshot of a window with nothing to press, whose refmap lists no refs', async () => {
    // What agent-desktop wrote for a borderless window holding one label (measured).
    const box: { set?: (id: string, text: string) => void } = {};
    const { service, setRefmap } = makeService({
      answer: () => {
        box.set!('sempty', '{"inner":{},"counter":0}');
        return ok('snapshot', { app: 'TextEdit', snapshot_id: 'sempty', ref_count: 0, window: { id: 'w-5010' }, tree: { role: 'window' } });
      },
    });
    box.set = setRefmap;
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).resolves.toMatchObject({ data: { snapshot_id: 'sempty' } });
  });

  it('runs a command that names the app only while the vetted process is the one app by that name, before and after', async () => {
    const counted = (argv: string[]): RunnerResult => (argv[0] === 'find' ? ok('find', { count: 3 }) : ok(argv[0], {}));
    // The vetted app quit during the run and a same-named one is alone now.
    const swapped = makeService({ answer: counted, apps: (n) => (n === 1 ? [listedTextEdit] : [{ name: 'TextEdit', pid: 777 }]) });
    await expect(swapped.service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { role: 'button', count: true } })).rejects.toMatchObject({ code: 'policy_denied' });
    // A second app by that name: agent-desktop could pick either.
    const twin = makeService({ answer: counted, apps: () => [listedTextEdit, { name: 'textedit', pid: 778 }] });
    await expect(twin.service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { role: 'button', count: true } })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(twin.runs.map((argv) => argv[0])).toEqual(['list-apps']);
    // No app by that name, only one whose bundle id is it: agent-desktop would fall back to it.
    const alias = makeService({ answer: counted, apps: () => [{ name: 'Other', pid: 888, bundle_id: 'TextEdit' }] });
    await expect(alias.service.desktop(AGENT_A, { command: 'wait', app: 'TextEdit', args: { text: 'Done' } })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(alias.runs.map((argv) => argv[0])).toEqual(['list-apps']);
    // The vetted process alone, before and after.
    const alone = makeService({ answer: counted });
    await expect(alone.service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { role: 'button', count: true } })).resolves.toMatchObject({ data: { count: 3 } });
    expect(alone.runs.map((argv) => argv[0])).toEqual(['list-apps', 'find', 'list-apps']);
  });

  it('drops a snapshot whose refmap a ref command left unreadable or pointing at another process, and discards that reply', async () => {
    for (const after of [refmapFor(999), '{"inner":']) {
      const box: { set?: (id: string, text: string) => void } = {};
      const { service, setRefmap } = makeService({
        answer: (argv) => {
          if (argv[0] === 'snapshot') {
            box.set!('s1', refmapFor(textEdit.pid));
            return ok('snapshot', { app: 'TextEdit', snapshot_id: 's1', window: { id: 'w-5010' } });
          }
          box.set!('s1', after);
          return ok(argv[0], { value: 'Vault' });
        },
      });
      box.set = setRefmap;
      await service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' });
      await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: '@s1:e1' } })).rejects.toMatchObject({ code: 'policy_denied' });
      await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: '@s1:e1' } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    }
  });

  it('discards a snapshot whose refmap cannot be read, and keeps none of its refs', async () => {
    const box: { set?: (id: string, text: string) => void } = {};
    const { service, setRefmap } = makeService({
      answer: () => {
        box.set!('sbad', '{"inner": [');
        return ok('snapshot', { app: 'TextEdit', snapshot_id: 'sbad', window: { id: 'w-5010' } });
      },
    });
    box.set = setRefmap;
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: '@sbad:e1' } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
  });

  it('counts runs, not queued calls: one agent\'s backlog does not hold another agent back', async () => {
    const never = new Promise<RunnerResult>(() => undefined);
    const { service } = makeService({ answer: (argv) => (argv[1] === '30000' ? never : ok('wait', { waited_ms: 1 })) });
    const queued = Array.from({ length: 8 }, () => service.desktop(AGENT_A, { command: 'wait', args: { ms: 30_000 } }));
    for (const call of queued) call.catch(() => undefined);
    for (const call of queued.slice(DESKTOP_QUEUE_PER_AGENT)) await expect(call).rejects.toMatchObject({ code: 'input_busy' });
    await expect(service.desktop(AGENT_B, { command: 'wait', args: { ms: 1 } })).resolves.toMatchObject({ data: { waited_ms: 1 } });
  });

  it('refuses another agent\'s snapshot', async () => {
    const { service } = makeService();
    const id = await snapshotOf(service, AGENT_A);
    await expect(service.desktop(AGENT_B, { command: 'is', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
  });

  it('refuses commands outside the read-only list, naming the list', async () => {
    const { service, desktop } = makeService();
    for (const command of ['type', 'clipboard-get', 'batch', 'screenshot', 'launch', 'skills']) {
      await expect(service.desktop(AGENT_A, { command, app: 'TextEdit' })).rejects.toThrow(/must be one of snapshot, find, get, is, list-surfaces, wait/);
    }
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('answers bad args with the command\'s schema', async () => {
    const { service } = makeService();
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { headed: true } })).rejects.toThrow(/unknown field "headed".*snapshot args:/s);
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: 'e5' } })).rejects.toThrow(/a ref looks like "@s2gy5:e7"/);
  });

  it('refuses a root together with a surface other than window, before anything runs', async () => {
    const { service, desktop } = makeService();
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { root: '@s1:e1', surface: 'menu' } })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/root cannot be combined/) });
    await expect(service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { root: '@s1:e1', surface: 'sheet', name: 'OK' } })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/root cannot be combined/) });
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('passes a value that looks like a flag as one bound argument', async () => {
    const { service, runs } = makeService();
    await service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { name: '--headed' } });
    const find = runs.find((argv) => argv[0] === 'find')!;
    expect(find).toContain('--name=--headed');
    expect(find).not.toContain('--headed');
  });

  it('a missing nested binary reads as an unavailable helper', async () => {
    const { service } = makeService({
      answer: () => {
        throw new ComputerError('helper_unavailable', 'the desktop component is missing from this wmux build');
      },
    });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'helper_unavailable' });
  });

  it('a stop kills the runs in flight, and a run that comes back afterwards is not used', async () => {
    let release: (r: RunnerResult) => void = () => undefined;
    const { service, desktop } = makeService({ answer: () => new Promise<RunnerResult>((r) => { release = r; }) });
    const pending = service.desktop(AGENT_A, { command: 'wait', args: { ms: 20_000 } });
    await vi.waitFor(() => expect(desktop.run).toHaveBeenCalled(), { timeout: 5_000 });
    service.abort();
    expect(desktop.abort).toHaveBeenCalled();
    release(ok('wait', { waited_ms: 20_000 }));
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('a pause names no app', async () => {
    const { service, runs, calls } = makeService();
    await service.desktop(AGENT_A, { command: 'wait', args: { ms: 500 } });
    expect(runs[0]).toEqual(['wait', '500']);
    expect(calls).toEqual([]);
  });

  it('is unavailable where there is no runner', async () => {
    const { service } = makeService({ withDesktop: false });
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' })).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('maps agent-desktop\'s own failure to a wmux code', async () => {
    const { service } = makeService({
      answer: () => ({ exitCode: 1, stdout: JSON.stringify({ version: '2.6', ok: false, command: 'get', error: { code: 'STALE_REF', message: 'ref is stale' } }), stderr: '' }),
    });
    await expect(service.desktop(AGENT_A, { command: 'wait', args: { ms: 1 } })).rejects.toMatchObject({ code: 'element_stale', message: 'ref is stale' });
  });

  it('maps an upstream code that is a property of every object to internal', async () => {
    const { service } = makeService({
      answer: () => ({ exitCode: 1, stdout: JSON.stringify({ version: '2.6', ok: false, command: 'wait', error: { code: 'constructor', message: 'x' } }), stderr: '' }),
    });
    await expect(service.desktop(AGENT_A, { command: 'wait', args: { ms: 1 } })).rejects.toMatchObject({ code: 'internal' });
  });

  it('ends the runner and forgets every snapshot when computer use is turned off, and on dispose', async () => {
    const { service, desktop } = makeService();
    const id = await snapshotOf(service);
    service.turnedOff();
    expect(desktop.dispose).toHaveBeenCalledTimes(1);
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'aborted' });

    const other = makeService();
    const kept = await snapshotOf(other.service);
    other.setEnabled(false);
    await expect(other.service.desktop(AGENT_A, { command: 'get', args: { ref: `@${kept}:e1` } })).rejects.toMatchObject({ code: 'turned_off' });
    expect(other.desktop.dispose).toHaveBeenCalled();
    other.setEnabled(true);
    await expect(other.service.desktop(AGENT_A, { command: 'get', args: { ref: `@${kept}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });

    service.dispose();
    expect(desktop.dispose).toHaveBeenCalledTimes(2);
  });
});


/** A refmap entry as agent-desktop writes it, with the fields wmux pins. */
const entry = (over: Record<string, unknown> = {}) => ({
  pid: textEdit.pid, retained_object: 'tok-1', role: 'button', process_instance: 'inst-1', states: ['enabled'], ...over,
});
const refmapOf = (inner: Record<string, unknown>) => JSON.stringify({ inner, counter: Object.keys(inner).length });
const failed = (command: string, code: string, delivery?: string): RunnerResult => ({
  exitCode: 1,
  stdout: JSON.stringify({ version: '2.6', ok: false, command, error: { code, message: `${code} happened`, ...(delivery && { disposition: { delivery } }) } }),
  stderr: '',
});
const oneButton = refmapOf({ '@e1': entry() });

describe('ComputerService.desktopAct', () => {
  it('refuses every action on the read path before anything runs', async () => {
    const { service, desktop } = makeService();
    for (const command of ACTIONS) {
      await expect(service.desktop(AGENT_A, { command, args: { ref: '@s1:e1' } })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/is an action, not an observation/) });
    }
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('refuses a read on the action path before anything runs, as not delivered', async () => {
    const { service, desktop } = makeService();
    for (const command of ['get', 'snapshot', 'wait', 'type']) {
      await expect(service.desktopAct(AGENT_A, { command, args: { ref: '@s1:e1' } })).rejects.toMatchObject({ code: 'invalid_argument', disposition: 'not_delivered' });
    }
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('acts on a ref of the agent\'s window snapshot in the background, with no lease, and reports it unverified', async () => {
    const { service, runs, calls } = makeService({ refmap: oneButton });
    const id = await snapshotOf(service);
    const result = await service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } });
    expect(result).toEqual({ method: 'accessibility', verification: 'unverified', delivery: 'background', disposition: 'delivered_unverified' });
    expect(runs.at(-1)).toEqual(['click', `@${id}:e1`]);
    // Only the target was resolved: no lease, no foreground, no helper input.
    expect(calls.map((c) => c.method)).toEqual(['resolveTarget']);
    // The snapshot is still good for the next action.
    await expect(service.desktopAct(AGENT_A, { command: 'toggle', args: { ref: `@${id}:e1` } })).resolves.toMatchObject({ delivery: 'background' });
  });

  it('binds a select value after "--" and passes the scroll flags', async () => {
    const { service, runs } = makeService({ refmap: oneButton });
    const id = await snapshotOf(service);
    await service.desktopAct(AGENT_A, { command: 'select', args: { ref: `@${id}:e1`, value: '--app=Other' } });
    expect(runs.at(-1)).toEqual(['select', `@${id}:e1`, '--', '--app=Other']);
    await service.desktopAct(AGENT_A, { command: 'scroll', args: { ref: `@${id}:e1`, direction: 'down', amount: 3 } });
    expect(runs.at(-1)).toEqual(['scroll', `@${id}:e1`, '--direction=down', '--amount=3']);
  });

  it('caps a select value like the other string arguments, before anything runs', async () => {
    const { service, runs } = makeService({ refmap: oneButton });
    const id = await snapshotOf(service);
    await expect(service.desktopAct(AGENT_A, { command: 'select', args: { ref: `@${id}:e1`, value: 'x'.repeat(513) } })).rejects.toMatchObject({ code: 'invalid_argument', disposition: 'not_delivered' });
    expect(runs.some((argv) => argv[0] === 'select')).toBe(false);
    await expect(service.desktopAct(AGENT_A, { command: 'select', args: { ref: `@${id}:e1`, value: 'x'.repeat(512) } })).resolves.toMatchObject({ delivery: 'background' });
  });

  it('reports verified only when agent-desktop verified the effect', async () => {
    const { service } = makeService({ refmap: oneButton, act: () => ok('click', { disposition: { delivery: 'delivered_verified' } }) });
    const id = await snapshotOf(service);
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } })).resolves.toMatchObject({ verification: 'verified', disposition: 'delivered' });
  });

  it('a failure after the run started is possibly delivered unless agent-desktop says it sent nothing; none is re-run', async () => {
    for (const [reply, code, disposition] of [
      [failed('click', 'ACTION_FAILED'), 'internal', 'delivered_unverified'],
      [failed('click', 'TIMEOUT'), 'timeout', 'delivered_unverified'],
      [failed('click', 'ACTION_FAILED', 'delivery_uncertain'), 'internal', 'delivered_unverified'],
      [failed('click', 'STALE_REF', 'not_delivered'), 'element_stale', 'not_delivered'],
      // A headless refusal (it would need the pointer or the foreground): final.
      [failed('click', 'POLICY_DENIED', 'not_delivered'), 'action_not_supported', 'not_delivered'],
    ] as const) {
      const { service, runs, calls } = makeService({ refmap: oneButton, act: () => reply });
      const id = await snapshotOf(service);
      await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code, disposition });
      expect(runs.filter((argv) => argv[0] === 'click')).toHaveLength(1);
      expect(calls.map((c) => c.method)).toEqual(['resolveTarget']);
    }
  });

  it('a runner timeout after the start is possibly delivered; a failure before the start was not delivered', async () => {
    const timedOut = makeService({ refmap: oneButton, act: () => { throw new ComputerError('timeout', 'agent-desktop did not answer'); } });
    const a = await snapshotOf(timedOut.service);
    await expect(timedOut.service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${a}:e1` } })).rejects.toMatchObject({ code: 'timeout', disposition: 'delivered_unverified' });

    const unstarted = makeService({ refmap: oneButton, neverStarts: true, act: () => { throw new ComputerError('helper_unavailable', 'missing'); } });
    const b = await snapshotOf(unstarted.service);
    await expect(unstarted.service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${b}:e1` } })).rejects.toMatchObject({ code: 'helper_unavailable', disposition: 'not_delivered' });
  });

  it('a stop during the action kills it, reports it possibly delivered, and a late reply is not used', async () => {
    let release: (r: RunnerResult) => void = () => undefined;
    const { service, desktop } = makeService({ refmap: oneButton, act: () => new Promise<RunnerResult>((r) => { release = r; }) });
    const id = await snapshotOf(service);
    const pending = service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } });
    await vi.waitFor(() => expect((desktop.run as ReturnType<typeof vi.fn>).mock.calls.some(([argv]) => argv[0] === 'click')).toBe(true), { timeout: 5_000 });
    service.abort();
    expect(desktop.abort).toHaveBeenCalled();
    release(ok('click', {}));
    await expect(pending).rejects.toMatchObject({ code: 'aborted', disposition: 'delivered_unverified' });
  });

  it('refuses a ref whose snapshot or entry changed before the action, sending nothing', async () => {
    for (const changed of [refmapOf({ '@e1': entry({ role: 'textfield' }) }), refmapOf({ '@e1': entry({ retained_object: 'tok-2' }) }), refmapOf({ '@e1': entry({ pid: 999 }) })]) {
      const { service, runs, setRefmap } = makeService({ refmap: oneButton });
      const id = await snapshotOf(service);
      setRefmap(id, changed);
      await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown', disposition: 'not_delivered' });
      expect(runs.some((argv) => argv[0] === 'click')).toBe(false);
      // The snapshot is gone, for reads too.
      await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    }
  });

  it('drops the snapshot when the action left any pinned entry changed, and reports the action possibly delivered', async () => {
    const box: { set?: (id: string, text: string) => void; id?: string } = {};
    const { service, setRefmap } = makeService({
      refmap: refmapOf({ '@e1': entry(), '@e2': entry({ retained_object: 'tok-2' }) }),
      act: () => {
        // The action re-identified another element under @e2.
        box.set!(box.id!, refmapOf({ '@e1': entry(), '@e2': entry({ retained_object: 'tok-9' }) }));
        return ok('click', {});
      },
    });
    box.set = setRefmap;
    box.id = await snapshotOf(service);
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${box.id}:e1` } })).rejects.toMatchObject({ code: 'policy_denied', disposition: 'delivered_unverified' });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${box.id}:e2` } })).rejects.toMatchObject({ code: 'snapshot_unknown', disposition: 'not_delivered' });
  });

  it('never acts on a password field, nor on a text field from an incomplete snapshot', async () => {
    const secure = makeService({ refmap: refmapOf({ '@e1': entry({ role: 'textfield', states: ['enabled', 'secure'] }) }) });
    const a = await snapshotOf(secure.service);
    await expect(secure.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${a}:e1` } })).rejects.toMatchObject({ code: 'policy_denied', disposition: 'not_delivered' });
    expect(secure.runs.some((argv) => argv[0] === 'focus')).toBe(false);

    const partial = makeService({ refmap: refmapOf({ '@e1': entry({ role: 'textfield' }) }), snapshotData: { complete: false } });
    const b = await snapshotOf(partial.service);
    await expect(partial.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${b}:e1` } })).rejects.toMatchObject({ code: 'policy_denied' });

    const unreadable = makeService({ refmap: refmapOf({ '@e1': entry({ role: 'textfield', states: 'secure' }) }) });
    const d = await snapshotOf(unreadable.service);
    await expect(unreadable.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${d}:e1` } })).rejects.toMatchObject({ code: 'policy_denied' });

    // agent-desktop leaves an empty state list out: a plain text field.
    const plain = makeService({ refmap: refmapOf({ '@e1': { pid: textEdit.pid, retained_object: 'tok-1', role: 'textfield' } }) });
    const e = await snapshotOf(plain.service);
    await expect(plain.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${e}:e1` } })).resolves.toMatchObject({ delivery: 'background' });

    const whole = makeService({ refmap: refmapOf({ '@e1': entry({ role: 'textfield' }) }) });
    const c = await snapshotOf(whole.service);
    await expect(whole.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${c}:e1` } })).resolves.toMatchObject({ delivery: 'background' });
  });

  it('trusts a text field only when every read behind its snapshot was complete', async () => {
    // A drill (--root) answers complete for its subtree and keeps the rest of an incomplete snapshot.
    const box: { set?: (id: string, text: string) => void } = {};
    const field = refmapOf({ '@e1': entry({ role: 'group' }), '@e2': entry({ role: 'textfield', retained_object: 'tok-2' }) });
    const drilled = makeService({
      answer: (argv) => {
        box.set!('s1', field);
        const root = argv.some((a) => a.startsWith('--root='));
        return ok('snapshot', { app: 'TextEdit', snapshot_id: 's1', window: { id: 'w-5010' }, complete: root });
      },
    });
    box.set = drilled.setRefmap;
    await drilled.service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit' });
    await drilled.service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { root: '@s1:e1' } });
    await expect(drilled.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: '@s1:e2' } })).rejects.toMatchObject({ code: 'policy_denied' });

    // find names no completeness: its text fields are not trusted, its buttons are.
    const found = makeService({ refmap: refmapOf({ '@e1': entry({ role: 'textfield' }), '@e2': entry({ retained_object: 'tok-2' }) }) });
    const id = (await found.service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { name: 'Save' } })).data.snapshot_id as string;
    await expect(found.service.desktopAct(AGENT_A, { command: 'focus', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(found.service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e2` } })).resolves.toMatchObject({ delivery: 'background' });
  });

  it('takes no refs from a snapshot a wait made, whose window and surface nothing checked', async () => {
    const box: { set?: (id: string, text: string) => void } = {};
    const { service, runs, setRefmap } = makeService({
      answer: (argv) => {
        box.set!('sw', oneButton);
        return ok(argv[0], { found: true, ref: '@sw:e1', snapshot_id: 'sw' });
      },
    });
    box.set = setRefmap;
    await service.desktop(AGENT_A, { command: 'wait', app: 'TextEdit', args: { text: 'OK' } });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: '@sw:e1' } })).rejects.toMatchObject({ code: 'invalid_argument', disposition: 'not_delivered' });
    expect(runs.some((argv) => argv[0] === 'click')).toBe(false);
  });

  it('reports an action agent-desktop found already done as not delivered', async () => {
    const { service } = makeService({ refmap: oneButton, act: () => ok('check', { disposition: { delivery: 'not_delivered' } }) });
    const id = await snapshotOf(service);
    await expect(service.desktopAct(AGENT_A, { command: 'check', args: { ref: `@${id}:e1` } })).resolves.toMatchObject({ verification: 'verified', disposition: 'not_delivered' });
  });

  it('keeps the result of an action whose snapshot agent-desktop pruned meanwhile, and forgets the snapshot', async () => {
    const box: { set?: (id: string, text: string) => void; id?: string } = {};
    const { service, setRefmap } = makeService({
      refmap: oneButton,
      act: () => {
        box.set!(box.id!, '');
        return ok('click', { disposition: { delivery: 'delivered_verified' } });
      },
    });
    box.set = setRefmap;
    box.id = await snapshotOf(service);
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${box.id}:e1` } })).resolves.toMatchObject({ verification: 'verified', disposition: 'delivered' });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${box.id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
  });

  it('a stop that lands before the runner reported the start still reports the action possibly delivered', async () => {
    let release: ((r: RunnerResult) => void) | null = null;
    const { service } = makeService({
      refmap: oneButton,
      neverStarts: true,
      act: () => new Promise<RunnerResult>((r) => { release = r; }),
    });
    const id = await snapshotOf(service);
    const pending = service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } });
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5_000 });
    service.abort();
    release!(ok('click', {}));
    await expect(pending).rejects.toMatchObject({ code: 'aborted', disposition: 'delivered_unverified' });
  });

  it('takes refs from window snapshots only', async () => {
    const { service, runs } = makeService({ refmap: oneButton });
    const id = (await service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { surface: 'menu' } })).data.snapshot_id as string;
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'invalid_argument', disposition: 'not_delivered' });
    expect(runs.some((argv) => argv[0] === 'click')).toBe(false);
  });

  it('refuses a forged ref, an unknown snapshot and another agent\'s snapshot', async () => {
    const { service, runs } = makeService({ refmap: oneButton });
    const id = await snapshotOf(service, AGENT_A);
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e9` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: '@nope:e1' } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    await expect(service.desktopAct(AGENT_B, { command: 'click', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: 'e1' } })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(runs.some((argv) => argv[0] === 'click')).toBe(false);
  });

  it('counts against the input actions\' rate cap', async () => {
    const { service } = makeService({ refmap: oneButton });
    const id = await snapshotOf(service);
    for (let i = 0; i < CONTROL_RATE_PER_MINUTE; i += 1) await service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } });
    await expect(service.desktopAct(AGENT_A, { command: 'click', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'input_busy', disposition: 'not_delivered' });
  });

  it('waits in the agent\'s desktop queue: an action queued behind a running wait starts after it', async () => {
    let releaseWait: (() => void) | null = null;
    const box: { set?: (id: string, text: string) => void } = {};
    const { service, runs, setRefmap } = makeService({
      act: () => ok('click', {}),
      answer: async (argv) => {
        if (argv[0] === 'snapshot') {
          box.set!('s1', oneButton);
          return ok('snapshot', { app: 'TextEdit', snapshot_id: 's1', window: { id: 'w-5010' } });
        }
        await new Promise<void>((r) => { releaseWait = r; });
        return ok('wait', { found: true });
      },
    });
    box.set = setRefmap;
    await snapshotOf(service);
    const waiting = service.desktop(AGENT_A, { command: 'wait', args: { element: '@s1:e1' } });
    await vi.waitFor(() => expect(releaseWait).not.toBeNull(), { timeout: 5_000 });
    const clicking = service.desktopAct(AGENT_A, { command: 'click', args: { ref: '@s1:e1' } });
    await deliberateSleep(20, 'proving an absence: the click must not start while the wait holds the queue');
    expect(runs.some((argv) => argv[0] === 'click')).toBe(false);
    releaseWait!();
    await expect(waiting).resolves.toMatchObject({ data: { found: true } });
    await expect(clicking).resolves.toMatchObject({ delivery: 'background' });
    expect(runs.map((argv) => argv[0]).slice(-2)).toEqual(['wait', 'click']);
  });
});
