import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Structural no-PTY-paste invariant (LanLink C5 / G3). The main-side remote-inbox
// bridge must NEVER import the terminal-paste / execute machinery. A remote,
// untrusted message is materialized as a read-only renderer item over a
// DEDICATED IPC channel; if the bridge source cannot even reference submitToPty /
// deliverPty* / useRpcBridge / a2a.rpc / the pipe _bridge, then an
// origin:'remote' item has no code path to a terminal paste or the execute
// funnel — no matter how the bridge evolves.
//
// Mirrors daemonExecuteWall.test.ts: a source-text assertion (importing the
// modules for a runtime check would defeat the "can never reach this" point).

const LANLINK_DIR = path.join(__dirname, '..');

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+['"][^'"]*useRpcBridge['"]/, label: 'import of useRpcBridge' },
  { pattern: /from\s+['"][^'"]*a2a\.rpc['"]/, label: 'import of a2a.rpc' },
  { pattern: /from\s+['"][^'"]*\/_bridge['"]/, label: 'import of pipe _bridge (sendToRenderer)' },
  // Call-form (not bare word), mirroring daemonExecuteWall's `execute\(` idiom:
  // a doc-comment that NAMES these helpers as forbidden must not trip the scan.
  // What we forbid is an actual call — and an import of their host module
  // (useRpcBridge / pipe _bridge) is already caught by the `from` patterns above.
  { pattern: /\bsubmitToPty\s*\(/, label: 'call to submitToPty' },
  { pattern: /\bdeliverPtyNotification\s*\(/, label: 'call to deliverPtyNotification' },
  { pattern: /\bdeliverPtyNudge\s*\(/, label: 'call to deliverPtyNudge' },
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('remote-inbox no-PTY-paste wall (LanLink C5/G3)', () => {
  const files = collectTsFiles(LANLINK_DIR);

  it('finds main/lanlink source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no main/lanlink source imports the PTY-paste / execute machinery', () => {
    const violations: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(src)) violations.push(`${path.relative(LANLINK_DIR, f)} — ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
