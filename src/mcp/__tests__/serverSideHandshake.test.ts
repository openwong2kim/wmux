import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for the PROPER server-side identity handshake.
//
// The MCP server hands main its own pid (`callerPid`) so main can walk the
// process tree on its UNSANDBOXED side to the owning shell anchor. This is the
// only path that resolves identity for Codex, which both sandboxes the
// client-side per-hop PowerShell walk and strips the env hints. The wiring is a
// one-line RPC param + a short-circuit, easy to drop in a refactor — and the
// failure is silent (server walk just never fires, Codex silently falls back to
// the blocked client walk). These regexes lock the three load-bearing lines.
describe('MCP server-side identity handshake (source-level invariant)', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const rawSrc = fs.readFileSync(indexPath, 'utf-8');
  // Strip comments so prose mentioning these names (the rationale above each
  // line) can't satisfy the assertions — only real code counts.
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('sends the caller pid on the a2a.resolve.identity RPC', () => {
    // Since the createWmuxServer factory split the pid rides ctx.callerPid.
    // Both ctx builders must assert their OWN pid: the single-child entry
    // sends process.pid directly; the shim asserts its pid in the broker
    // handshake (the shim sits in the agent's tree where the old child sat,
    // so the walk main runs is over the same ancestry).
    expect(src).toMatch(/a2a\.resolve\.identity[\s\S]{0,120}callerPid:\s*ctx\.callerPid/);
    const entrySrc = fs
      .readFileSync(path.join(__dirname, '..', 'entry.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(entrySrc).toMatch(/callerPid:\s*process\.pid/);
    const shimSrc = fs
      .readFileSync(path.join(__dirname, '..', 'shim.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(shimSrc).toMatch(/callerPid:\s*process\.pid/);
  });

  it('adopts the server-resolved ptyId as the VERIFIED own-pane anchor (channel sender gate)', () => {
    // MY_PTY_ID feeds getSenderPtyId (verified-only); a server-walk hit must set
    // it from main's correlation so channel mutations work when the client walk
    // misses (the Codex case this whole change exists to fix).
    expect(src).toMatch(/MY_PTY_ID\s*=\s*resolved\.ptyId/);
  });

  it('short-circuits a server-walk hit to a verified identity (status:hit) before the client walk', () => {
    expect(src).toMatch(/status:\s*['"]hit['"]\s*,\s*wsId:\s*resolved\.workspaceId/);
  });
});
