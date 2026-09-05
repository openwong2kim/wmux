// Wiring guard for the agent-process death edge.
//
// A pane whose status the HOOK owns has exactly two settle paths: the Stop
// hook, and the agent process dying. An agent killed mid-turn (double Ctrl+C,
// /exit, a crash) sends no Stop, and byte silence no longer clears a
// hook-governed pane — so if this broadcast is ever dropped from the tracker's
// state-change listener the pane sits lit for the 30-minute authority TTL with
// nothing left to clear it.
//
// Source-shape assertions, following completionAlarmWiring.test.ts: the
// listener lives inside `startDaemon`, which cannot be constructed in a unit
// test. The BEHAVIOUR the broadcast drives is covered main-side in
// DaemonNotificationRouter.hookRunning.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('agent.processExit daemon wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function listenerBody(): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes('agentProcessTracker.setStateChangeListener('));
    if (startIdx < 0) throw new Error('setStateChangeListener wiring not found');
    const endIdx = lines.findIndex((l, i) => i > startIdx && l === '  });');
    return lines.slice(startIdx, endIdx > 0 ? endIdx : lines.length).join('\n');
  }

  it('broadcasts agent.processExit from the tracker state-change listener', () => {
    expect(listenerBody()).toMatch(/type: 'agent\.processExit'/);
  });

  it('sends it on the DEATH edge only — a launch settles nothing', () => {
    const body = listenerBody();
    const broadcastIdx = body.indexOf("type: 'agent.processExit'");
    // The nearest preceding statement must be the not-alive guard.
    const guardIdx = body.lastIndexOf('if (!state.alive) {', broadcastIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(broadcastIdx);
  });

  it('carries the watched agent slug so the consumer can scope the clear', () => {
    expect(listenerBody()).toMatch(/slug: state\.slug/);
  });

  it('still expires the pane hook authority on the same edge', () => {
    // #919's release. Both run on this edge and neither replaces the other:
    // authority expiry frees the detector veto, the broadcast settles the dot.
    expect(listenerBody()).toMatch(/hookIngest\?\.expireAuthorityFor\(/);
  });
});
