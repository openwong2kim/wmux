import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import { HelperProcess } from '../HelperProcess';

const TARGET = { pid: 1, windowId: 'w1' };
const FAKE = path.join(__dirname, 'fixtures', 'fakeHelper.mjs');

const helpers: HelperProcess[] = [];

function makeHelper(mode: string, extra: Partial<ConstructorParameters<typeof HelperProcess>[0]> = {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-helper-')), 'requests.log');
  const helper = new HelperProcess({
    command: process.execPath,
    args: [FAKE, mode, logFile],
    helloTimeoutMs: 2_000,
    timeoutFor: () => 1_000,
    ...extra,
  });
  helpers.push(helper);
  const requests = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []);
  const releases = () => (fs.existsSync(`${logFile}.params`)
    ? fs.readFileSync(`${logFile}.params`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    : []);
  return { helper, requests, releases };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof ComputerError ? err.code : `non-computer error: ${String(err)}`;
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

afterEach(() => {
  for (const h of helpers.splice(0)) h.dispose();
});

describe('HelperProcess', () => {
  it('starts on first request and answers it', async () => {
    const { helper } = makeHelper('ok');
    const caps = await helper.request('capabilities', {});
    expect(caps.actions).toEqual(['click']);
    expect(helper.hello?.helperVersion).toBe('fake');
  });

  it('serialises concurrent requests and matches each response', async () => {
    const { helper, requests } = makeHelper('ok');
    const results = await Promise.all([
      helper.request('listApps', {}),
      helper.request('listWindows', {}),
      helper.request('releaseInput', {}),
    ]);
    expect(results.map((r) => (r as unknown as { echo: string }).echo)).toEqual(['listApps', 'listWindows', 'releaseInput']);
    expect(requests()).toEqual(['listApps', 'listWindows', 'releaseInput']);
  });

  it('carries a helper error code through', async () => {
    const { helper } = makeHelper('ok');
    expect(await codeOf(helper.request('fail' as never, {} as never))).toBe('element_stale');
  });

  it('refuses a helper that speaks another protocol version (after one retry)', async () => {
    const { helper } = makeHelper('old');
    expect(await codeOf(helper.request('capabilities', {}))).toBe('helper_incompatible');
  });

  it('gives up on a helper that never says hello', async () => {
    const { helper } = makeHelper('silent', { helloTimeoutMs: 300 });
    expect(await codeOf(helper.request('capabilities', {}))).toBe('helper_unavailable');
  });

  it('reports a missing helper binary as unavailable', async () => {
    const helper = new HelperProcess({ command: path.join(os.tmpdir(), 'no-such-helper-binary') });
    helpers.push(helper);
    expect(await codeOf(helper.request('capabilities', {}))).toBe('helper_unavailable');
  });

  it('kills a hung helper on timeout and releases held input at once, without a next request', async () => {
    const { helper, requests } = makeHelper('hang', { timeoutFor: () => 300 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: ['ctrl'],
    });
    expect(await codeOf(click)).toBe('timeout');
    // A replacement helper is started just to release held input.
    expect(await waitFor(() => requests().length === 2)).toBe(true);
    expect(requests()).toEqual(['click', 'releaseInput']);
    await helper.request('listApps', {});
    expect(requests()).toEqual(['click', 'releaseInput', 'listApps']);
  });

  it('kills a helper that sends garbage', async () => {
    const { helper } = makeHelper('garbage');
    expect(await codeOf(helper.request('listApps', {}))).toBe('internal');
  });

  it('kills a helper that answers a request nobody sent', async () => {
    const { helper } = makeHelper('wrong-id');
    expect(await codeOf(helper.request('listApps', {}))).toBe('internal');
  });

  it('abort fails the in-flight request and the next call starts fresh', async () => {
    const { helper, requests } = makeHelper('hang', { timeoutFor: () => 5_000 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    // Let the request reach the helper before stopping it.
    expect(await waitFor(() => requests().includes('click'))).toBe(true);
    helper.abort();
    expect(await codeOf(click)).toBe('aborted');
    expect(await waitFor(() => requests().length === 2)).toBe(true);
    expect(requests()).toEqual(['click', 'releaseInput']);
    await helper.request('listApps', {});
    expect(requests()).toEqual(['click', 'releaseInput', 'listApps']);
  });

  it('drops a request queued behind the one in flight when abort runs', async () => {
    const { helper, requests } = makeHelper('hang', { timeoutFor: () => 5_000 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    const queued = helper.request('type', { snapshotId: 's', target: TARGET, text: 'secret' });
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    helper.abort();
    expect(await codeOf(click)).toBe('aborted');
    expect(await codeOf(queued)).toBe('aborted');
    // The queued type never reaches a helper; only the release does.
    expect(await waitFor(() => requests().length === 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(requests()).toEqual(['click', 'releaseInput']);
  });

  it('decodes a multibyte character split across stdout chunks', async () => {
    const { helper } = makeHelper('split-utf8');
    const { apps } = await helper.request('listApps', {});
    expect(apps[0].name).toBe('메모장');
  });

  it('survives a helper that exits on the first request', async () => {
    const { helper } = makeHelper('exit');
    expect(await codeOf(helper.request('listApps', {}))).toBe('helper_unavailable');
    expect(await codeOf(helper.request('listApps', {}))).toBe('helper_unavailable');
  });

  it('kills an idle helper that ignores stdin EOF', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const { helper } = makeHelper('deaf', {
      idleExitMs: 50,
      idleKillGraceMs: 50,
      spawn: (cmd, args) => (child = spawn(cmd, [...args], { stdio: 'pipe' })),
    });
    await helper.request('listApps', {});
    const exited = await new Promise<boolean>((resolve) => {
      child?.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    });
    expect(exited).toBe(true);
  });

  it('releases held input when a control request gets an invalid or unknown-id reply', async () => {
    for (const mode of ['garbage', 'wrong-id']) {
      const { helper, requests } = makeHelper(mode);
      const click = helper.request('click', {
        snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
      });
      expect(await codeOf(click), mode).toBe('internal');
      expect(await waitFor(() => requests().includes('releaseInput')), mode).toBe(true);
      expect(requests()[0]).toBe('click');
    }
  });

  it('fails input closed while no helper confirms the release, but lets observation through', async () => {
    const { helper, requests } = makeHelper('hang-norelease', { timeoutFor: () => 300 });
    const click = () => helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    expect(await codeOf(click())).toBe('timeout');
    // Background releases are bounded, then the next request retries.
    await waitFor(() => requests().filter((r) => r === 'releaseInput').length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    const before = requests().filter((r) => r === 'releaseInput').length;
    expect(before).toBe(3);
    expect(await codeOf(click())).toBe('internal');
    // Two more release attempts, each on a fresh helper, and no second click.
    expect(requests().filter((r) => r === 'releaseInput').length).toBe(before + 2);
    expect(requests().filter((r) => r === 'click')).toHaveLength(1);
    expect(await codeOf(helper.request('listApps', {}))).toBe('resolved');
  });

  it('a second stop during the release kills it and schedules another', async () => {
    const { helper, requests } = makeHelper('hang-releasehang', { timeoutFor: () => 5_000 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    helper.abort();
    expect(await codeOf(click)).toBe('aborted');
    expect(await waitFor(() => requests().includes('releaseInput'))).toBe(true);
    helper.abort();
    expect(await waitFor(() => requests().filter((r) => r === 'releaseInput').length === 2)).toBe(true);
  });

  it('dispose mid-input closes stdin first so the helper can release on EOF', async () => {
    const { helper, requests } = makeHelper('eof-release', { timeoutFor: () => 5_000, disposeReleaseGraceMs: 2_000 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    helper.dispose();
    expect(await codeOf(click)).toBe('helper_unavailable');
    expect(await waitFor(() => requests().includes('eof-release'), 2_000)).toBe(true);
    expect(requests()).toEqual(['click', 'eof-release']);
  });

  it('ignores late output from a dead helper: it never touches the replacement\'s request', async () => {
    // Scripted children, so the dead one can still talk after it was replaced.
    const children: Array<{ child: ChildProcessWithoutNullStreams; say: (o: unknown) => void; sent: Array<{ id: number; method: string }>; killed: boolean }> = [];
    const fakeSpawn = () => {
      const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const entry = { child: emitter, say: (o: unknown) => stdout.write(`${JSON.stringify(o)}\n`), sent: [] as Array<{ id: number; method: string }>, killed: false };
      stdin.on('data', (d: Buffer) => { for (const line of String(d).split('\n').filter(Boolean)) entry.sent.push(JSON.parse(line)); });
      Object.assign(emitter, { stdout, stdin, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => { entry.killed = true; return true; } });
      children.push(entry);
      queueMicrotask(() => entry.say({ type: 'hello', protocolVersion: 2, os: 'darwin', helperVersion: 'x', capabilities: { actions: [], modes: [], permissions: {} } }));
      return emitter;
    };
    const helper = new HelperProcess({ command: 'unused', spawn: fakeSpawn, timeoutFor: () => 100 });
    helpers.push(helper);
    const click = helper.request('click', { snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [] });
    expect(await codeOf(click)).toBe('timeout');
    expect(await waitFor(() => children.length === 2 && children[1].sent.length === 1)).toBe(true);
    const [dead, live] = children;
    const release = live.sent[0];
    expect(release.method).toBe('releaseInput');
    // The dead helper answers the live one's id, then sends garbage.
    dead.say({ id: release.id, ok: true, result: { released: true } });
    dead.say({ nonsense: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(live.killed).toBe(false);
    live.say({ id: release.id, ok: true, result: { released: true } });
    const apps = helper.request('listApps', {});
    expect(await waitFor(() => live.sent.length === 2)).toBe(true);
    live.say({ id: live.sent[1].id, ok: true, result: { apps: [] } });
    expect(await codeOf(apps)).toBe('resolved');
  });

  it('names exactly what the cut-off request sent in the release, never a blanket key list', async () => {
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>]> = [];
    const hotkey = makeHelper('hang', { timeoutFor: () => 200 });
    cases.push(['hotkey', () => hotkey.helper.request('hotkey', { snapshotId: 's', target: TARGET, modifiers: ['ctrl', 'shift'], key: 't' }), { keys: ['t'], modifiers: ['ctrl', 'shift'] }]);
    const press = makeHelper('hang', { timeoutFor: () => 200 });
    cases.push(['pressKey', () => press.helper.request('pressKey', { snapshotId: 's', target: TARGET, key: 'Enter', repeat: 1 }), { keys: ['Enter'] }]);
    const click = makeHelper('hang', { timeoutFor: () => 200 });
    cases.push(['click', () => click.helper.request('click', { snapshotId: 's', target: TARGET, index: 1, button: 'right', clickCount: 1, modifiers: ['alt'] }), { modifiers: ['alt'], buttons: ['right'] }]);
    const helpersByCase = [hotkey, press, click];
    for (const [i, [name, run, expected]] of cases.entries()) {
      expect(await codeOf(run()), name).toBe('timeout');
      expect(await waitFor(() => helpersByCase[i].releases().length === 1), name).toBe(true);
      expect(helpersByCase[i].releases()[0], name).toEqual(expected);
    }
  });

  it('a release cut off by a second stop carries the same keys to the next one', async () => {
    const { helper, requests, releases } = makeHelper('hang-releasehang', { timeoutFor: () => 5_000 });
    const hk = helper.request('hotkey', { snapshotId: 's', target: TARGET, modifiers: ['meta'], key: 's' });
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    helper.abort();
    expect(await codeOf(hk)).toBe('aborted');
    expect(await waitFor(() => releases().length === 1)).toBe(true);
    helper.abort();
    expect(await waitFor(() => releases().length === 2)).toBe(true);
    expect(releases()).toEqual([{ keys: ['s'], modifiers: ['meta'] }, { keys: ['s'], modifiers: ['meta'] }]);
  });

  it('starts no helper to release input once disposed', async () => {
    let spawns = 0;
    const { helper, requests } = makeHelper('hang', {
      timeoutFor: () => 5_000,
      spawn: (cmd, args) => { spawns += 1; return spawn(cmd, [...args], { stdio: 'pipe' }); },
    });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    helper.dispose();
    helper.abort();
    expect(await codeOf(click)).toBe('helper_unavailable');
    await new Promise((r) => setTimeout(r, 300));
    expect(spawns).toBe(1);
    expect(requests()).toEqual(['click']);
  });

  it('kills a helper that was still starting when dispose ran', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    // 'silent' never says hello, so the helper is certainly still starting.
    const { helper } = makeHelper('silent', {
      helloTimeoutMs: 10_000,
      spawn: (cmd, args) => (child = spawn(cmd, [...args], { stdio: 'pipe' })),
    });
    const pending = helper.request('listApps', {});
    await waitFor(() => child !== undefined);
    helper.dispose();
    expect(await codeOf(pending)).toBe('helper_unavailable');
    expect(await waitFor(() => child?.exitCode !== null || child?.signalCode !== null)).toBe(true);
    expect(helper.hello).toBeNull();
  });

  it('refuses work after dispose', async () => {
    const { helper } = makeHelper('ok');
    helper.dispose();
    expect(await codeOf(helper.request('listApps', {}))).toBe('helper_unavailable');
  });
});
