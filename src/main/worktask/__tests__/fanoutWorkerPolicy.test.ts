// The fan-out policy file. Missing = the owner's defaults (auto, no approval);
// torn = the safe side (approval required). Each setter keeps the other field.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getFanoutWorkerPolicyPath,
  loadFanoutHourlyTaskCap,
  loadFanoutLiveTaskCap,
  loadFanoutRequireApproval,
  loadFanoutTrustAgyFolders,
  loadFanoutWorkerPermissionMode,
  setFanoutHourlyTaskCap,
  setFanoutLiveTaskCap,
  setFanoutRequireApproval,
  setFanoutTrustAgyFolders,
  setFanoutWorkerPermissionMode,
} from '../fanoutWorkerPolicy';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-policy-'));

describe('fan-out policy store', () => {
  it('defaults to auto and no approval when there is no file', () => {
    const dir = tmp();
    expect(loadFanoutWorkerPermissionMode(dir)).toBe('auto');
    expect(loadFanoutRequireApproval(dir)).toBe(false);
  });

  it('requires approval when the file cannot be read', () => {
    const dir = tmp();
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
    expect(loadFanoutRequireApproval(dir)).toBe(true);
    expect(loadFanoutWorkerPermissionMode(dir)).toBe('auto');
  });

  it('keeps each setting when the other is written, and ignores non-values', async () => {
    const dir = tmp();
    await setFanoutRequireApproval(true, dir);
    await setFanoutWorkerPermissionMode('acceptEdits', dir);
    expect(loadFanoutRequireApproval(dir)).toBe(true);
    expect(loadFanoutWorkerPermissionMode(dir)).toBe('acceptEdits');
    expect(await setFanoutRequireApproval('yes', dir)).toBe(true);
    expect(await setFanoutWorkerPermissionMode('manualish', dir)).toBe('acceptEdits');
  });

  it('agy folder trust is opt-in: off without a file, off when torn, only a literal true turns it on', async () => {
    const dir = tmp();
    expect(loadFanoutTrustAgyFolders(dir)).toBe(false);
    expect(await setFanoutTrustAgyFolders('true', dir)).toBe(false);
    expect(await setFanoutTrustAgyFolders(true, dir)).toBe(true);
    expect(loadFanoutTrustAgyFolders(dir)).toBe(true);
    // The other settings survive the write, and the switch survives theirs.
    await setFanoutRequireApproval(true, dir);
    expect(loadFanoutTrustAgyFolders(dir)).toBe(true);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ trustAgyFolders: 'yes' }), 'utf8');
    expect(loadFanoutTrustAgyFolders(dir)).toBe(false);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
    expect(loadFanoutTrustAgyFolders(dir)).toBe(false);
  });

  it('fan-out caps: defaults when missing, torn or not numbers; clamped to bounds; kept across other writes', async () => {
    const dir = tmp();
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 24]);
    expect(await setFanoutLiveTaskCap(0, dir)).toBe(1);
    expect(await setFanoutLiveTaskCap(999, dir)).toBe(32);
    expect(await setFanoutHourlyTaskCap(999, dir)).toBe(200);
    expect(await setFanoutHourlyTaskCap(40.4, dir)).toBe(40);
    // Not a number: nothing is written, the stored cap stands.
    expect(await setFanoutLiveTaskCap('16', dir)).toBe(32);
    expect(await setFanoutHourlyTaskCap(Number.NaN, dir)).toBe(40);
    await setFanoutRequireApproval(true, dir);
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([32, 40]);
    expect(await setFanoutLiveTaskCap(4, dir)).toBe(4);
    expect(loadFanoutRequireApproval(dir)).toBe(true);
    // A hand-edited file is clamped on read; garbage and a torn file are the defaults.
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ liveTaskCap: -3, hourlyTaskCap: 1e9 }), 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([1, 200]);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ liveTaskCap: '50', hourlyTaskCap: null }), 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 24]);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 24]);
  });
});
