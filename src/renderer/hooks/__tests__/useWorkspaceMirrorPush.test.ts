// Source-structural guard for the WorkspaceMirror push policy. The hook pulls in
// the store/window (can't be imported under vitest), so — like
// useRpcBridge.eventsPoll.test.ts — we lock the load-bearing wiring against the
// source. The pure payload construction is covered directly in
// workspaceMirrorSnapshot.test.ts.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('useWorkspaceMirrorPush — push policy wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useWorkspaceMirrorPush.ts'), 'utf-8');

  it('gates every push on paneGate === ready (mid-reconcile safety)', () => {
    expect(src).toMatch(/paneGate\s*!==\s*'ready'/);
  });

  it('sends through the optional-chained electronAPI workspaceMirror.push surface', () => {
    // Optional chaining is mandatory in the renderer (a stale preload / partial
    // test mock may not expose it — jsdom crashes on a bare access).
    expect(src).toMatch(/window\.electronAPI\?\.workspaceMirror\?\.push\?\.\(/);
  });

  it('pushes leading-edge on a structural change (workspaces identity / active ws)', () => {
    expect(src).toMatch(/s\.workspaces\s*!==\s*prev\.workspaces/);
    expect(src).toMatch(/s\.activeWorkspaceId\s*!==\s*prev\.activeWorkspaceId/);
    expect(src).toMatch(/flushLeading\(\)/);
  });

  it('debounces status-only churn with a 300ms trailing timer', () => {
    expect(src).toMatch(/STATUS_DEBOUNCE_MS\s*=\s*300/);
    expect(src).toMatch(/scheduleTrailing/);
    // The debounced inputs are the fleet selector's per-pane status sources.
    expect(src).toMatch(/surfaceAgentStatus\s*!==\s*prev\.surfaceAgentStatus/);
  });

  it('keys the churn debounce on every map the isAgent flag is derived from', () => {
    // An agent-vs-shell flip decides whether the deck's Stop / completion gates
    // count the pane at all. Missing keys here left that flip waiting for the
    // 30s periodic refresh, so a Stop could be judged on the stale answer.
    for (const key of [
      'surfaceAgent',
      'surfacePendingQuestion',
      'resumeBindingByPtyId',
      'resumeHintByPtyId',
      'agentAliveByPtyId',
      'commandRunningByPtyId',
    ]) {
      // Exact identifier match: `surfaceAgent` must not be satisfied by the
      // `surfaceAgentStatus` line that sits right above it.
      expect(src).toMatch(new RegExp(`s\\.${key} !== prev\\.${key}(?![A-Za-z])`));
    }
  });

  it('does NOT key the churn debounce on the ~2s agent clock', () => {
    // agentClockMs ticks every ~2s while agents run; keying the debounce on it
    // re-pushed the full payload every 2s all session. The periodic refresh
    // carries decay-derived changes instead.
    expect(src).not.toMatch(/agentClockMs\s*!==\s*prev\.agentClockMs/);
  });

  it('runs a slow periodic refresh (30s, unref\'d) to carry decay-derived changes', () => {
    expect(src).toMatch(/PERIODIC_REFRESH_MS\s*=\s*30_000/);
    expect(src).toMatch(/setInterval\(push,\s*PERIODIC_REFRESH_MS\)/);
    expect(src).toMatch(/\.unref\?\.\(\)/);
  });

  it('subscribes to the store and cleans up the subscription + timers on unmount', () => {
    expect(src).toMatch(/useStore\.subscribe\(/);
    expect(src).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*clearTimeout\(trailingTimer\)[\s\S]*clearInterval\(refreshTimer\)[\s\S]*unsub\(\)/,
    );
  });
});
