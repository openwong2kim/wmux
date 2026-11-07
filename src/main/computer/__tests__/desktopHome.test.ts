import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearDesktopSnapshots, prepareDesktopHome } from '../desktopHome';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adhome-'));

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

  it('is a no-op when there is no home yet', async () => {
    await expect(clearDesktopSnapshots(path.join(tmp(), 'absent'))).resolves.toBeUndefined();
  });

  it('creates the home private, and tightens an existing one', async () => {
    const home = path.join(tmp(), 'agent-desktop');
    await prepareDesktopHome(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(home, 0o755);
    await prepareDesktopHome(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});
