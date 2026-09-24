// The fan-out policy file. Missing = the owner's defaults (auto, no approval);
// torn = the safe side (approval required). Each setter keeps the other field.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getFanoutWorkerPolicyPath,
  loadFanoutRequireApproval,
  loadFanoutWorkerPermissionMode,
  setFanoutRequireApproval,
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
});
