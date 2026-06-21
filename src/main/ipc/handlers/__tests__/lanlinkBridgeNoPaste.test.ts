import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Sibling of src/main/lanlink/__tests__/remoteInboxNoPaste.test.ts (LanLink PR-5,
// D4). The PR-2 wall scans ONLY src/main/lanlink/**, but the PR-5 main-process
// pairing/peer bridge lives in src/main/ipc/handlers/lanlink.handler.ts — OUTSIDE
// that scope, so the original test passes trivially without covering it.
//
// This pins the same structural no-PTY-paste invariant on the new bridge file: it
// forwards ONLY to daemonClient.lanlink*(), so it must never import or call the
// terminal-paste / execute machinery (submitToPty / deliverPty* / useRpcBridge /
// a2a.rpc / the pipe _bridge). The genuine no-paste wall is the dedicated
// LANLINK_REMOTE IPC channel architecture (PR-2) + the control-pipe-only outbound
// path; this is a cheap regression guard that fails loudly if a future edit ever
// wires paste machinery into the bridge.

const HANDLER = path.join(__dirname, '..', 'lanlink.handler.ts');

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+['"][^'"]*useRpcBridge['"]/, label: 'import of useRpcBridge' },
  { pattern: /from\s+['"][^'"]*a2a\.rpc['"]/, label: 'import of a2a.rpc' },
  { pattern: /from\s+['"][^'"]*\/_bridge['"]/, label: 'import of pipe _bridge (sendToRenderer)' },
  { pattern: /\bsubmitToPty\s*\(/, label: 'call to submitToPty' },
  { pattern: /\bdeliverPtyNotification\s*\(/, label: 'call to deliverPtyNotification' },
  { pattern: /\bdeliverPtyNudge\s*\(/, label: 'call to deliverPtyNudge' },
];

describe('LanLink PR-5 bridge no-PTY-paste wall (D4 sibling scan)', () => {
  it('lanlink.handler.ts exists (the bridge under guard)', () => {
    expect(fs.existsSync(HANDLER)).toBe(true);
  });

  it('the pairing bridge handler imports/calls no PTY-paste / execute machinery', () => {
    const src = fs.readFileSync(HANDLER, 'utf-8');
    const violations = FORBIDDEN.filter(({ pattern }) => pattern.test(src)).map((f) => f.label);
    expect(violations).toEqual([]);
  });
});
