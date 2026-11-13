import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sweepStaleTempDirs } from '../../../test-utils/staleTempDirs';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';
import { clearDesktopSnapshots, endDesktopRunner, prepareDesktopHome } from '../desktopHome';

// Each test's dirs are removed after it (trackedTempDir). They are made in a
// temp dir of this file's own, so the count left behind is exact even while
// another run of this file shares the machine's temp dir.
let ownTmp = '';
const tmp = () => trackedTempDir('adhome-');

beforeAll(() => {
  // One a killed run of this file left.
  sweepStaleTempDirs('wmux-adhome-count-');
  ownTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-adhome-count-'));
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(k, ownTmp);
});
// Runs before trackedTempDir's own afterAll: only per-test dirs are removed by now.
afterAll(() => {
  vi.unstubAllEnvs();
  if (!ownTmp) return;
  const left = fs.readdirSync(ownTmp);
  fs.rmSync(ownTmp, { recursive: true, force: true });
  expect(left).toEqual([]);
});

function seed(home: string): void {
  fs.mkdirSync(path.join(home, 'snapshots', 's1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'snapshots', 's1', 'refmap.json'), '{"inner":{"@e1":{"name":"Vault entry","value":"x"}}}');
  fs.writeFileSync(path.join(home, 'latest_snapshot_id'), 's1');
  fs.writeFileSync(path.join(home, 'refstore.lock'), '');
}

describe('agent-desktop home', () => {
  it('removes saved snapshots and nothing else', async () => {
    const home = path.join(tmp(), 'agent-desktop');
    await prepareDesktopHome(home);
    seed(home);
    await clearDesktopSnapshots(home);
    expect(fs.existsSync(path.join(home, 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'latest_snapshot_id'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'refstore.lock'))).toBe(true);
  });

  it('does not follow a home that is a symlink', async () => {
    const elsewhere = tmp();
    seed(elsewhere);
    const home = path.join(tmp(), 'agent-desktop');
    fs.symlinkSync(elsewhere, home);
    await clearDesktopSnapshots(home);
    expect(fs.existsSync(path.join(elsewhere, 'snapshots', 's1', 'refmap.json'))).toBe(true);
  });

  it('clears again once the runner has exited, taking a snapshot a dying child wrote after the first clear', async () => {
    const home = path.join(tmp(), 'agent-desktop');
    await prepareDesktopHome(home);
    seed(home);
    let exit: () => void = () => undefined;
    const runner = { dispose: () => new Promise<void>((resolve) => { exit = resolve; }) };
    const ending = endDesktopRunner(runner, home);
    await vi.waitFor(() => expect(fs.existsSync(path.join(home, 'snapshots'))).toBe(false), { timeout: 5_000 });
    // The child, still dying, writes one more snapshot; then the runner's exit arrives.
    seed(home);
    exit();
    await ending;
    expect(fs.existsSync(path.join(home, 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'latest_snapshot_id'))).toBe(false);
  });

  it('is a no-op when there is no home yet', async () => {
    await expect(clearDesktopSnapshots(path.join(tmp(), 'absent'))).resolves.toBeUndefined();
  });

  // POSIX modes; agent-desktop runs on macOS only.
  it.skipIf(process.platform === 'win32')('creates the home private, and tightens an existing one', async () => {
    const home = path.join(tmp(), 'agent-desktop');
    await prepareDesktopHome(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(home, 0o755);
    await prepareDesktopHome(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});
