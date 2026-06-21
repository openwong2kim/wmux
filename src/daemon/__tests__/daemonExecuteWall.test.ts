import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant: the daemon process must NEVER import the execute
// machinery. This is the PRIMARY, strongest layer of "remote A2A messages can
// never reach claudeWorker.execute()" (LanLink C1). The daemon is a separate OS
// process; if it cannot even import ClaudeWorker / RpcRouter / a2a.rpc, then a
// remote LAN listener that lives in the daemon (future LanLink PR) has no code
// path to spawn an agent — no matter how the dispatch logic above it evolves.
//
// This mirrors the repo's established source-invariant pattern (see
// squirrelWiring.test.ts): we assert over source text because importing the
// modules for a runtime check would defeat the "daemon never loads this" point.

const DAEMON_DIR = path.join(__dirname, '..');

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+['"][^'"]*ClaudeWorker['"]/, label: "import of ClaudeWorker" },
  { pattern: /from\s+['"][^'"]*\/RpcRouter['"]/, label: "import of RpcRouter" },
  { pattern: /from\s+['"][^'"]*a2a\.rpc['"]/, label: "import of a2a.rpc" },
  { pattern: /\bclaudeWorker\.execute\s*\(/, label: "call to claudeWorker.execute()" },
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

describe('daemon execute-wall — process-boundary invariant (LanLink C1)', () => {
  const files = collectTsFiles(DAEMON_DIR);

  it('finds daemon source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no daemon source imports ClaudeWorker / RpcRouter / a2a.rpc, nor calls claudeWorker.execute()', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(src)) {
          violations.push(`${path.relative(DAEMON_DIR, file)} — ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
