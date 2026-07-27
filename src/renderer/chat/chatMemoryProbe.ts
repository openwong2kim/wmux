// Chat View memory measurement probe (plan PR-9 / amendment A5).
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The §8 ship criterion for Chat View is a MEASUREMENT, not a test: 30 panes in
// Chat View (with the keep-warm LRU on) must cost no more memory than 30 plain
// terminal panes. `paneResources` cannot answer that — it walks child-process
// PIDs and is a no-op on macOS. The correct instrument is `IPC.APP_MEMORY`
// (`shell.handler.ts`, exposed as `system.getMemoryUsage()`), which sums
// `app.getAppMetrics()` `workingSetSize` across the whole Electron tree: main +
// GPU + every renderer + utility processes. It must be read IN-APP, from the
// renderer of a live app with a real fleet — a standalone script sees nothing.
//
// ─── DOGFOOD PROCEDURE (owner) ──────────────────────────────────────────────
// Run in the app's renderer DevTools console (View ▸ Toggle Developer Tools).
//
//  1. Launch wmux with a daemon-backed session and open 30 terminal panes,
//     each running the same agent workload you care about. Let them settle
//     (~60 s: xterm allocation and the first ring flush both distort an
//     immediate read).
//  2. Baseline:      await __wmuxChatMemory.sample('30 terminals')
//  3. Settings ▸ Terminal ▸ "Unload terminals behind Chat View" → ON.
//  4. Toggle all 30 panes into Chat View (Cmd/Ctrl+Shift+J per pane), then let
//     them settle again (~60 s) so evicted terminals have actually unmounted.
//  5. Comparison:    await __wmuxChatMemory.sample('30 chat panes, LRU on')
//  6. Optional control, LRU OFF (every hidden xterm stays mounted — this is the
//     number the LRU is meant to beat):
//                    await __wmuxChatMemory.sample('30 chat panes, LRU off')
//  7. `__wmuxChatMemory.report()` prints every sample taken this session as one
//     table. Record the numbers in the PR body.
//
// PASS = chat mean ≤ terminal mean. Passing is what flips the setting's default
// to ON; until then it ships OFF.
//
// Each `sample()` call takes `count` reads `intervalMs` apart and reports
// mean/median/min/max, because a single read lands wherever V8's GC happens to
// be. Expect the alt-screen caveat when toggling a pane back to its terminal:
// the daemon's serialize path declines on alt-screen sessions, so the replay
// comes from the ring buffer (up to `bufferSizeMb: 8`) and a multi-second
// repaint is the expected worst case, not a bug.

import { useStore } from '../stores';

export interface ChatMemorySample {
  label: string;
  /** Total Electron-tree working set per read, in MB. */
  readsMB: number[];
  meanMB: number;
  medianMB: number;
  minMB: number;
  maxMB: number;
  /** Context captured at sample time, so a pasted number is self-describing. */
  panes: number;
  chatPanes: number;
  keepWarmLru: boolean;
  at: string;
}

const history: ChatMemorySample[] = [];

const BYTES_PER_MB = 1024 * 1024;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Terminal-surface counts across all workspaces, split by chat mode. */
function paneCounts(): { panes: number; chatPanes: number } {
  let panes = 0;
  let chatPanes = 0;
  const walk = (pane: { type: string; surfaces?: unknown[]; children?: unknown[] }): void => {
    if (pane.type === 'leaf') {
      for (const s of (pane.surfaces ?? []) as { surfaceType?: string; chatMode?: boolean }[]) {
        if (s.surfaceType && s.surfaceType !== 'terminal') continue;
        panes += 1;
        if (s.chatMode) chatPanes += 1;
      }
      return;
    }
    for (const child of (pane.children ?? []) as Parameters<typeof walk>[0][]) walk(child);
  };
  for (const ws of useStore.getState().workspaces) walk(ws.rootPane as Parameters<typeof walk>[0]);
  return { panes, chatPanes };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sample total Electron-tree memory `count` times and log a labeled summary.
 * Dev-facing: reachable as `__wmuxChatMemory.sample(label)` in the console.
 */
export async function sampleAppMemory(
  label: string,
  count = 5,
  intervalMs = 1000,
): Promise<ChatMemorySample> {
  const getMemoryUsage = (globalThis as {
    window?: { electronAPI?: { system?: { getMemoryUsage?: () => Promise<number> } } };
  }).window?.electronAPI?.system?.getMemoryUsage;
  if (typeof getMemoryUsage !== 'function') {
    throw new Error('system.getMemoryUsage is unavailable (no preload bridge)');
  }

  const readsMB: number[] = [];
  for (let i = 0; i < Math.max(1, count); i += 1) {
    if (i > 0) await delay(intervalMs);
    readsMB.push(round((await getMemoryUsage()) / BYTES_PER_MB));
  }

  const { panes, chatPanes } = paneCounts();
  const sample: ChatMemorySample = {
    label,
    readsMB,
    meanMB: round(readsMB.reduce((a, b) => a + b, 0) / readsMB.length),
    medianMB: round(median(readsMB)),
    minMB: Math.min(...readsMB),
    maxMB: Math.max(...readsMB),
    panes,
    chatPanes,
    keepWarmLru: useStore.getState().chatKeepWarmLru,
    at: new Date().toISOString(),
  };
  history.push(sample);

  console.log(
    `[wmux:chat-memory] ${label} — mean ${sample.meanMB} MB (median ${sample.medianMB}, `
    + `min ${sample.minMB}, max ${sample.maxMB}) over ${readsMB.length} reads · `
    + `${panes} terminal panes, ${chatPanes} in chat, keepWarmLru=${sample.keepWarmLru}`,
  );
  return sample;
}

/** Every sample taken in this renderer session. */
export function memorySampleHistory(): readonly ChatMemorySample[] {
  return history;
}

/** Print all samples as one comparison table. */
export function reportMemorySamples(): readonly ChatMemorySample[] {
  console.table(history.map(({ label, meanMB, medianMB, minMB, maxMB, panes, chatPanes, keepWarmLru }) => ({
    label, meanMB, medianMB, minMB, maxMB, panes, chatPanes, keepWarmLru,
  })));
  return history;
}

interface ChatMemoryProbeApi {
  sample: typeof sampleAppMemory;
  history: typeof memorySampleHistory;
  report: typeof reportMemorySamples;
}

/**
 * Expose the probe on `window.__wmuxChatMemory` for the console procedure
 * above, mirroring the existing `__wmux*` renderer-global pattern
 * (`useRpcBridge`). Returns the uninstaller.
 */
export function installChatMemoryProbe(): () => void {
  const w = globalThis as unknown as { __wmuxChatMemory?: ChatMemoryProbeApi };
  w.__wmuxChatMemory = {
    sample: sampleAppMemory,
    history: memorySampleHistory,
    report: reportMemorySamples,
  };
  return () => { delete w.__wmuxChatMemory; };
}
