import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
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
  return { helper, requests };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof ComputerError ? err.code : `non-computer error: ${String(err)}`;
  }
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

  it('kills a hung helper on timeout and releases input on the next one', async () => {
    const { helper, requests } = makeHelper('hang', { timeoutFor: () => 300 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: ['ctrl'],
    });
    expect(await codeOf(click)).toBe('timeout');
    await helper.request('listApps', {});
    // The replacement helper was told to release held input before anything else.
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
    await new Promise((r) => setTimeout(r, 300));
    helper.abort();
    expect(await codeOf(click)).toBe('aborted');
    await helper.request('listApps', {});
    expect(requests()).toEqual(['click', 'releaseInput', 'listApps']);
  });

  it('drops a request queued behind the one in flight when abort runs', async () => {
    const { helper, requests } = makeHelper('hang', { timeoutFor: () => 5_000 });
    const click = helper.request('click', {
      snapshotId: 's', target: TARGET, index: 1, button: 'left', clickCount: 1, modifiers: [],
    });
    const queued = helper.request('type', { snapshotId: 's', target: TARGET, text: 'secret' });
    await new Promise((r) => setTimeout(r, 300));
    helper.abort();
    expect(await codeOf(click)).toBe('aborted');
    expect(await codeOf(queued)).toBe('aborted');
    expect(requests()).toEqual(['click']);
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

  it('refuses work after dispose', async () => {
    const { helper } = makeHelper('ok');
    helper.dispose();
    expect(await codeOf(helper.request('listApps', {}))).toBe('helper_unavailable');
  });
});
