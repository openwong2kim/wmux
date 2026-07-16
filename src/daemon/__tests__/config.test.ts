import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDefaultConfig, loadConfig, saveConfig, getWmuxDir } from '../config';
import type { DaemonConfig } from '../types';

/** Use a temp directory instead of the real ~/.wmux */
let originalHomedir: typeof os.homedir;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-config-test-'));
  originalHomedir = os.homedir;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (os as any).homedir = () => tmpDir;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (os as any).homedir = originalHomedir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createDefaultConfig', () => {
  it('returns a valid DaemonConfig with expected defaults', () => {
    const config = createDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.daemon.logLevel).toBe('info');
    expect(config.daemon.autoStart).toBe(true);
    expect(typeof config.daemon.pipeName).toBe('string');
    expect(config.session.defaultCols).toBe(120);
    expect(config.session.defaultRows).toBe(30);
    expect(config.session.bufferSizeMb).toBe(8);
    expect(config.session.bufferMaxMb).toBe(64);
    expect(config.session.deadSessionTtlHours).toBe(24);
    expect(config.session.deadSessionDumpBuffer).toBe(true);
    expect(typeof config.session.defaultShell).toBe('string');
  });
});

describe('loadConfig', () => {
  it('creates ~/.wmux directory and default config when nothing exists', () => {
    const wmuxDir = getWmuxDir();
    expect(fs.existsSync(wmuxDir)).toBe(false);

    const config = loadConfig();
    expect(fs.existsSync(wmuxDir)).toBe(true);
    expect(fs.existsSync(path.join(wmuxDir, 'config.json'))).toBe(true);
    expect(config.version).toBe(1);
  });

  it('loads an existing valid config from disk', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });

    const custom: DaemonConfig = {
      ...createDefaultConfig(),
      daemon: {
        ...createDefaultConfig().daemon,
        logLevel: 'debug',
      },
    };
    fs.writeFileSync(
      path.join(wmuxDir, 'config.json'),
      JSON.stringify(custom, null, 2),
      'utf-8',
    );

    const loaded = loadConfig();
    expect(loaded.daemon.logLevel).toBe('debug');
  });

  it('resets to defaults when config.json contains invalid JSON', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(path.join(wmuxDir, 'config.json'), '{{not json}}', 'utf-8');

    const config = loadConfig();
    expect(config.version).toBe(1);
    expect(config.daemon.logLevel).toBe('info');
  });

  it('resets to defaults when config.json has wrong structure', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(
      path.join(wmuxDir, 'config.json'),
      JSON.stringify({ version: 1, daemon: 'wrong' }),
      'utf-8',
    );

    const config = loadConfig();
    expect(config.version).toBe(1);
    expect(config.daemon.logLevel).toBe('info');
  });
});

describe('saveConfig', () => {
  it('writes config atomically (no .tmp residue)', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });

    const config = createDefaultConfig();
    saveConfig(config);

    const configPath = path.join(wmuxDir, 'config.json');
    const tmpPath = configPath + '.tmp';
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const loaded = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(loaded.version).toBe(1);
  });
});

// ── Substrate 3.0 lifecycle knobs ──────────────────────────────────────
// maxSessions / suspendedTtlHours / memWarnMb / memReapMb / memBlockMb:
// per-field backfill + clamp, never a whole-file reset on a single bad
// field. See the clamp contract in config.ts (loadConfig).

/** Write a raw (possibly partial / malformed) config object to disk. */
function writeRawConfig(obj: unknown): void {
  const wmuxDir = getWmuxDir();
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify(obj), 'utf-8');
}

describe('createDefaultConfig — lifecycle knobs', () => {
  it('includes the substrate 3.0 lifecycle defaults', () => {
    const c = createDefaultConfig();
    expect(c.session.maxSessions).toBe(200);
    expect(c.session.suspendedTtlHours).toBe(7 * 24);
    expect(c.daemon.memWarnMb).toBe(500);
    expect(c.daemon.memReapMb).toBe(750);
    expect(c.daemon.memBlockMb).toBe(1024);
  });
});

describe('loadConfig — lifecycle backfill + clamp', () => {
  it('REGRESSION #1: old config.json (no lifecycle fields) → defaults backfilled, existing fields + idleShutdownMinutes preserved', () => {
    // A v1 config from before substrate 3.0: structurally valid, no new
    // knobs, plus a customised idleShutdownMinutes/logLevel/TTL the user
    // must keep. This is the highest-priority regression.
    writeRawConfig({
      version: 1,
      daemon: { pipeName: '\\\\.\\pipe\\custom', logLevel: 'debug', autoStart: false, idleShutdownMinutes: 12 },
      session: {
        defaultShell: '/bin/zsh', defaultCols: 100, defaultRows: 40,
        bufferSizeMb: 8, bufferMaxMb: 64, deadSessionTtlHours: 48, deadSessionDumpBuffer: false,
      },
    });
    const c = loadConfig();
    // Existing fields preserved verbatim
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\custom');
    expect(c.daemon.logLevel).toBe('debug');
    expect(c.daemon.autoStart).toBe(false);
    expect(c.daemon.idleShutdownMinutes).toBe(12);
    expect(c.session.defaultShell).toBe('/bin/zsh');
    expect(c.session.deadSessionTtlHours).toBe(48);
    expect(c.session.deadSessionDumpBuffer).toBe(false);
    // New fields backfilled to defaults
    expect(c.session.maxSessions).toBe(200);
    expect(c.session.suspendedTtlHours).toBe(7 * 24);
    expect(c.daemon.memWarnMb).toBe(500);
    expect(c.daemon.memReapMb).toBe(750);
    expect(c.daemon.memBlockMb).toBe(1024);
  });

  it('preserves valid lifecycle values (passthrough)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      session: { ...c0.session, maxSessions: 50, suspendedTtlHours: 48 },
      daemon: { ...c0.daemon, memWarnMb: 300, memReapMb: 400, memBlockMb: 600 },
    });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(50);
    expect(c.session.suspendedTtlHours).toBe(48);
    expect(c.daemon.memWarnMb).toBe(300);
    expect(c.daemon.memReapMb).toBe(400);
    expect(c.daemon.memBlockMb).toBe(600);
  });

  it('garbage in one lifecycle field backfills ONLY that field — no whole-file reset', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      daemon: { ...c0.daemon, pipeName: '\\\\.\\pipe\\keepme' },
      session: { ...c0.session, maxSessions: 'abc' as unknown as number, suspendedTtlHours: 99 },
    });
    const c = loadConfig();
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\keepme'); // NOT reset to default
    expect(c.session.maxSessions).toBe(200);               // garbage → backfilled
    expect(c.session.suspendedTtlHours).toBe(99);          // sibling preserved
  });

  it('clamps ≤0 / negative to the floor (no "off" for floors)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, session: { ...c0.session, maxSessions: 0, suspendedTtlHours: -5 } });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(1);        // MAX_SESSIONS_FLOOR
    expect(c.session.suspendedTtlHours).toBe(1);  // SUSPENDED_TTL_FLOOR_HOURS
  });

  it('clamps over-cap values to the cap', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, session: { ...c0.session, maxSessions: 999999, suspendedTtlHours: 99999999 } });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(10_000);          // MAX_SESSIONS_CAP
    expect(c.session.suspendedTtlHours).toBe(24 * 365);  // SUSPENDED_TTL_CAP_HOURS
  });

  it('caps memory thresholds at physical RAM (absolute upper cap)', () => {
    const c0 = createDefaultConfig();
    const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
    writeRawConfig({
      ...c0,
      daemon: { ...c0.daemon, memWarnMb: 9_999_999, memReapMb: 9_999_999, memBlockMb: 9_999_999 },
    });
    const c = loadConfig();
    expect(c.daemon.memBlockMb).toBe(totalMemMb);
    expect(c.daemon.memBlockMb).toBeLessThanOrEqual(totalMemMb);
  });

  it('REGRESSION #5: memBlockMb below the safe floor → clamped + startup warning (no silent brick)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, memWarnMb: 10, memReapMb: 20, memBlockMb: 30 } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = loadConfig();
    expect(c.daemon.memBlockMb).toBeGreaterThanOrEqual(256); // MEM_BLOCK_FLOOR_MB
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('below the safe floor'));
    warnSpy.mockRestore();
  });

  it('corrects memory order inversion (warn > reap > block) after clamp', () => {
    const c0 = createDefaultConfig();
    // All above their floors so the floor clamp doesn't mask the inversion;
    // the order-correction step must raise reap/block up to warn.
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, memWarnMb: 900, memReapMb: 500, memBlockMb: 300 } });
    const c = loadConfig();
    expect(c.daemon.memWarnMb).toBeLessThanOrEqual(c.daemon.memReapMb);
    expect(c.daemon.memReapMb).toBeLessThanOrEqual(c.daemon.memBlockMb);
    expect(c.daemon.memWarnMb).toBe(900);  // warn stays put
    expect(c.daemon.memReapMb).toBe(900);  // raised to warn
    expect(c.daemon.memBlockMb).toBe(900); // raised to reap
  });
});

describe('createDefaultConfig — lanlink (PR-3)', () => {
  it('includes the OFF-by-default lanlink slice', () => {
    const c = createDefaultConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
    expect(c.lanlink?.port).toBeUndefined();
  });
});

describe('loadConfig — lanlink backfill (PR-3, non-destructive)', () => {
  // The load-bearing backward-compat guarantee: an OLD config.json (predating the
  // lanlink field) must keep loading, get backfilled to OFF, and NOT lose any
  // sibling field — and a malformed lanlink must never trigger the whole-file
  // reset (that path is reserved for core-structure breakage).

  it('REGRESSION: old config.json with no lanlink → backfilled to OFF, all siblings preserved', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-OLD-CONFIG-SENTINEL';
    const old: Record<string, unknown> = {
      ...c0,
      daemon: { ...c0.daemon, pipeName: sentinelPipe },
      session: { ...c0.session, maxSessions: 137 },
    };
    delete old.lanlink; // an old file simply has no lanlink key
    writeRawConfig(old);

    const c = loadConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null }); // backfilled OFF
    expect(c.daemon.pipeName).toBe(sentinelPipe); // sibling preserved
    expect(c.session.maxSessions).toBe(137); // sibling preserved
  });

  it('garbage lanlink (string) → default OFF, pipeName NOT nuked', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-GARBAGE-SENTINEL';
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, pipeName: sentinelPipe }, lanlink: 'totally-not-an-object' });

    const c = loadConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
    expect(c.daemon.pipeName).toBe(sentinelPipe);
  });

  it('array-shaped lanlink is rejected (not treated as an object) → default OFF', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, lanlink: [] });
    expect(loadConfig().lanlink).toEqual({ enabled: false, nic: null });
  });

  it('per-field coercion: a bad sub-field backfills ONLY itself', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, lanlink: { enabled: 'yes', nic: 12345, port: -1 } });
    const c = loadConfig();
    // enabled non-boolean → default false; nic non-object → null; port out of range → dropped
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
  });

  it('preserves a fully valid lanlink slice verbatim', () => {
    const c0 = createDefaultConfig();
    const lanlink = { enabled: true, nic: { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' }, port: 41234 };
    writeRawConfig({ ...c0, lanlink });
    expect(loadConfig().lanlink).toEqual(lanlink);
  });
});

// ── app-weight P1-6: idle-CPU knobs (livenessIntervalSec / snapshotIntervalSec) ──
describe('loadConfig — P1 idle-CPU knobs backfill + clamp', () => {
  it('defaults: liveness 15 s, snapshot 30 s', () => {
    const c = createDefaultConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.snapshotIntervalSec).toBe(30);
  });

  it('old config.json without the knobs → backfilled, siblings preserved', () => {
    const c0 = createDefaultConfig();
    const daemonNoKnobs = { ...c0.daemon, idleShutdownMinutes: 12 } as Record<string, unknown>;
    delete daemonNoKnobs.livenessIntervalSec;
    delete daemonNoKnobs.snapshotIntervalSec;
    writeRawConfig({ ...c0, daemon: daemonNoKnobs });
    const c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.snapshotIntervalSec).toBe(30);
    expect(c.daemon.idleShutdownMinutes).toBe(12);
  });

  it('valid values pass through; out-of-range clamp to [5,120] / [10,600]', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 30, snapshotIntervalSec: 60 } });
    let c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(30);
    expect(c.daemon.snapshotIntervalSec).toBe(60);

    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 0, snapshotIntervalSec: 100000 } });
    c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(5);   // floor — no "off"
    expect(c.daemon.snapshotIntervalSec).toBe(600); // cap — recovery staleness bound
  });

  it('garbage in a knob backfills only that field', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 'fast' as unknown as number, pipeName: '\\\\.\\pipe\\keepme2' } });
    const c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\keepme2');
  });
});
