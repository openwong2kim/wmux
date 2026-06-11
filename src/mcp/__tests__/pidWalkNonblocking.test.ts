import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for the MCP identity PID walk (#194).
//
// getParentPid() spawns a child process per hop to walk the PID tree
// (PowerShell Get-CimInstance on Windows, `ps` elsewhere) up to depth 10, each
// hop bounded by a multi-second timeout. It runs on the workspace-identity hot
// path — reached by resolveWorkspaceId/requireWorkspaceId for A2A and browser
// auto-open, and by resolveTerminalRoute for terminal IO. Using the SYNCHRONOUS
// execFileSync blocks the Node event loop for the whole walk, freezing every
// other MCP operation (and, inside PlaywrightEngine's getPageLock, serializing
// all browser tools behind one slow auto-open). The walk must therefore use the
// ASYNC execFile so the event loop stays free while each child process runs.
describe('MCP PID walk is non-blocking (source-level invariant, #194)', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const rawSrc = fs.readFileSync(indexPath, 'utf-8');

  // Strip block + line comments so prose that merely mentions a primitive by
  // name (e.g. a comment explaining why execFileSync was dropped) never trips
  // the invariant — only real call sites count.
  function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  const src = stripComments(rawSrc);

  it('never uses the synchronous execFileSync on the identity hot path', () => {
    // execFileSync blocks the event loop until the spawned process exits — up to
    // the per-hop timeout × depth. The PID walk must not use it.
    expect(src).not.toMatch(/execFileSync/);
  });

  it('walks the PID tree with the async execFile (promisified)', () => {
    // The async replacement: import execFile and await a promisified call, so
    // each child process runs without parking the event loop.
    expect(src).toMatch(/\bexecFile\b/);
    expect(src).toMatch(/\bpromisify\b/);
  });
});
