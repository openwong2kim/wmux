import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readSourceText } from '../../../../test-utils/sourceText';

/**
 * Source-level regression lock (#1228 review, C3): the #1210 dead-slug fix's
 * AppLayout wiring — hydrate, dead-pane exclusion, and the in-flight
 * resolveAgent re-check — was untested (deleting it passed the suite). These
 * locks pin the wiring, following the appLayout.deadPaneRecovery convention.
 */

const source = readSourceText(path.resolve(process.cwd(), 'src/renderer/components/Layout/AppLayout.tsx'));

describe('AppLayout clearSurfaceAgents wiring (#1210 / #1228)', () => {
  it('hydrate runs clearSurfaceAgentsKnownGone after hydrateAgentAlive in both flows', () => {
    // daemon:connected hydrate AND the 15s refreshBindings poll — two call
    // sites, each stamped after the liveness maps they read are hydrated.
    const hydrates = [
      ...source.matchAll(/hydrateAgentAlive\(agentAliveSnapshot\);/g),
    ].map((m) => m.index ?? -1);
    expect(hydrates.length).toBe(2);
    // "Right after" by structure, not by a character count: a count broke
    // when one line was added between the two calls (#2410), and earlier on
    // Windows alone, where CRLF made the same code longer. The next clear
    // must be in the same block as the hydrate (braces between them balance
    // and never close it) with no `await` or `return` between, so it runs
    // synchronously after it on every path. Comments are stripped first.
    for (const at of hydrates) {
      const clearAt = source.indexOf('clearSurfaceAgentsKnownGone(', at);
      expect(clearAt, 'a clear after the hydrate').toBeGreaterThan(at);
      const between = source.slice(at, clearAt).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      let depth = 0;
      for (const ch of between) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        expect(depth, 'the clear stays in the hydrate\'s block').toBeGreaterThanOrEqual(0);
      }
      expect(depth, 'the clear is not nested inside a new block').toBe(0);
      expect(between).not.toMatch(/\bawait\b|\breturn\b/);
    }
    expect(source).toMatch(
      /clearSurfaceAgentsKnownGone\(agentAliveSnapshot, commandRunningSnapshot, requestedAt\)/,
    );
    expect(source).toMatch(
      /clearSurfaceAgentsKnownGone\(agentAliveSnapshot, cmdSnapshot, requestedAt\)/,
    );
  });

  it('the agent process-death edge drops the row without waiting for the poll', () => {
    // daemon broadcast -> main forward -> preload channel -> AppLayout handler.
    const read = (rel: string) => readSourceText(path.resolve(process.cwd(), rel));
    expect(read('src/main/ipc/handlers/pty.handler.ts')).toMatch(
      /daemonClient\.on\('session:agentProcessExit', onDaemonAgentProcessExit\)/,
    );
    expect(read('src/main/ipc/handlers/pty.handler.ts')).toMatch(
      /send\(IPC\.AGENT_PROCESS_EXIT, \{ ptyId: payload\.sessionId, slug: payload\.slug \?\? null \}\)/,
    );
    expect(read('src/preload/preload.ts')).toMatch(/onAgentProcessExit:[\s\S]{0,300}ipcRenderer\.on\(IPC\.AGENT_PROCESS_EXIT, listener\)/);
    expect(source).toMatch(
      /window\.electronAPI\.pty\.onAgentProcessExit\(\(payload\) => \{\s*clearSurfaceAgentOnProcessExit\(payload\.ptyId, payload\.slug, Date\.now\(\)\);/,
    );
    expect(source).toMatch(/offAgentExit\(\);/);
  });

  it('both polls mark a pane dead in a snapshot asked for before its death edge', () => {
    const marks = [...source.matchAll(/applyProcessExits\(agentAliveSnapshot, requestedAt\);/g)].map((m) => m.index ?? -1);
    expect(marks.length).toBe(2);
    // Before the snapshot is hydrated and before the clear and the seed read it.
    for (const at of marks) {
      const hydrate = source.indexOf('hydrateAgentAlive(agentAliveSnapshot);', at);
      expect(hydrate).toBeGreaterThan(at);
      expect(source.slice(at, hydrate)).not.toMatch(/\bawait\b|\breturn\b|seedSurfaceAgentsFromProcess|clearSurfaceAgentsKnownGone/);
    }
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
