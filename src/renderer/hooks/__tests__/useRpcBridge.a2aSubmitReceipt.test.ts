import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #1337 wiring guards. The decisions themselves are unit-tested
 * (`a2aSubmitReceipt.test.ts`, `ptyMessageDelivery.test.ts`); useRpcBridge
 * can't be imported under vitest (pulls in the store/window), so these are
 * source-structural assertions that the delivery paths actually route through
 * the per-pane agent lookup.
 *
 * The failure mode they exist for is silent: go back to a bare
 * `submitBracketedPasteToPty(ptyId, text)` and delivery keeps "working" — the
 * paste still goes out, `notified: true` still comes back — while a Codex pane
 * goes back to a Claude-tuned Enter it swallows.
 *
 * Deliberately coarse. They assert that no delivery call site bypasses the
 * lookup, not how any particular line is formatted, so a rename or a re-wrap
 * does not fail them.
 */
describe('useRpcBridge — A2A submit receipt wiring', () => {
  const dir = path.join(__dirname, '..');
  const bridge = fs.readFileSync(path.join(dir, 'useRpcBridge.ts'), 'utf-8');
  const channels = fs.readFileSync(path.join(dir, 'useChannelsEventSubscription.ts'), 'utf-8');
  const company = fs.readFileSync(
    path.join(dir, '..', '..', 'company', 'renderer', 'rpcHandlers.ts'),
    'utf-8',
  );

  /** Call sites of the raw delivery primitive, excluding its import. */
  function rawCalls(src: string): string[] {
    return src.split('\n').filter((l) => /submitBracketedPasteToPty\(/.test(l) && !/^import/.test(l.trim()));
  }

  it('resolves the agent from the pty being written to, not from the caller', () => {
    // The lookup reads the per-ptyId map. Workspace-level metadata can name a
    // different pane's agent in a multi-agent workspace, which would make the
    // receipt describe a pane that never got the bytes.
    expect(bridge).toMatch(/function ptyAgent\(ptyId: string\)/);
    expect(bridge).toMatch(/surfaceAgent\[ptyId\]/);
    expect(bridge).toMatch(/submitBracketedPasteToPty\(\s*ptyId,\s*text,\s*\{\s*agent: ptyAgent\(ptyId\)\.name/);
  });

  it('routes every useRpcBridge PTY delivery through submitToPty', () => {
    // Exactly one raw call in this file: the one inside submitToPty itself.
    expect(rawCalls(bridge)).toHaveLength(1);
    // ...and a2a.broadcast is one of the callers (it used to be missed).
    expect(bridge).toMatch(/submitToPty\(ptyId, formatA2aBroadcast\(fromName, message\)\)/);
  });

  it('computes the receipt from the pty that was actually written to', () => {
    // Both send branches; the helpers return the ptyId for exactly this reason.
    const receipts = bridge.match(/submitReceiptFields\(ptyAgent\(wrotePty\)\)/g) ?? [];
    expect(receipts).toHaveLength(2);
    // The old boolean return would silently re-enable a caller-supplied agent.
    expect(bridge).toMatch(/function deliverPtyNudge\([\s\S]*?\): string \| null/);
    expect(bridge).toMatch(/function deliverPtyNotification\([\s\S]*?\): string \| null/);
  });

  it('channel @-mention nudges name the receiving agent', () => {
    expect(rawCalls(channels)).toHaveLength(1);
    expect(channels).toMatch(/agent: useStore\.getState\(\)\.surfaceAgent\[ptyId\]\?\.slug/);
  });

  it('company-mode delivery routes through one agent-aware helper', () => {
    // One raw call (inside the helper); every member/CEO write uses the helper.
    expect(rawCalls(company)).toHaveLength(1);
    expect(company).toMatch(/function submitToMemberPty\(ptyId: string, text: string\)/);
    expect(company).toMatch(/surfaceAgent\[ptyId\]\?\.name/);
    expect(company.match(/submitToMemberPty\(/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
  });
});
