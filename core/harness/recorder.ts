// E0 conformance harness — M1 recorder (spec: engine-core-decision-2026-07-09.md §5-1)
//
// Script-driven recording library. Three output artifacts:
//   - recording.bin  raw bytes (deterministic byte stream from workload)
//   - events.jsonl   initial geometry·resize·reflow_mode trail (monotonic byte offsets)
//   - meta.json      seed·workload script hash·governance fields
//
// ── PTY round-trip vs determinism (design decision, spec §5-1 "synthetic generator first"·"2 runs same bytes") ──
// Spawns a real PTY via node-pty (existing product dependency) to **demonstrate in practice**
// initial geometry apply and resize execution (macOS forkpty path). However, the **canonical**
// recording.bin bytes are not echo from the PTY slave but the synthetic byte stream from the
// workload generator. Reasons:
//   1) Line discipline (ONLCR, echo, ISIG, etc.) can non-deterministically or unintentionally
//      transform synthetic bytes, breaking "same script twice = same bytes" or diverging from workload intent.
//   2) What we verify is "how the terminal emulator interprets this byte stream into a grid";
//      that input is bytes the child writes to master, not bytes master writes to child.
//      In synthetic workloads the latter is our byte stream (child must be pure passthrough).
// So recorder spawns PTY to apply geometry/resize for real, but records workload bytes
// deterministically into recording.bin. Real CLI recording (cli-recording mode) collects child
// output — non-determinism is unavoidable there, so it is not promoted to commit corpus (D4 governance).

import { spawn, type IPty } from 'node-pty';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import type { Geometry, RecordingEvent, RecordingMeta } from './types';
import type { Workload } from './workloads';
import { SeededRng } from './workloads';

/** sha256 hex of recording.bin. Used to verify same script recorded twice yields same hash. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** events.jsonl serialization: one JSON line per event. */
export function serializeEvents(events: readonly RecordingEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** events.jsonl parsing (used by replay side). Skips blank lines. */
export function parseEvents(text: string): RecordingEvent[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordingEvent);
}

/**
 * Spawn PTY, apply initial geometry, run trail resize events in order.
 * Child must be pure passthrough (cat-like); purpose is to demonstrate "PTY round-trip works
 * in practice" (return value unused — canonical bytes come from workload). Child is terminated
 * and cleaned up immediately. macOS/Linux use openpty(forkpty), Windows conpty — no win-only assumptions here.
 *
 * ── Error promotion (R8) ──────────────────────────────────────────────────────────
 * Previously spawn/resize/exit failures were swallowed (best-effort). This function is called
 * from gate④ and corpus generation paths, so swallowing failures silently disables proof that
 * "geometry path actually works". Hence spawn failure, resize failure, abnormal exit (non-zero
 * code or signal) are **promoted to throw** — surfaces as test failure for CI. Normal termination
 * (cat receiving SIGHUP/SIGTERM from kill) is treated as normal cleanup (we induced kill).
 */
async function exercisePty(initial: Geometry, resizes: readonly Geometry[]): Promise<void> {
  // Pure passthrough child: stdin to stdout. macOS `cat` with no args is stdin→stdout.
  // Not used as canonical output due to determinism/line-discipline issues (design note above) — geometry/resize demo only.
  const shell = platform() === 'win32' ? 'cmd.exe' : 'cat';
  let child: IPty;
  try {
    child = spawn(shell, [], {
      name: 'xterm-256color',
      cols: initial.cols,
      rows: initial.rows,
      cwd: process.cwd(),
      env: { ...process.env } as { [key: string]: string },
    });
  } catch (e) {
    // R8: do not swallow spawn failure — prevents geometry demo from being silently disabled.
    throw new Error(`[recorder] PTY spawn failed (${shell}): ${String(e)}`);
  }

  // Wire onExit before kill to verify exit code/signal (R8). node-pty observed semantics (macOS):
  // our kill-induced exit = {exitCode:0, signal:1(SIGHUP)} — signal present. Child dying abnormally
  // on its own = {exitCode≠0, signal:0} — no signal. Promote "exitCode≠0 && no signal" as abnormal
  // exit (our kill leaves a signal, so no false positive).
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });

  try {
    // Apply resizes in order from initial geometry — exercises PTY resize path.
    for (const g of resizes) {
      child.resize(g.cols, g.rows);
    }
  } catch (e) {
    // R8: promote resize failure too. Attempt cleanup but throw original error.
    try {
      child.kill();
    } catch {
      /* Ignore cleanup failure so it does not mask original error. */
    }
    throw new Error(`[recorder] PTY resize failed: ${String(e)}`);
  }

  // Terminate child immediately. cat exits on stdin EOF; kill ensures reclaim.
  child.kill();

  // onExit code check (R8): promote abnormal self-exit (abnormal code without signal).
  const { exitCode, signal } = await exited;
  if (exitCode !== 0 && !signal) {
    throw new Error(`[recorder] PTY abnormal exit: code=${exitCode} signal=${signal ?? 'none'}`);
  }
}

/** Recording artifact filenames (inside corpus case directory). */
export const RECORDING_BIN = 'recording.bin';
export const EVENTS_JSONL = 'events.jsonl';
export const META_JSON = 'meta.json';

export interface RecordResult {
  readonly bytes: Uint8Array;
  readonly events: RecordingEvent[];
  readonly meta: RecordingMeta;
}

/**
 * Record one workload (returns artifacts without writing files — good for determinism tests).
 * Spawns PTY to demo geometry/resize, then assembles canonical bytes/trail/meta.
 *
 * @param seed Workload PRNG seed (synthetic workloads: fixed seed → same bytes).
 */
export async function record(workload: Workload, seed = 0): Promise<RecordResult> {
  const rng = new SeededRng(seed);
  const bytes = workload.build(rng);

  // Trail: init (head) + resize/reflow events from workload.
  const trail = workload.trail(bytes);
  const events: RecordingEvent[] = [
    { type: 'init', byteOffset: 0, geometry: workload.initialGeometry, reflowMode: workload.reflowMode },
    ...trail,
  ];

  // byteOffset monotonic increase and range invariant (spec §5-1 "monotonic byte offset").
  let prev = -1;
  for (const e of events) {
    if (e.byteOffset < prev) {
      throw new Error(`[recorder] byteOffset not monotonically increasing: ${e.byteOffset} < ${prev}`);
    }
    if (e.byteOffset < 0 || e.byteOffset > bytes.length) {
      throw new Error(`[recorder] byteOffset out of range: ${e.byteOffset} (0..${bytes.length})`);
    }
    prev = e.byteOffset;
  }

  // PTY round-trip demo (geometry apply + resize). Does not affect canonical bytes.
  const resizes = trail.filter((e): e is Extract<RecordingEvent, { type: 'resize' }> => e.type === 'resize').map((e) => e.geometry);
  await exercisePty(workload.initialGeometry, resizes);

  const meta: RecordingMeta = {
    workloadName: workload.name,
    seed,
    workloadHash: sha256Hex(bytes),
    synthetic: true,
    createdVia: 'synthetic-generator',
    initialGeometry: workload.initialGeometry,
  };

  return { bytes, events, meta };
}

/** Write recording artifacts to corpus directory (outDir/{workloadName}/). */
export function writeRecording(outDir: string, result: RecordResult): string {
  const caseDir = path.join(outDir, result.meta.workloadName);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, RECORDING_BIN), result.bytes);
  writeFileSync(path.join(caseDir, EVENTS_JSONL), serializeEvents(result.events));
  writeFileSync(path.join(caseDir, META_JSON), JSON.stringify(result.meta, null, 2) + '\n');
  return caseDir;
}
