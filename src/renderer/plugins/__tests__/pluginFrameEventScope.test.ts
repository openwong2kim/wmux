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
 * PluginFrame renders an iframe and opens a MessagePort, and the default vitest
 * environment here is `node`, so the component cannot be mounted in this suite.
 * These are source-structural guards — the same pattern used by
 * useRpcBridge.focus.test.ts / useRpcBridge.browserClose.test.ts for renderer
 * wiring that can't be imported under vitest. The server-side filter behaviour
 * itself is covered by events.rpc.test.ts.
 */
describe('PluginFrame — events.poll workspace scoping', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'PluginFrame.tsx'), 'utf-8');

  it('reads the active workspace from the store', () => {
    expect(src).toMatch(/const\s+activeWorkspaceId\s*=\s*useStore\(\s*\(s\)\s*=>\s*s\.activeWorkspaceId\s*\)/);
  });

  it('sends workspaceId on the events.poll call, on BOTH the first and subsequent polls', () => {
    const call = src.match(/rpc\(\s*pluginName,\s*'events\.poll'[\s\S]*?\)\n/);
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
    expect(src).toMatch(/\}, \[pluginName, entry, forwardEvents, activeWorkspaceId\]\);/);
  });
});
