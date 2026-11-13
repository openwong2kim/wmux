// The fan-out policy file. Missing = the owner's defaults (auto, no approval);
// torn = the safe side (approval required). Each setter keeps the other field.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getFanoutWorkerPolicyPath,
  loadFanoutDepth,
  loadFanoutTasksPerCall,
  setFanoutDepth,
  setFanoutTasksPerCall,
  loadFanoutHourlyTaskCap,
  loadFanoutLiveTaskCap,
  loadFanoutOwnerAnswers,
  loadFanoutRequireApproval,
  loadFanoutTrustAgyFolders,
  loadFanoutWorkerPermissionMode,
  setFanoutHourlyTaskCap,
  setFanoutLiveTaskCap,
  setFanoutOwnerAnswers,
  setFanoutRequireApproval,
  setFanoutTrustAgyFolders,
  setFanoutWorkerPermissionMode,
} from '../fanoutWorkerPolicy';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-policy-'));

describe('fan-out policy store', () => {
  it('owner answers: all without a file, off while the file cannot be read (logged once), only a known value writes', async () => {
    const dir = tmp();
    expect(loadFanoutOwnerAnswers(dir)).toBe('all');
    expect(await setFanoutOwnerAnswers('none', dir)).toBe('all');
    expect(await setFanoutOwnerAnswers('menus', dir)).toBe('menus');
    await setFanoutRequireApproval(true, dir);
    expect(loadFanoutOwnerAnswers(dir)).toBe('menus');
    expect(loadFanoutRequireApproval(dir)).toBe(true);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ ownerAnswers: 'ALL' }), 'utf8');
    expect(loadFanoutOwnerAnswers(dir)).toBe('all');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
      expect(loadFanoutOwnerAnswers(dir)).toBe('off');
      expect(loadFanoutOwnerAnswers(dir)).toBe('off');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('orchestrators answer no prompts');
      // Read again, then torn again: logged again.
      fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ ownerAnswers: 'off' }), 'utf8');
      expect(loadFanoutOwnerAnswers(dir)).toBe('off');
      fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
      loadFanoutOwnerAnswers(dir);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

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

  it('fan-out caps: none when missing or not numbers, the old defaults when torn; clamped to bounds; null clears; kept across other writes', async () => {
    const dir = tmp();
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([null, null]);
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
    // null: no limit again.
    expect(await setFanoutLiveTaskCap(null, dir)).toBeNull();
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([null, 40]);
    // The old defaults set after the caps became optional stay set.
    expect(await setFanoutLiveTaskCap(8, dir)).toBe(8);
    expect(await setFanoutHourlyTaskCap(24, dir)).toBe(24);
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 24]);
    // A hand-edited file is clamped on read; garbage is no limit, a torn file the safe side (the old defaults).
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ liveTaskCap: -3, hourlyTaskCap: 1e9, taskCapsVersion: 2 }), 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([1, 200]);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ liveTaskCap: '50', hourlyTaskCap: null }), 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([null, null]);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 24]);
  });

  it('tasks per call and depth: 8 and 1 by default, clamped to 1–64 and 1–3, kept across other writes', async () => {
    const dir = tmp();
    expect([loadFanoutTasksPerCall(dir), loadFanoutDepth(dir)]).toEqual([8, 1]);
    expect(await setFanoutTasksPerCall(0, dir)).toBe(1);
    expect(await setFanoutTasksPerCall(500, dir)).toBe(64);
    expect(await setFanoutDepth(9, dir)).toBe(3);
    expect(await setFanoutDepth('2', dir)).toBe(3);
    await setFanoutRequireApproval(true, dir);
    expect([loadFanoutTasksPerCall(dir), loadFanoutDepth(dir)]).toEqual([64, 3]);
    fs.writeFileSync(getFanoutWorkerPolicyPath(dir), '{ torn', 'utf8');
    expect([loadFanoutTasksPerCall(dir), loadFanoutDepth(dir)]).toEqual([8, 1]);
  });

  it('a file from before the caps were optional: the old defaults become unset, other values stay, once', async () => {
    const dir = tmp();
    const write = (o: Record<string, unknown>) => fs.writeFileSync(getFanoutWorkerPolicyPath(dir), JSON.stringify({ permissionMode: 'auto', requireApproval: false, ...o }), 'utf8');
    write({ liveTaskCap: 8, hourlyTaskCap: 24 });
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([null, null]);
    write({ liveTaskCap: 5, hourlyTaskCap: 24 });
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([5, null]);
    write({});
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([null, null]);
    // The first write records the reading; a later 8 the owner sets is not read as unset again.
    write({ liveTaskCap: 8, hourlyTaskCap: 30 });
    await setFanoutRequireApproval(true, dir);
    const stored = JSON.parse(fs.readFileSync(getFanoutWorkerPolicyPath(dir), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ liveTaskCap: null, hourlyTaskCap: 30, taskCapsVersion: 2 });
    expect(await setFanoutLiveTaskCap(8, dir)).toBe(8);
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 30]);
    // Read again: the same answer (idempotent).
    expect([loadFanoutLiveTaskCap(dir), loadFanoutHourlyTaskCap(dir)]).toEqual([8, 30]);
  });
});
