import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import type { AppInfo, HelperMethod, WindowInfo } from '../../../shared/computer/protocol';
import { ComputerService, DESKTOP_MAX_RUNS, type ComputerAgent, type DesktopDeps, type HelperLike } from '../ComputerService';
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
function makeService(opts: { answer?: (argv: string[]) => RunnerResult | Promise<RunnerResult>; askPerApp?: boolean; withDesktop?: boolean } = {}) {
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
  const runs: string[][] = [];
  const defaultAnswer = (argv: string[]): RunnerResult => {
    if (argv[0] === 'snapshot' || argv[0] === 'find') {
      const id = `s${++seq}`;
      const windowId = argv.find((a) => a.startsWith('--window-id='))?.slice('--window-id='.length);
      refmaps.set(id, refmapFor(textEdit.pid));
      // A find reply names no window (agent-desktop find_live.rs).
      if (argv[0] === 'find') return ok('find', { matches: [{ ref_id: `@${id}:e1`, name: 'Save' }], snapshot_id: id, total_matches: 1, truncated: false });
      return ok('snapshot', { app: 'TextEdit', snapshot_id: id, window: { id: windowId, title: 'Untitled' }, tree: {} });
    }
    if (argv[0] === 'list-surfaces') return ok('list-surfaces', { pid: textEdit.pid, surfaces: [] });
    return ok(argv[0], { value: 'Hello' });
  };
  const desktop: DesktopDeps = {
    run: vi.fn(async (argv: string[]) => {
      runs.push(argv);
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
          setRefmap('s1', JSON.stringify({ inner: { '@e1': { pid: textEdit.pid, healed: true } }, counter: 1 }));
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

  it('discards a surface list for another pid', async () => {
    const { service } = makeService({ answer: () => ok('list-surfaces', { pid: 999, surfaces: [{ id: 'w-1', type: 'window', title: 'Vault' }] }) });
    await expect(service.desktop(AGENT_A, { command: 'list-surfaces', app: 'TextEdit' })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('refuses another agent\'s snapshot', async () => {
    const { service } = makeService();
    const id = await snapshotOf(service, AGENT_A);
    await expect(service.desktop(AGENT_B, { command: 'is', args: { ref: `@${id}:e1` } })).rejects.toMatchObject({ code: 'snapshot_unknown' });
  });

  it('refuses commands outside the read-only list, naming the list', async () => {
    const { service, desktop } = makeService();
    for (const command of ['click', 'type', 'clipboard-get', 'batch', 'screenshot', 'launch', 'skills']) {
      await expect(service.desktop(AGENT_A, { command, app: 'TextEdit' })).rejects.toThrow(/must be one of snapshot, find, get, is, list-surfaces, wait/);
    }
    expect(desktop.run).not.toHaveBeenCalled();
  });

  it('answers bad args with the command\'s schema', async () => {
    const { service } = makeService();
    await expect(service.desktop(AGENT_A, { command: 'snapshot', app: 'TextEdit', args: { headed: true } })).rejects.toThrow(/unknown field "headed".*snapshot args:/s);
    await expect(service.desktop(AGENT_A, { command: 'get', args: { ref: 'e5' } })).rejects.toThrow(/a ref looks like "@s2gy5:e7"/);
  });

  it('passes a value that looks like a flag as one bound argument', async () => {
    const { service, runs } = makeService();
    await service.desktop(AGENT_A, { command: 'find', app: 'TextEdit', args: { name: '--headed' } });
    expect(runs[0]).toContain('--name=--headed');
    expect(runs[0]).not.toContain('--headed');
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
