// ─── Log-mode matrix (PR3 task 2) ───────────────────────────────────
// Re-runs the existing channel suite (ChannelService/channelCursor/rosterIdentity —
// everything that constructs ChannelService) **once more in event-log mode**. Original
// test files stay unchanged — vi.mock wraps the ChannelService constructor to inject
// eventLog deps.
//
// Harness design (rationale for minimal-invasion compromise):
//  - Local fake writers (saveImmediate/load/failNext) in existing files validate the
//    legacy commit seam. In log mode the equivalent seam is the fsync barrier, so we
//    **probe** fake saveImmediate once per barrier to bridge:
//      · failNext consumed → barrier throw → append false → PERSIST_FAILED (same contract)
//      · one saveImmediate per commit → 1:1 call-count assertions preserved
//      · live state ref passed → saved[] content assertions observe state at read time
//        (after mutation await = after apply) — same observation as legacy
//  - One events directory per writer instance (WeakMap): restart tests that recreate
//    with the same writer replay the same log, equivalent to legacy load() hydration.
//    genesis = writer.load() at first construction (includes pre-seeded state).
//  - Empty-channel reaper TTL neutralized to huge value: fake writer load() does not
//    run the reaper (only real ChannelStateWriter.load() does), so log-mode boot reaper
//    would create harness artifacts. Reaper semantics are covered by ChannelStateWriter
//    dedicated tests.

import { vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDirs: string[] = [];

vi.mock('../ChannelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ChannelService')>();
  const { AppendOnlyLog } = await import('../../eventlog/AppendOnlyLog');
  const { SnapshotStore, SNAPSHOT_DIRNAME, GENESIS_CHANNEL_REF } = await import(
    '../../eventlog/SnapshotStore'
  );
  const { ChannelStateWriter } = await import('../ChannelStateWriter');

  // writer instance → events directory (restart tests see the same log).
  const dirByWriter = new WeakMap<object, string>();

  type Deps = ConstructorParameters<typeof actual.ChannelService>[0];

  class LogModeChannelService extends actual.ChannelService {
    constructor(deps: Deps) {
      // Tests already constructing in log mode (eventlog integration, etc.) pass through.
      if (deps.eventLog) {
        super(deps);
        return;
      }
      const writer = deps.writer as unknown as {
        load: () => unknown;
        saveImmediate: (s: unknown) => boolean;
        saveDebounced?: (s: unknown) => void;
      };
      // Fake writers lack saveDebounced (legacy seam did not need it) — noop patch.
      if (typeof writer.saveDebounced !== 'function') {
        writer.saveDebounced = () => {};
      }
      let eventsDir = dirByWriter.get(writer as object);
      if (!eventsDir) {
        eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-logmode-matrix-'));
        tempDirs.push(eventsDir);
        dirByWriter.set(writer as object, eventsDir);
        // genesis = this writer's current state (includes pre-seed) — equivalent to legacy
        // constructor writer.load() seed at lamport 0.
        new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).writeDurableSync(
          GENESIS_CHANNEL_REF,
          writer.load(),
          0,
          (d) => ChannelStateWriter.isChannelState(d),
        );
      }
      // fsync barrier ↔ fake saveImmediate probe bridge (per file header).
      const box: { svc: unknown } = { svc: null };
      const log = new AppendOnlyLog({
        dir: eventsDir,
        fsync: () => {
          const svc = box.svc as { state: unknown } | null;
          if (!svc) return; // no append during construction
          if (!writer.saveImmediate(svc.state)) {
            throw new Error('logmode-matrix: bridged persist failure');
          }
        },
      });
      log.open();
      const snapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME), {
        // Effectively infinite so debounced snapshots never write during/after tests.
        debounceMs: 2_000_000_000,
      });
      super({
        ...deps,
        eventLog: {
          log,
          snapshots,
          genesisRef: GENESIS_CHANNEL_REF,
          reseedRefs: [],
          machineId: 'logmode-matrix',
          // Reaper neutralization (per file header).
          emptyChannelTtlHours: 24 * 365 * 100,
        },
      });
      box.svc = this;
      // load() mirroring: legacy committed via saveImmediate every time, so
      // load() == last commit state == (after await) live state. Probe passes
      // pre-apply state under G1, so deep-copy fake (channelCursor) load() lags
      // one mutation — mirror live commit state to restore legacy-equivalent
      // observation (service does not use load() in log mode).
      const origLoad = writer.load.bind(writer);
      writer.load = () =>
        box.svc
          ? structuredClone((box.svc as { state: unknown }).state)
          : origLoad();
    }
  }

  return { ...actual, ChannelService: LogModeChannelService };
});

afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Target: entire existing suite that constructs ChannelService (re-run unchanged files).
import './ChannelService.test';
import './channelCursor.test';
import './ChannelService.rosterIdentity.test';
