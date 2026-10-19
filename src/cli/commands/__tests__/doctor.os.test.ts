import { describe, it, expect, vi } from 'vitest';
import {
  buildDoctorReport,
  worst,
  countErrorWarn,
  renderReport,
  EVENT_LOOP_LAG_WARN_MS,
  AV_TAX_PHASE_WARN_MS,
  type DoctorDeps,
  type DaemonPingResult,
} from '../doctor';
import type { RpcResponse } from '../../../shared/rpc';

// ---- fixtures ----------------------------------------------------------------

// A realistic main `[boot-trace] summary` line. preJsMs is small (healthy);
// the heavy-AV variant below pushes daemon-boot past the threshold.
function mainSummaryLine(overrides: Record<string, number> = {}, preJsMs = 300): string {
  const marks: Record<string, number> = {
    'js-start': 0,
    'imports-done': 80,
    'module-eval-end': 160,
    'construction-start': 120,
    'pre-pipe-server-ctor': 140,
    'pipe-server-ctor-done': 150,
    'ready-fired': 400,
    'plugins-loaded': 460,
    'window-created': 480,
    'daemon-bootstrap-start': 490,
    'daemon-ensure-start': 491,
    'daemon-spawned': 520,
    'daemon-pipe-file-seen': 700,
    'daemon-first-ping-ok': 760,
    'daemon-bootstrap-end': 800,
    'renderer-load-triggered': 810,
    'ready-end': 1200,
    ...overrides,
  };
  return (
    '[2026-06-13T09:00:00.000Z] [info] [main] [boot-trace] summary=' +
    JSON.stringify({ procCreateEpochMs: 1000, jsStartEpochMs: 1300, preJsMs, marks })
  );
}

function okPing(result: DaemonPingResult): RpcResponse {
  return { id: 'x', ok: true, result };
}

// A reachable main process pipe (system.identify success envelope).
function okIdentify(): RpcResponse {
  return {
    id: 'x',
    ok: true,
    result: { app: 'wmux', version: '3.2.0', platform: 'win32', electronVersion: '30' },
  };
}

function healthyPing(): DaemonPingResult {
  const jsStart = 50_000;
  return {
    status: 'ok',
    pid: 4242,
    uptime: 3725, // 1h 2m 5s
    sessions: 3,
    eventLoopLagMs: 12,
    bootTrace: {
      jsStartEpochMs: jsStart,
      marks: {
        'main-start': jsStart + 0,
        'lock-acquired': jsStart + 30,
        'bootid-done': jsStart + 35,
        'config-loaded': jsStart + 60,
        'recovery-done': jsStart + 120,
        'pre-pipe-start': jsStart + 130,
        'pipe-listening': jsStart + 170,
        ready: jsStart + 200,
      },
    },
  };
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const files: Record<string, string> = {
    '/logs/main-2026-06-13.log': mainSummaryLine(),
    '/auth-token': 'TOKEN123',
    '/logs/daemon-2026-06-13.log': '[info] daemon up\n',
  };
  const deps: DoctorDeps = {
    ping: vi.fn().mockResolvedValue(okPing(healthyPing())),
    appPipeReachable: vi.fn().mockResolvedValue(okIdentify()),
    version: '3.2.0',
    platform: 'win32',
    pipeName: '\\\\.\\pipe\\wmux-user',
    authTokenPath: '/auth-token',
    mainLogPath: '/logs/main-2026-06-13.log',
    daemonLogPath: '/logs/daemon-2026-06-13.log',
    readTextFile: vi.fn((p: string) => files[p] ?? null),
    // Default tail reader delegates to the (possibly overridden) readTextFile so
    // log/boot reads honor a test's readTextFile override; the production code
    // reads only the trailing bytes from disk, but for in-memory fixtures the
    // full text is well under the window. Callers may override either.
    tailReadTextFile: vi.fn(),
    env: {},
    ...overrides,
  };
  // Wire the default tail reader AFTER overrides so it captures the final
  // readTextFile (overridden or not). If the caller supplied its own
  // tailReadTextFile, leave it in place.
  if (!overrides.tailReadTextFile) {
    deps.tailReadTextFile = vi.fn((p: string) => deps.readTextFile(p));
  }
  return deps;
}

// ---- worst() algebra ---------------------------------------------------------

describe('worst', () => {
  it('returns OK for an empty list', () => {
    expect(worst([])).toBe('OK');
  });
  it('FAIL dominates everything', () => {
    expect(worst(['OK', 'WARN', 'SKIP', 'FAIL'])).toBe('FAIL');
  });
  it('WARN beats SKIP and OK', () => {
    expect(worst(['OK', 'SKIP', 'WARN'])).toBe('WARN');
  });
  it('SKIP beats OK but is not a failure', () => {
    expect(worst(['OK', 'SKIP', 'OK'])).toBe('SKIP');
  });
  it('all OK stays OK', () => {
    expect(worst(['OK', 'OK'])).toBe('OK');
  });
});

// ---- countErrorWarn ----------------------------------------------------------

describe('countErrorWarn', () => {
  it('counts main logSink format `[<iso>] [<level>] [<source>] msg`', () => {
    const text = [
      '[2026-06-13T00:00:00.000Z] [info] [main] hi',
      '[2026-06-13T00:00:01.000Z] [warn] [main] careful',
      '[2026-06-13T00:00:02.000Z] [error] [main] boom',
      '[2026-06-13T00:00:03.000Z] [error] [main] boom again',
    ].join('\n');
    expect(countErrorWarn(text)).toEqual({ errors: 2, warns: 1 });
  });

  it('counts daemon format `[<iso>] [daemon/<level>] msg` (P2 regression guard)', () => {
    // Ground truth: src/daemon/index.ts log() → `[${ts}] [daemon/${level}] ${msg}`.
    // The level word carries a `daemon/` source prefix inside the bracket, which
    // the original `/\[error\]/` pattern missed (always counted 0).
    const text = [
      '[2026-06-13T00:00:00.000Z] [daemon/info] daemon up',
      '[2026-06-13T00:00:01.000Z] [daemon/warn] retrying',
      '[2026-06-13T00:00:02.000Z] [daemon/error] spawn failed',
      '[2026-06-13T00:00:03.000Z] [daemon/error] lock contended',
    ].join('\n');
    expect(countErrorWarn(text)).toEqual({ errors: 2, warns: 1 });
  });

  it('counts a mix of main and daemon formats in one buffer', () => {
    const text = [
      '[2026-06-13T00:00:00.000Z] [error] [main] main boom',
      '[2026-06-13T00:00:01.000Z] [daemon/error] daemon boom',
      '[2026-06-13T00:00:02.000Z] [warn] [main] main warn',
      '[2026-06-13T00:00:03.000Z] [daemon/warn] daemon warn',
      '[2026-06-13T00:00:04.000Z] [info] [main] noise',
    ].join('\n');
    expect(countErrorWarn(text)).toEqual({ errors: 2, warns: 2 });
  });

  it('does not double-count an error line as a warn (both formats)', () => {
    expect(countErrorWarn('[error] only')).toEqual({ errors: 1, warns: 0 });
    expect(countErrorWarn('[daemon/error] only')).toEqual({ errors: 1, warns: 0 });
  });

  it('returns zeros for clean text', () => {
    expect(countErrorWarn('[info] all good')).toEqual({ errors: 0, warns: 0 });
    expect(countErrorWarn('[daemon/info] all good')).toEqual({ errors: 0, warns: 0 });
  });
});

// ---- environment section -----------------------------------------------------

describe('environment section', () => {
  it('reports OK with token present and no suffix', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.environment.verdict).toBe('OK');
    const labels = r.environment.lines.map((l) => l.label);
    expect(labels).toContain('app version');
    expect(labels).toContain('platform');
    expect(labels).toContain('control pipe');
    expect(labels).toContain('auth token file');
    expect(labels).toContain('app (main process) pipe reachable');
    expect(labels).toContain('WMUX_DATA_SUFFIX');
  });

  it('reports the app pipe as reachable (OK) when system.identify answers', async () => {
    const r = await buildDoctorReport(makeDeps());
    const line = r.environment.lines.find(
      (l) => l.label === 'app (main process) pipe reachable',
    );
    expect(line?.value).toBe('yes');
    expect(line?.verdict).toBe('OK');
  });

  it('WARNs (informational) when the app pipe is unreachable but does not FAIL', async () => {
    // main process down (pipe probe rejects), daemon still alive (default ping).
    const deps = makeDeps({
      appPipeReachable: vi.fn().mockRejectedValue(new Error('wmux is not running.')),
    });
    const r = await buildDoctorReport(deps);
    const line = r.environment.lines.find(
      (l) => l.label === 'app (main process) pipe reachable',
    );
    expect(line?.value).toBe('no');
    expect(line?.verdict).toBe('WARN');
    // A closed app is not a doctor FAIL when the daemon answers.
    expect(r.daemon.verdict).toBe('OK');
    expect(r.overall).not.toBe('FAIL');
  });

  it('treats an app-pipe error envelope (ok:false) as unreachable', async () => {
    const deps = makeDeps({
      appPipeReachable: vi
        .fn()
        .mockResolvedValue({ id: 'x', ok: false, error: 'boom' } as RpcResponse),
    });
    const r = await buildDoctorReport(deps);
    const line = r.environment.lines.find(
      (l) => l.label === 'app (main process) pipe reachable',
    );
    expect(line?.verdict).toBe('WARN');
  });

  it('WARNs when the auth token file is missing', async () => {
    const deps = makeDeps({ readTextFile: vi.fn(() => null) });
    const r = await buildDoctorReport(deps);
    const token = r.environment.lines.find((l) => l.label === 'auth token file');
    expect(token?.verdict).toBe('WARN');
    expect(r.environment.verdict).toBe('WARN');
  });

  it('surfaces WMUX_DATA_SUFFIX when set', async () => {
    const r = await buildDoctorReport(makeDeps({ env: { WMUX_DATA_SUFFIX: '-dev' } }));
    const line = r.environment.lines.find((l) => l.label === 'WMUX_DATA_SUFFIX');
    expect(line?.value).toContain('-dev');
  });
});

// ---- daemon section ----------------------------------------------------------

describe('daemon section', () => {
  it('reports OK when the daemon is up and responsive', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.daemon.verdict).toBe('OK');
    expect(r.daemon.recovery).toEqual([]);
    const up = r.daemon.lines.find((l) => l.label === 'daemon');
    expect(up?.value).toContain('pid 4242');
    expect(r.daemon.lines.find((l) => l.label === 'uptime')?.value).toBe('1h 2m 5s');
    expect(r.daemon.lines.find((l) => l.label === 'sessions')?.value).toBe('3');
  });

  it('WARNs when eventLoopLagMs exceeds the threshold (boundary)', async () => {
    const ping = healthyPing();
    ping.eventLoopLagMs = EVENT_LOOP_LAG_WARN_MS + 1;
    const r = await buildDoctorReport(makeDeps({ ping: vi.fn().mockResolvedValue(okPing(ping)) }));
    const lag = r.daemon.lines.find((l) => l.label === 'event-loop lag');
    expect(lag?.verdict).toBe('WARN');
    expect(r.daemon.verdict).toBe('WARN');
  });

  it('does NOT warn exactly at the threshold', async () => {
    const ping = healthyPing();
    ping.eventLoopLagMs = EVENT_LOOP_LAG_WARN_MS; // == 100, not > 100
    const r = await buildDoctorReport(makeDeps({ ping: vi.fn().mockResolvedValue(okPing(ping)) }));
    const lag = r.daemon.lines.find((l) => l.label === 'event-loop lag');
    expect(lag?.verdict).toBe('OK');
  });

  it('FAILs with recovery steps when the daemon ping rejects (down)', async () => {
    const deps = makeDeps({
      ping: vi.fn().mockRejectedValue(new Error('wmux is not running. Start the app first.')),
    });
    const r = await buildDoctorReport(deps);
    expect(r.daemon.verdict).toBe('FAIL');
    expect(r.daemon.recovery.length).toBeGreaterThan(0);
    expect(r.overall).toBe('FAIL');
    const line = r.daemon.lines.find((l) => l.label === 'daemon');
    expect(line?.value).toBe('down');
    expect(line?.hint).toContain('not running');
  });

  it('FAILs when ping returns an error envelope', async () => {
    const deps = makeDeps({
      ping: vi.fn().mockResolvedValue({ id: 'x', ok: false, error: 'boom' } as RpcResponse),
    });
    const r = await buildDoctorReport(deps);
    expect(r.daemon.verdict).toBe('FAIL');
    expect(r.daemon.lines[0].hint).toBe('boom');
  });

  it('still builds env + log sections when the daemon is down', async () => {
    const deps = makeDeps({ ping: vi.fn().mockRejectedValue(new Error('down')) });
    const r = await buildDoctorReport(deps);
    // env/log sections do not depend on the daemon.
    expect(r.environment.lines.length).toBeGreaterThan(0);
    expect(r.logs.lines.length).toBe(2);
  });
});

// ---- boot-phase section ------------------------------------------------------

describe('boot-phase section', () => {
  it('builds the main + daemon phase tables when both are present', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.bootPhases.verdict).toBe('OK');
    const mainRows = r.bootPhases.main;
    const daemonRows = r.bootPhases.daemon;
    const anchors = r.bootPhases.daemonAnchors;
    expect(mainRows).not.toBeNull();
    expect(daemonRows).not.toBeNull();
    expect(anchors).not.toBeNull();
    expect(r.bootPhases.preJsMs).toBe(300);
    if (!mainRows || !daemonRows || !anchors) throw new Error('phase tables missing');

    const imports = mainRows.find((p) => p.label === 'module imports');
    expect(imports?.ms).toBe(80); // imports-done(80) - js-start(0)
    const daemonBoot = mainRows.find((p) => p.label === 'daemon boot');
    expect(daemonBoot?.ms).toBe(180); // pipe-file-seen(700) - spawned(520)

    // Daemon rebased: lock-acquired(30) - main-start(0) = 30.
    const lockAcq = daemonRows.find((p) => p.label === 'lock acquire');
    expect(lockAcq?.ms).toBe(30);
    // Anchor row carries every ordered mark, rebased.
    const ready = anchors.find((a) => a.name === 'ready');
    expect(ready?.ms).toBe(200);
  });

  it('SKIPs the main table when the log has no summary line', async () => {
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) =>
        p.includes('main') ? '[info] no summary here\n' : '[info] daemon\n',
      ),
    });
    const r = await buildDoctorReport(deps);
    expect(r.bootPhases.main).toBeNull();
    expect(r.bootPhases.note).toBeDefined();
    // Daemon table still present from the live ping → section not pure SKIP.
    expect(r.bootPhases.daemon).not.toBeNull();
    expect(r.bootPhases.verdict).toBe('OK');
  });

  it('SKIPs the whole section when neither main summary nor daemon bootTrace exists', async () => {
    const deps = makeDeps({
      readTextFile: vi.fn(() => '[info] nothing useful\n'),
      ping: vi.fn().mockResolvedValue(okPing({ status: 'ok', pid: 1, uptime: 1, sessions: 0, eventLoopLagMs: 0 })),
    });
    const r = await buildDoctorReport(deps);
    expect(r.bootPhases.main).toBeNull();
    expect(r.bootPhases.daemon).toBeNull();
    expect(r.bootPhases.verdict).toBe('SKIP');
  });
});

// ---- AV-tax hint -------------------------------------------------------------

describe('AV-tax hint', () => {
  it('stays OK when boot phases are normal', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.avHint.verdict).toBe('OK');
  });

  it('WARNs when a daemon-boot phase exceeds the AV threshold', async () => {
    // Push daemon-spawned→pipe-file-seen well past AV_TAX_PHASE_WARN_MS.
    const line = mainSummaryLine({
      'daemon-spawned': 520,
      'daemon-pipe-file-seen': 520 + AV_TAX_PHASE_WARN_MS + 200,
      'daemon-bootstrap-end': 520 + AV_TAX_PHASE_WARN_MS + 400,
      'renderer-load-triggered': 520 + AV_TAX_PHASE_WARN_MS + 410,
      'ready-end': 520 + AV_TAX_PHASE_WARN_MS + 800,
    });
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => (p.includes('main') ? line : '[info] daemon\n')),
    });
    const r = await buildDoctorReport(deps);
    expect(r.avHint.verdict).toBe('WARN');
    expect(r.avHint.lines[0].hint).toContain('bench/README.md');
  });

  it('WARNs when pre-JS itself is abnormally large', async () => {
    const line = mainSummaryLine({}, AV_TAX_PHASE_WARN_MS + 500);
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => (p.includes('main') ? line : '[info] daemon\n')),
    });
    const r = await buildDoctorReport(deps);
    expect(r.avHint.verdict).toBe('WARN');
    expect(r.avHint.lines[0].value).toContain('pre-JS');
  });
});

// ---- logs section ------------------------------------------------------------

describe('logs section', () => {
  it('reports both log paths and OK counts when clean', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.logs.lines).toHaveLength(2);
    expect(r.logs.verdict).toBe('OK');
    expect(r.logs.lines[0].value).toContain('0 error');
  });

  it('SKIPs a log line when the file is absent', async () => {
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => (p.includes('daemon') ? null : mainSummaryLine())),
    });
    const r = await buildDoctorReport(deps);
    const daemonLog = r.logs.lines.find((l) => l.label === 'daemon log');
    expect(daemonLog?.verdict).toBe('SKIP');
    expect(daemonLog?.value).toContain('not found');
  });

  it('reads log + boot data via the bounded tail reader, not the full slurp', async () => {
    // P3-d: doctor must tail-read logs (runaway-log OOM guard). Both the boot
    // summary and the error/warn scan go through tailReadTextFile; readTextFile
    // is reserved for the auth-token check.
    const tail = vi.fn((p: string) => {
      if (p.includes('main')) return mainSummaryLine();
      return '[2026-06-13T00:00:00.000Z] [daemon/error] boom\n';
    });
    const read = vi.fn((p: string) => (p.includes('auth') ? 'TOKEN' : null));
    const r = await buildDoctorReport(makeDeps({ tailReadTextFile: tail, readTextFile: read }));
    // Both log paths were tail-read (main for boot summary + count, daemon for count).
    const paths = tail.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/logs/main-2026-06-13.log');
    expect(paths).toContain('/logs/daemon-2026-06-13.log');
    // Boot summary parsed from the tail read, and the daemon error surfaced.
    expect(r.bootPhases.main).not.toBeNull();
    expect(r.logs.lines.find((l) => l.label === 'daemon log')?.value).toContain('1 error');
    // The auth-token line still uses the full reader (it is not a log file).
    expect(read.mock.calls.some((c) => String(c[0]).includes('auth'))).toBe(true);
  });

  it('WARNs when today\'s daemon log has error lines (real daemon format)', async () => {
    // Ground truth: the daemon logger writes `[<iso>] [daemon/<level>] <msg>`
    // (src/daemon/index.ts log()), NOT `[error] [daemon] ...`. This fixture
    // pins the actual on-disk format so the [daemon/error] match cannot regress.
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => {
        if (p.includes('main')) return mainSummaryLine();
        return '[2026-06-13T00:00:00.000Z] [daemon/error] spawn failed\n';
      }),
    });
    const r = await buildDoctorReport(deps);
    const daemonLog = r.logs.lines.find((l) => l.label === 'daemon log');
    expect(daemonLog?.verdict).toBe('WARN');
    expect(daemonLog?.value).toContain('1 error');
  });
});

// ---- overall + rendering -----------------------------------------------------

describe('overall verdict + rendering', () => {
  it('overall is OK on a fully healthy install', async () => {
    const r = await buildDoctorReport(makeDeps());
    expect(r.overall).toBe('OK');
  });

  it('renders a non-empty human report without throwing', async () => {
    const r = await buildDoctorReport(makeDeps());
    const text = renderReport(r);
    expect(text).toContain('wmux doctor');
    expect(text).toContain('environment');
    expect(text).toContain('daemon');
    expect(text).toContain('boot phases');
    expect(text).toContain('logs');
  });

  it('renders recovery steps when the daemon is down', async () => {
    const deps = makeDeps({ ping: vi.fn().mockRejectedValue(new Error('down')) });
    const r = await buildDoctorReport(deps);
    const text = renderReport(r);
    expect(text).toContain('recovery:');
    expect(text).toContain('[FAIL]');
  });
});
