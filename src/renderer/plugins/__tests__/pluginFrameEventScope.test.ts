import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Workspace scoping for the plugin `events.poll` loop.
 *
 * PluginFrame used to poll with `{}` / `{ cursor }` — no workspaceId. On the
 * server, `events.rpc.ts` drops only the PRIVATE types (a2a.task, channel.*)
 * for an unscoped poll; every LIFECYCLE type (pane.created / closed / focused,
 * process.*) falls through to an all-workspace firehose. So a plugin that
 * declared `events.subscribe` observed lifecycle events from workspaces the
 * user never granted it. The fix sends the active workspaceId on every poll and
 * re-subscribes when the active workspace changes.
 *
 * These are source-structural guards on the poll's params, which a behavioural
 * test cannot pin as precisely. The re-subscribe itself is now asserted by
 * mounting the component — see PluginFrame.bridge.dynamic.test.tsx, which also
 * covers the constraint that came out of it: the bridge port must NOT be torn
 * down by a workspace switch, so the two concerns live on separate effects and
 * the poll's dependency list is no longer the whole component's. The
 * server-side filter behaviour itself is covered by events.rpc.test.ts.
 */
describe('PluginFrame — events.poll workspace scoping', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'PluginFrame.tsx'), 'utf-8');

  it('reads the active workspace from the store', () => {
    expect(src).toMatch(/const\s+activeWorkspaceId\s*=\s*useStore\(\s*\(s\)\s*=>\s*s\.activeWorkspaceId\s*\)/);
  });

  it('sends workspaceId on the events.poll call, on BOTH the first and subsequent polls', () => {
    const call = src.match(/rpc\(\s*pluginName,\s*'events\.poll'[\s\S]*?\)\r?\n/);
    expect(call, 'events.poll call site not found').not.toBeNull();
    const text = call![0];
    // The cursor===null (first poll) and cursor branches are separate object
    // literals; a fix applied to only one of them still leaks on the other.
    const scoped = text.match(/workspaceId:\s*activeWorkspaceId/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(2);
  });

  it('never polls with a bare {} or cursor-only param object', () => {
    expect(src).not.toMatch(/'events\.poll',\s*cursor === null \? \{\} :/);
    expect(src).not.toMatch(/'events\.poll',\s*\{\s*\}\s*\)/);
    expect(src).not.toMatch(/'events\.poll',\s*\{\s*cursor\s*\}\s*\)/);
  });

  it('re-runs the subscribe effect when the active workspace changes', () => {
    // Without activeWorkspaceId in the deps the loop would keep polling the
    // workspace that was active at mount after the user switched away.
    expect(src).toMatch(/\}, \[pluginName, forwardEvents, activeWorkspaceId, bridgeEpoch\]\);/);
  });

  it('keeps the bridge effect off the active workspace', () => {
    // The port is created once, in the iframe's `load` handler, and `load` does
    // not fire again for an unchanged src. A workspace switch that re-runs this
    // effect therefore closes the port with nothing left to rebuild it.
    expect(src).toMatch(/\}, \[pluginName, entry\]\);/);
  });
});
