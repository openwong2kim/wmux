import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock (#1228 review, C3): the #1210 dead-slug fix's
 * AppLayout wiring — hydrate, dead-pane exclusion, and the in-flight
 * resolveAgent re-check — was untested (deleting it passed the suite). These
 * locks pin the wiring, following the appLayout.deadPaneRecovery convention.
 */

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/Layout/AppLayout.tsx'),
  'utf8',
);

describe('AppLayout clearSurfaceAgents wiring (#1210 / #1228)', () => {
  it('hydrate runs clearSurfaceAgentsKnownGone after hydrateAgentAlive in both flows', () => {
    // daemon:connected hydrate AND the 15s refreshBindings poll — two call
    // sites, each stamped after the liveness maps they read are hydrated.
    const hydrates = [
      ...source.matchAll(/hydrateAgentAlive\(agentAliveSnapshot\);/g),
    ].map((m) => m.index ?? -1);
    expect(hydrates.length).toBe(2);
    for (const at of hydrates) {
      const window = source.slice(at, at + 500);
      const clearAt = window.indexOf('clearSurfaceAgentsKnownGone(');
      expect(clearAt).toBeGreaterThan(-1);
    }
    expect(source).toMatch(
      /clearSurfaceAgentsKnownGone\(agentAliveSnapshot, commandRunningSnapshot\)/,
    );
    expect(source).toMatch(
      /clearSurfaceAgentsKnownGone\(agentAliveSnapshot, cmdSnapshot\)/,
    );
  });

  it('the agent-seed filter excludes panes known dead', () => {
    expect(source).toMatch(
      /\)\.filter\(\(id\) => agentAliveSnapshot\[id\] !== false && commandRunningSnapshot\[id\] !== false\);/,
    );
  });

  it('resolveAgent re-checks liveness before stamping the slug', () => {
    // The agent may die while resolveAgent is in flight; re-stamping would
    // undo clearSurfaceAgentsKnownGone until the next 15s poll.
    const then = source.indexOf('resolveAgent(ptyId).then((name)');
    const agentGone = source.indexOf('store.agentAliveByPtyId[ptyId] === false', then);
    const cmdGone = source.indexOf('store.commandRunningByPtyId[ptyId] === false', agentGone);
    const stamp = source.indexOf('setSurfaceAgent(ptyId, name', cmdGone);
    expect(then).toBeGreaterThan(-1);
    expect(agentGone).toBeGreaterThan(then);
    expect(cmdGone).toBeGreaterThan(agentGone);
    expect(stamp).toBeGreaterThan(cmdGone);
  });
});
