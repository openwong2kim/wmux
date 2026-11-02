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
import { agentProcessExitEvent } from '../AgentProcessTracker';

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
    expect(listenerBody()).toMatch(
      /const exitEvent = agentProcessExitEvent\(sessionId, state\);\s*if \(exitEvent\) pipeServer\.broadcast\(exitEvent\);/,
    );
  });

  it('sends it on the DEATH edge only — a launch, a successor included, settles nothing', () => {
    expect(agentProcessExitEvent('s', { alive: true, slug: 'claude' })).toBeNull();
    expect(agentProcessExitEvent('s', { alive: true, slug: 'claude', replacedLive: true, observedAt: 1 })).toBeNull();
  });

  it('carries the watched agent slug so the consumer can scope the clear', () => {
    expect(agentProcessExitEvent('s', { alive: false, slug: 'claude' })).toEqual({
      type: 'agent.processExit',
      sessionId: 's',
      data: { slug: 'claude' },
    });
    expect(agentProcessExitEvent('s', { alive: false })?.data.slug).toBeNull();
  });

  it('still expires the pane hook authority on the same edge', () => {
    // #919's release. Both run on this edge and neither replaces the other:
    // authority expiry frees the detector veto, the broadcast settles the dot.
    expect(listenerBody()).toMatch(/hookIngest\?\.expireAuthorityFor\(/);
  });

  it('#2673 retires the dead launch on a relaunch edge, and feeds the tracker the pane\'s launch count', () => {
    // A relaunch the tracker found where its watched agent died carries no
    // death edge: its launch edge expires the old launch's authority, scoped
    // to signals before the relaunch's command start.
    const body = listenerBody();
    expect(body).toMatch(/if \(state\.alive && state\.replacedLive\) \{[\s\S]*?hookIngest\?\.expireAuthorityFor\(sessionId, undefined, launchAt\);/);
    expect(body).toMatch(/if \(!state\.alive \|\| state\.replacedLive\) usageLimits\?\.drop\(sessionId\);/);
    expect(src).toMatch(/agentProcessTracker\.setLaunchCounter\(\(sessionId\) => sessionManager\.getSession\(sessionId\)\?\.bridge\.getCommandStarts\(\)\);/);
  });
});
