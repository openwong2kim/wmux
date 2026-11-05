// #3050 — a pane that was passthrough only because "Withhold credentials from
// agent panes" was off is not restored as a user shell after a restart: the
// grant asks the setting again. A record written before #3050 (no mark) still
// restores as a user shell. The record never holds an env value.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserShellRecord, credentialEnvFor } from '../userShellRecord';
import { setCredentialEnvPrefsStoreForTests } from '../credentialEnvPrefs';

const listed = { id: 'p1', cmd: 'zsh', incarnationId: 'inc-1' };
const liveEnv = { GITHUB_TOKEN: 'ghp_secretvalue', PATH: '/usr/bin' };

function useSetting(withholdFromAgents: boolean): void {
  setCredentialEnvPrefsStoreForTests({ load: () => ({ withholdFromAgents }), save: () => undefined });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usr-shell-rec-'));
});
afterEach(() => {
  setCredentialEnvPrefsStoreForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('credentialEnvFor with a setting-granted entry', () => {
  it('withholds credentials once the setting is back on', () => {
    useSetting(true);
    expect(credentialEnvFor(listed, { cmd: 'zsh', incarnationId: 'inc-1', viaSetting: true }, liveEnv)).toBeUndefined();
  });

  it('grants them while the setting is still off', () => {
    useSetting(false);
    expect(credentialEnvFor(listed, { cmd: 'zsh', incarnationId: 'inc-1', viaSetting: true }, liveEnv)).toMatchObject({ GITHUB_TOKEN: 'ghp_secretvalue' });
  });

  it('keeps an entry without the mark a user shell whatever the setting says', () => {
    useSetting(true);
    expect(credentialEnvFor(listed, { cmd: 'zsh', incarnationId: 'inc-1' }, liveEnv)).toMatchObject({ GITHUB_TOKEN: 'ghp_secretvalue' });
  });
});

describe('UserShellRecord on disk', () => {
  it('keeps the mark across a reload and stores no env value', () => {
    useSetting(true);
    const recordFile = path.join(dir, 'record.json');
    const holdsFile = path.join(dir, 'holds.json');
    const first = new UserShellRecord(recordFile, holdsFile, () => undefined);
    first.set('p1', { cmd: 'zsh', incarnationId: 'inc-1', viaSetting: true });
    first.set('p2', { cmd: 'zsh', incarnationId: 'inc-2' });

    const reloaded = new UserShellRecord(recordFile, holdsFile, () => undefined);
    expect(reloaded.get('p1')).toEqual({ cmd: 'zsh', incarnationId: 'inc-1', viaSetting: true });
    expect(reloaded.get('p2')).toEqual({ cmd: 'zsh', incarnationId: 'inc-2' });
    expect(credentialEnvFor(listed, reloaded.get('p1'), liveEnv)).toBeUndefined();

    const onDisk = fs.readFileSync(recordFile, 'utf8') + fs.readFileSync(holdsFile, 'utf8');
    expect(onDisk).not.toContain('ghp_secretvalue');
    expect(onDisk).not.toContain('GITHUB_TOKEN');
  });

  it('rewrites an entry whose mark changed', () => {
    const recordFile = path.join(dir, 'record.json');
    const rec = new UserShellRecord(recordFile, path.join(dir, 'holds.json'), () => undefined);
    rec.set('p1', { cmd: 'zsh', incarnationId: 'inc-1' });
    rec.set('p1', { cmd: 'zsh', incarnationId: 'inc-1', viaSetting: true });
    expect(new UserShellRecord(recordFile, path.join(dir, 'holds.json'), () => undefined).get('p1')?.viaSetting).toBe(true);
  });
});
