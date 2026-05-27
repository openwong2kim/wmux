import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ShadowRejectionLogger,
  type ShadowAuditEntry,
  type ShadowRejectionEntry,
} from '../shadowRejectionLog';

function rejectionEntries(entries: ShadowAuditEntry[]): ShadowRejectionEntry[] {
  return entries.filter((e): e is ShadowRejectionEntry => e.entryKind === 'rejection');
}

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shadow-test-'));
  logPath = path.join(tmpDir, 'shadow-rejections.log');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tmpdir cleanup is best-effort across platforms */
  }
});

describe('ShadowRejectionLogger.append', () => {
  it('writes a JSONL line per append', () => {
    let ts = 1_700_000_000_000;
    const log = new ShadowRejectionLogger({
      path: logPath,
      now: () => ++ts,
    });
    log.append({
      clientName: 'p1',
      method: 'pane.list',
      rejection: {
        reason: 'capability-not-declared',
        method: 'pane.list',
        capability: 'pane.read',
      },
    });
    log.append({
      clientName: 'p2',
      method: 'events.poll',
      rejection: {
        reason: 'paths-partially-allowed',
        method: 'events.poll',
        capability: 'events.subscribe',
        allowed: ['pane.created'],
        rejected: [{ path: 'agent.lifecycle', declared: ['pane.*'] }],
      },
    });
    const entries = rejectionEntries(log.readAll());
    expect(entries).toHaveLength(2);
    expect(entries[0].clientName).toBe('p1');
    expect(entries[0].method).toBe('pane.list');
    expect(entries[0].rejection.reason).toBe('capability-not-declared');
    expect(entries[1].clientName).toBe('p2');
    expect(entries[1].rejection.reason).toBe('paths-partially-allowed');
  });

  it('preserves undefined clientName (envelope-less callers)', () => {
    const log = new ShadowRejectionLogger({ path: logPath });
    log.append({
      clientName: undefined,
      method: 'pane.list',
      rejection: {
        reason: 'capability-not-declared',
        method: 'pane.list',
        capability: 'pane.read',
      },
    });
    const entries = rejectionEntries(log.readAll());
    expect(entries).toHaveLength(1);
    // JSON.stringify drops undefined keys, so the field round-trips as missing
    // — equivalent to undefined for our purposes.
    expect(entries[0].clientName).toBeUndefined();
  });

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'shadow.log');
    const log = new ShadowRejectionLogger({ path: nested });
    log.append({
      clientName: 'p1',
      method: 'pane.list',
      rejection: {
        reason: 'capability-not-declared',
        method: 'pane.list',
        capability: 'pane.read',
      },
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('rotates when the file exceeds maxBytes', () => {
    // Tiny cap so a single rejection record (≈150 B) blows it on the first
    // post-write check. rotateIfNeeded examines size BEFORE appending, so
    // the first call writes without rotating; the second call sees a
    // post-first-append size that exceeds the cap and rotates.
    const log = new ShadowRejectionLogger({
      path: logPath,
      maxBytes: 50,
    });
    log.append({
      clientName: 'p1',
      method: 'pane.list',
      rejection: {
        reason: 'capability-not-declared',
        method: 'pane.list',
        capability: 'pane.read',
      },
    });
    // First append doesn't rotate (file is brand new, no prior size).
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(logPath + '.1')).toBe(false);

    // Second append finds the file > maxBytes and triggers rotation.
    log.append({
      clientName: 'p2',
      method: 'events.poll',
      rejection: {
        reason: 'paths-partially-allowed',
        method: 'events.poll',
        capability: 'events.subscribe',
        allowed: ['pane.created'],
        rejected: [{ path: 'agent.lifecycle', declared: ['pane.*'] }],
      },
    });
    expect(fs.existsSync(logPath + '.1')).toBe(true);
    // New file contains only the post-rotation entry.
    const entries = rejectionEntries(log.readAll());
    expect(entries).toHaveLength(1);
    expect(entries[0].clientName).toBe('p2');
  });

  it('writes legacy-traffic entries with entryKind discrimination', () => {
    const log = new ShadowRejectionLogger({ path: logPath });
    log.append({
      clientName: 'p1',
      method: 'pane.list',
      rejection: {
        reason: 'capability-not-declared',
        method: 'pane.list',
        capability: 'pane.read',
      },
    });
    log.appendLegacyTraffic({ method: 'pane.list', count: 10 });
    log.appendLegacyTraffic({ method: 'events.poll', count: 100 });

    const all = log.readAll();
    expect(all).toHaveLength(3);
    expect(all[0].entryKind).toBe('rejection');
    expect(all[1].entryKind).toBe('legacy-traffic');
    expect(all[2].entryKind).toBe('legacy-traffic');
    if (all[1].entryKind === 'legacy-traffic') {
      expect(all[1].method).toBe('pane.list');
      expect(all[1].count).toBe(10);
    }
    if (all[2].entryKind === 'legacy-traffic') {
      expect(all[2].method).toBe('events.poll');
      expect(all[2].count).toBe(100);
    }
  });

  it('swallows fs errors so shadow logging never breaks RPC dispatch', () => {
    // Point the logger at a path that can't possibly be created (a file
    // appearing where a directory would need to go).
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, '');
    const log = new ShadowRejectionLogger({
      path: path.join(blocker, 'subfile', 'log.log'),
    });
    // Should not throw despite ensureDir failing.
    expect(() =>
      log.append({
        clientName: 'p1',
        method: 'pane.list',
        rejection: {
          reason: 'capability-not-declared',
          method: 'pane.list',
          capability: 'pane.read',
        },
      }),
    ).not.toThrow();
  });
});
