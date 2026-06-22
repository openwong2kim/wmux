// ─── useRpcBridge — events.poll bridge (U3, R3) ────────────────────────
// Source-structural regression guard for the renderer-side channel-message
// subscription bridge. `useChannelsEventSubscription` drives a 1 Hz
// `events.poll` loop and dispatches results into the channelsSlice; if
// the bridge is missing the hook falls into its warn-and-bail path (see
// `useChannelsEventSubscription.ts:113-126`), and live channel messages
// never reach the slice. `handleRpcMethod` is not exported and pulls in
// the store/window, so importing it under vitest isn't practical — the
// structural pattern below mirrors `useRpcBridge.focus.test.ts` /
// `useRpcBridge.browserClose.test.ts`.
//
// Plan U3 contract:
//   - Install shape: `__wmuxEventsPoll` is a function that takes the
//     `events.poll` params directly (not a `(method, params)` pair).
//     This matches the consumer's call site `bridge({ cursor, types,
//     max, workspaceId })`.
//   - Forwarding: the install MUST route through
//     `window.electronAPI.rpc.invoke('events.poll', params)` so the
//     new `rpc:invoke` IPC channel (added in src/shared/constants.ts
//     and src/main/ipc/registerHandlers.ts) reaches the live pipe
//     RpcRouter. A previous implementation called `handleRpcMethod`
//     directly, which has no `events.poll` handler and silently
//     returned `{ error: 'unknown method: events.poll' }` on every
//     tick — the renderer appeared healthy but no events arrived.
//   - Type: params carry `workspaceId` so the daemon-side per-workspace
//     post-filter at `events.rpc.ts:115-124` admits the renderer's own
//     workspace's events (plan R3). Without it, every event is silently
//     dropped and the UI is indistinguishable from a healthy empty
//     stream.
//   - Cleanup: symmetric install/delete — a stale global across
//     renderer remounts would race the new mount's bridge.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('useRpcBridge — __wmuxEventsPoll bridge (U3, R3)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  it('installs window.__wmuxEventsPoll on effect mount', () => {
    // Must appear in the useEffect body (not just in a type annotation)
    // and must forward through `electronAPI.rpc.invoke('events.poll', ...)`
    // so the new IPC channel reaches the live pipe RpcRouter. Anchored on
    // the electronAPI call so a regression to `handleRpcMethod` (no
    // events.poll handler) is caught.
    const install = src.match(/__wmuxEventsPoll\s*=\s*\([\s\S]*?\)\s*=>\s*([\s\S]*?);/);
    expect(install, '__wmuxEventsPoll install must be present').not.toBeNull();
    if (!install) return;
    expect(install[0]).toMatch(/electronAPI\.rpc\.invoke\(\s*'events\.poll'/);
  });

  it('cleans up window.__wmuxEventsPoll on effect teardown', () => {
    // Symmetric install/delete: a stale global across renderer
    // remounts would race the new mount's bridge and could observe
    // partially-torn-down state. The cleanup must delete the same
    // key the install wrote. Anchor on the useEffect return body so
    // the regex lands on the whole cleanup block (each `delete` line
    // has its own `}` from the cast, so a non-greedy `[\s\S]*?\}` past
    // `clearInterval(gcTimer)` would only capture the first delete).
    const cleanup = src.match(/return \(\) => \{[\s\S]*?clearInterval\(gcTimer\)[\s\S]*?__wmuxChannelsRpc[\s\S]*?\};/);
    expect(cleanup, 'useEffect cleanup block must exist').not.toBeNull();
    if (!cleanup) return;
    expect(cleanup[0]).toMatch(/delete\s+\(window as unknown as \{ __wmuxEventsPoll\?/);
    // The sibling __wmuxChannelsRpc global also gets the same teardown
    // (U4 added it parallel to __wmuxEventsPoll).
    expect(cleanup[0]).toMatch(/delete\s+\(window as unknown as \{ __wmuxChannelsRpc\?/);
  });

  it('declares the bridge type as a one-param facade taking events.poll params', () => {
    // The channel-subscription hook only ever calls events.poll with
    // { cursor, types, max, workspaceId }. A broader type would let a
    // future caller route other methods through this global and
    // bypass the type contract. Pin the shape.
    const typeBlock = src.match(/__wmuxEventsPoll:\s*\([\s\S]*?\)\s*=>\s*Promise<RpcResult>/);
    expect(typeBlock, 'bridge type annotation must be present').not.toBeNull();
    if (!typeBlock) return;
    expect(typeBlock[0]).toMatch(/cursor:\s*number/);
    expect(typeBlock[0]).toMatch(/types:\s*string\[\]/);
    expect(typeBlock[0]).toMatch(/workspaceId:\s*string/);
    // One-param facade — the install must NOT take a leading `method`
    // argument (consumer contract is `bridge(params)` not
    // `bridge(method, params)`).
    expect(typeBlock[0]).not.toMatch(/method:\s*'events\.poll'/);
  });
});
