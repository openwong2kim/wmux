import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  BACKUP_SUFFIXES,
  isManagedBackup,
  readWithBackupFallback,
  readWithBackupFallbackSync,
  rotateBackups,
  rotateBackupsSync,
  stateSlotsOnDisk,
} from '../rotation';
import { atomicWriteJSON } from '../core';

let tmpDir: string;
let targetPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rotation-test-'));
  targetPath = path.join(tmpDir, 'data.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeRaw(suffix: '' | (typeof BACKUP_SUFFIXES)[number], body: string): void {
  fs.writeFileSync(`${targetPath}${suffix}`, body, 'utf-8');
}

function readRaw(suffix: '' | (typeof BACKUP_SUFFIXES)[number]): string | null {
  const p = `${targetPath}${suffix}`;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

// ── BACKUP_SUFFIXES + isManagedBackup ───────────────────────────────

describe('BACKUP_SUFFIXES', () => {
  it('exports the canonical four-slot chain in newest-first order', () => {
    expect([...BACKUP_SUFFIXES]).toEqual(['.bak', '.bak.1', '.bak.2', '.bak.3']);
  });
});

describe('isManagedBackup', () => {
  it('recognises each managed slot for a given basename', () => {
    expect(isManagedBackup('sessions.json', 'sessions.json.bak')).toBe(true);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.1')).toBe(true);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.2')).toBe(true);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.3')).toBe(true);
  });

  it('rejects slot indices beyond the chain', () => {
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.4')).toBe(false);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.10')).toBe(false);
  });

  it('rejects the T7 pre-migration sentinel so it is not rotated', () => {
    expect(
      isManagedBackup('sessions.json', 'sessions.json.premigrate.bak'),
    ).toBe(false);
  });

  it('rejects tmp files and unrelated user files', () => {
    expect(isManagedBackup('sessions.json', 'sessions.json.tmp.123.1')).toBe(false);
    expect(isManagedBackup('sessions.json', 'other.json.bak')).toBe(false);
    expect(isManagedBackup('sessions.json', 'sessions.json')).toBe(false);
  });

  it('rejects anything containing a directory segment', () => {
    // The T6 quarantine lives under `corrupted/` — those files
    // must NEVER be eligible for rotation.
    expect(
      isManagedBackup('sessions.json', 'corrupted/sessions.json.2026-04-17.bak'),
    ).toBe(false);
    expect(
      isManagedBackup('sessions.json', path.join('corrupted', 'sessions.json.bak')),
    ).toBe(false);
    expect(isManagedBackup('sessions.json', '../sessions.json.bak')).toBe(false);
  });

  it('rejects when basename itself carries a directory component', () => {
    expect(
      isManagedBackup('/abs/path/sessions.json', 'sessions.json.bak'),
    ).toBe(false);
  });
});

// ── rotateBackups (async) ───────────────────────────────────────────

describe('rotateBackups', () => {
  it('shifts .bak → .bak.1 → .bak.2 → .bak.3 across successive calls', async () => {
    // Seed the .bak slot four times, rotating between each. The
    // write path in core.ts calls `rotateBackups` BEFORE renaming
    // primary → .bak; this test exercises the rotation module in
    // isolation so we seed .bak directly.
    writeRaw('.bak', 'gen-1');
    await rotateBackups(targetPath);
    expect(readRaw('.bak.1')).toBe('gen-1');

    writeRaw('.bak', 'gen-2');
    await rotateBackups(targetPath);
    expect(readRaw('.bak.1')).toBe('gen-2');
    expect(readRaw('.bak.2')).toBe('gen-1');

    writeRaw('.bak', 'gen-3');
    await rotateBackups(targetPath);
    expect(readRaw('.bak.1')).toBe('gen-3');
    expect(readRaw('.bak.2')).toBe('gen-2');
    expect(readRaw('.bak.3')).toBe('gen-1');

    // Fourth rotation: gen-1 in .bak.3 is dropped, chain holds
    // the four most-recent generations.
    writeRaw('.bak', 'gen-4');
    await rotateBackups(targetPath);
    expect(readRaw('.bak.1')).toBe('gen-4');
    expect(readRaw('.bak.2')).toBe('gen-3');
    expect(readRaw('.bak.3')).toBe('gen-2');
  });

  it('end-to-end: four atomic writes with rotationEnabled populate the chain', async () => {
    await atomicWriteJSON(targetPath, { gen: 1 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 4 }, { rotationEnabled: true });

    expect(JSON.parse(readRaw('') ?? '')).toEqual({ gen: 4 });
    expect(JSON.parse(readRaw('.bak') ?? '')).toEqual({ gen: 3 });
    expect(JSON.parse(readRaw('.bak.1') ?? '')).toEqual({ gen: 2 });
    expect(JSON.parse(readRaw('.bak.2') ?? '')).toEqual({ gen: 1 });
    // .bak.3 has not been reached yet — only four writes performed.
    expect(readRaw('.bak.3')).toBeNull();
  });

  it('fills .bak.3 on the fifth write', async () => {
    for (let i = 1; i <= 5; i++) {
      await atomicWriteJSON(targetPath, { gen: i }, { rotationEnabled: true });
    }

    expect(JSON.parse(readRaw('') ?? '')).toEqual({ gen: 5 });
    expect(JSON.parse(readRaw('.bak') ?? '')).toEqual({ gen: 4 });
    expect(JSON.parse(readRaw('.bak.1') ?? '')).toEqual({ gen: 3 });
    expect(JSON.parse(readRaw('.bak.2') ?? '')).toEqual({ gen: 2 });
    expect(JSON.parse(readRaw('.bak.3') ?? '')).toEqual({ gen: 1 });
  });

  it('skips missing intermediate slots (ENOENT swallowed)', async () => {
    // Only .bak exists; .bak.1 and .bak.2 are absent. Rotation
    // should still promote .bak to .bak.1 without crashing.
    writeRaw('.bak', 'only-bak');
    await rotateBackups(targetPath);
    expect(readRaw('.bak')).toBeNull();
    expect(readRaw('.bak.1')).toBe('only-bak');
    expect(readRaw('.bak.2')).toBeNull();
    expect(readRaw('.bak.3')).toBeNull();
  });

  it('swallows rename failures and continues the chain', async () => {
    // Plant a non-empty directory at .bak.3 so the very first step
    // of rotation (`.bak.2 → .bak.3`) cannot complete: the helper
    // tries `unlink(.bak.3)` (fails with EISDIR/EPERM, swallowed),
    // then `rename(.bak.2, .bak.3)` (fails with ENOTEMPTY). The
    // failure must be logged and the chain must continue so the
    // remaining slots still get promoted.
    writeRaw('.bak', 'live-bak');
    writeRaw('.bak.1', 'live-bak-1');
    writeRaw('.bak.2', 'live-bak-2');

    const blockDir = `${targetPath}.bak.3`;
    fs.mkdirSync(blockDir);
    fs.writeFileSync(path.join(blockDir, 'sentinel'), 'keep', 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let threw = false;
    try {
      await rotateBackups(targetPath);
    } catch {
      threw = true;
    } finally {
      warn.mockRestore();
    }

    // Rotation must not propagate the error — it is best-effort.
    expect(threw).toBe(false);

    // The directory at .bak.3 survived: we never clobber user data
    // nor remove directories to force a rename through.
    expect(fs.existsSync(blockDir)).toBe(true);
    expect(fs.statSync(blockDir).isDirectory()).toBe(true);
    expect(
      fs.readFileSync(path.join(blockDir, 'sentinel'), 'utf-8'),
    ).toBe('keep');

    // Despite the blockage at the top of the chain, the remaining
    // slots did shift: .bak.1 → .bak.2 and .bak → .bak.1 ran.
    expect(readRaw('.bak')).toBeNull();
    expect(readRaw('.bak.1')).toBe('live-bak');
    expect(readRaw('.bak.2')).toBe('live-bak-1');
  });

  it('does not touch files under a corrupted/ sibling directory', async () => {
    // Simulate T6's quarantine subdir living alongside the target.
    const corruptedDir = path.join(tmpDir, 'corrupted');
    fs.mkdirSync(corruptedDir);
    const quarantined = path.join(
      corruptedDir,
      'data.json.2026-04-17.bak',
    );
    fs.writeFileSync(quarantined, 'quarantined-payload', 'utf-8');

    writeRaw('.bak', 'live-bak');
    await rotateBackups(targetPath);

    // Rotation only touches `${targetPath}.bak*` siblings at the
    // same directory depth. The corrupted/ copy must be untouched.
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.readFileSync(quarantined, 'utf-8')).toBe('quarantined-payload');
    // And the managed rotation happened normally.
    expect(readRaw('.bak.1')).toBe('live-bak');
  });
});

// ── rotateBackupsSync ───────────────────────────────────────────────

describe('rotateBackupsSync', () => {
  it('mirrors the async chain behaviour', () => {
    writeRaw('.bak', 's1');
    rotateBackupsSync(targetPath);
    expect(readRaw('.bak.1')).toBe('s1');

    writeRaw('.bak', 's2');
    rotateBackupsSync(targetPath);
    expect(readRaw('.bak.1')).toBe('s2');
    expect(readRaw('.bak.2')).toBe('s1');

    writeRaw('.bak', 's3');
    rotateBackupsSync(targetPath);
    expect(readRaw('.bak.1')).toBe('s3');
    expect(readRaw('.bak.2')).toBe('s2');
    expect(readRaw('.bak.3')).toBe('s1');
  });
});

// ── readWithBackupFallback ──────────────────────────────────────────

describe('readWithBackupFallback', () => {
  it('returns the primary when it parses cleanly', async () => {
    writeRaw('', JSON.stringify({ src: 'primary' }));

    const result = await readWithBackupFallback(
      targetPath,
      async (p) => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as { src: string };
        } catch {
          return null;
        }
      },
    );

    expect(result).not.toBeNull();
    expect(result?.path).toBe(targetPath);
    expect(result?.data).toEqual({ src: 'primary' });
  });

  it('falls back to .bak.1 when both primary and .bak are corrupt', async () => {
    writeRaw('', 'not-json-primary');
    writeRaw('.bak', 'not-json-bak');
    writeRaw('.bak.1', JSON.stringify({ src: 'bak-1' }));
    writeRaw('.bak.2', JSON.stringify({ src: 'bak-2' }));

    const result = await readWithBackupFallback(
      targetPath,
      async (p) => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as { src: string };
        } catch {
          return null;
        }
      },
    );

    expect(result).not.toBeNull();
    expect(result?.path).toBe(`${targetPath}.bak.1`);
    expect(result?.data).toEqual({ src: 'bak-1' });
  });

  it('returns null when every slot is missing or unreadable', async () => {
    const result = await readWithBackupFallback(
      targetPath,
      async () => null,
    );
    expect(result).toBeNull();
  });

  it('visits slots in primary → .bak → .bak.1 → .bak.2 → .bak.3 order', async () => {
    writeRaw('', 'corrupt');
    writeRaw('.bak', 'corrupt');
    writeRaw('.bak.1', 'corrupt');
    writeRaw('.bak.2', 'corrupt');
    writeRaw('.bak.3', JSON.stringify({ deep: true }));

    const visited: string[] = [];
    const result = await readWithBackupFallback(targetPath, async (p) => {
      visited.push(path.basename(p));
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as { deep: boolean };
      } catch {
        return null;
      }
    });

    expect(visited).toEqual([
      'data.json',
      'data.json.bak',
      'data.json.bak.1',
      'data.json.bak.2',
      'data.json.bak.3',
    ]);
    expect(result?.path).toBe(`${targetPath}.bak.3`);
    expect(result?.data).toEqual({ deep: true });
  });
});

// ── readWithBackupFallbackSync ──────────────────────────────────────

describe('readWithBackupFallbackSync', () => {
  it('mirrors async ordering and recovery behaviour', () => {
    writeRaw('', 'garbage');
    writeRaw('.bak.2', JSON.stringify({ src: 'bak-2' }));

    const result = readWithBackupFallbackSync<{ src: string }>(
      targetPath,
      (p) => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as { src: string };
        } catch {
          return null;
        }
      },
    );

    expect(result?.path).toBe(`${targetPath}.bak.2`);
    expect(result?.data).toEqual({ src: 'bak-2' });
  });
});

// #3247: only a slot that is provably absent may read as "nothing on disk".
describe('stateSlotsOnDisk', () => {
  it('is false when no slot exists, and when a path component is a file (ENOTDIR)', () => {
    expect(stateSlotsOnDisk(targetPath)).toBe(false);
    fs.writeFileSync(path.join(tmpDir, 'plain'), 'x');
    expect(stateSlotsOnDisk(path.join(tmpDir, 'plain', 'data.json'))).toBe(false);
  });

  it('is true for a backup slot alone', () => {
    fs.writeFileSync(`${targetPath}.bak.2`, '{}');
    expect(stateSlotsOnDisk(targetPath)).toBe(true);
  });

  it('is true when quarantine kept a copy of the primary', () => {
    fs.mkdirSync(path.join(tmpDir, 'corrupted'));
    fs.writeFileSync(path.join(tmpDir, 'corrupted', 'data.json.1795682900082.bak'), '{');
    expect(stateSlotsOnDisk(targetPath)).toBe(true);
  });

  it('is true when the slot cannot be stat-ed for a reason other than absence', () => {
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    try {
      expect(stateSlotsOnDisk(targetPath)).toBe(true);
    } finally {
      lstat.mockRestore();
    }
  });
});
