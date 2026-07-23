import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  mintMachineId,
  readMachineId,
  writeMachineId,
  resolveMachineId,
  recoverMachineIdFromRecords,
  machineIdPath,
} from '../machineId';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-machineid-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('machineId', () => {
  it('mintMachineId generates uuid form', () => {
    expect(mintMachineId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('readMachineId: null when absent', () => {
    expect(readMachineId(dir)).toBeNull();
  });

  it('resolveMachineId: first call mints·durable write; recall loads same value (no re-mint)', () => {
    const first = resolveMachineId(dir);
    // Written to file as a raw string matching the return value.
    expect(fs.readFileSync(machineIdPath(dir), 'utf-8')).toBe(first);
    const second = resolveMachineId(dir);
    expect(second).toBe(first); // no re-minting
  });

  it('resolveMachineId: missing file + record recovery hook → rewrites recovered value without re-mint', () => {
    const recovered = resolveMachineId(dir, {
      recoverFromRecords: () => 'recovered-id',
    });
    expect(recovered).toBe('recovered-id');
    // Segment is evidence — re-write the recovered value to file.
    expect(readMachineId(dir)).toBe('recovered-id');
  });

  it('recoverMachineIdFromRecords: returns first valid origin.machineId', () => {
    expect(
      recoverMachineIdFromRecords([
        { origin: {} },
        { origin: { machineId: 'mA' } },
        { origin: { machineId: 'mB' } },
      ]),
    ).toBe('mA');
    expect(recoverMachineIdFromRecords([])).toBeUndefined();
  });

  it('writeMachineId → readMachineId round-trip', () => {
    writeMachineId(dir, 'fixed-uuid');
    expect(readMachineId(dir)).toBe('fixed-uuid');
  });
});
