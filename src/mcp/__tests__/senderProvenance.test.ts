import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for the WI-002 senderPtyId provenance split.
//
// The bundled MCP server (src/mcp/index.ts) boots its stdio transport on import
// (main() runs at module load), so its internal resolver/handlers can't be
// imported under vitest — the same reason pidWalkNonblocking.test.ts locks the
// PID-walk as a source invariant. Behavioral proof of the fallback lives in the
// live dogfood (scripts/wi-002-mcp-identity-dogfood.mjs). This file locks the
// SECURITY-CRITICAL wiring statically so a future "helpful unification" can't
// silently downgrade channel authz.
//
// The split (codex outside-voice finding, eng-review):
//   - MY_PTY_ID   = VERIFIED — set ONLY from a PID-map walk hit (our process
//                   tree provably owns that live pane; unforgeable).
//   - ENV_PTY_HINT = WEAK — the WMUX_PTY_ID spawn env, a same-user-spoofable
//                   channel (like WMUX_WORKSPACE_ID).
//   - getTaskSenderPtyId() = MY_PTY_ID || ENV_PTY_HINT — used by the A2A task +
//                   terminal tools (a forged value only mislabels the caller's
//                   OWN pane / arms a reject-only guard).
//   - a2a.channel.* MUST stay on MY_PTY_ID (verified-only): a2a.channel.rpc.ts
//                   gates mutating calls on a resolvable senderPtyId, so feeding
//                   the weak hint there would turn unforgeable PID-tree proof
//                   into a spoofable env var.
function stripComments(s: string): string {
  // Drop block + line comments so prose mentioning a token by name never trips
  // an invariant — only real code counts (mirrors pidWalkNonblocking.test.ts).
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const mcpIndexSrc = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8'),
);
const mcpEntrySrc = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'entry.ts'), 'utf-8'),
);
const mcpShimSrc = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'shim.ts'), 'utf-8'),
);
const ptyManagerSrc = stripComments(
  fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'pty', 'PTYManager.ts'), 'utf-8'),
);

describe('WI-002 senderPtyId provenance (source-level invariant)', () => {
  it('ENV_PTY_HINT is sourced from the WMUX_PTY_ID spawn env', () => {
    // Since the createWmuxServer factory split, the hint arrives via ctx:
    // index.ts reads ctx.envPtyHint, and BOTH entries that build a ctx —
    // the single-child stdio entry and the broker shim's handshake — must
    // source that field from the WMUX_PTY_ID spawn env. The invariant is
    // the same (weak hint comes only from the spawn env); the plumbing has
    // one extra hop.
    expect(mcpIndexSrc).toMatch(/const\s+ENV_PTY_HINT\s*=\s*ctx\.envPtyHint/);
    expect(mcpEntrySrc).toMatch(/envPtyHint:\s*process\.env\.WMUX_PTY_ID\s*\|\|\s*''/);
    expect(mcpShimSrc).toMatch(/envPtyHint:\s*process\.env\.WMUX_PTY_ID\s*\|\|\s*''/);
  });

  it('getTaskSenderPtyId prefers the VERIFIED ptyId, then falls back to the weak env hint', () => {
    // Precedence is the whole point: a verified walk result must win over the
    // spoofable env hint whenever it exists.
    expect(mcpIndexSrc).toMatch(/function\s+getTaskSenderPtyId\s*\(\s*\)\s*:\s*string\s*\{\s*return\s+MY_PTY_ID\s*\|\|\s*ENV_PTY_HINT\s*;?\s*\}/);
  });

  it('MY_PTY_ID is NEVER assigned from the weak env source (verified provenance preserved)', () => {
    // MY_PTY_ID must only ever be set from the walk hit (match.ptyId) or cleared
    // (''). If it were ever set from ENV_PTY_HINT / process.env.WMUX_PTY_ID, the
    // channel path (which trusts MY_PTY_ID) would inherit a spoofable identity.
    expect(mcpIndexSrc).not.toMatch(/MY_PTY_ID\s*=\s*ENV_PTY_HINT/);
    expect(mcpIndexSrc).not.toMatch(/MY_PTY_ID\s*=\s*process\.env/);
    expect(mcpIndexSrc).not.toMatch(/MY_PTY_ID\s*=\s*getTaskSenderPtyId/);
    // Positive: the only value-bearing assignment is the verified walk hit.
    expect(mcpIndexSrc).toMatch(/MY_PTY_ID\s*=\s*match\.ptyId\s*\?\?\s*''/);
  });

  it('a2a.channel.* stays VERIFIED-only — getSenderPtyId returns MY_PTY_ID and NOTHING weak', () => {
    // The channel mutation authz gate (a2a.channel.rpc.ts) resolves this
    // senderPtyId and fails closed without one; it must never see the weak hint.
    expect(mcpIndexSrc).toMatch(/getSenderPtyId:\s*\(\)\s*=>\s*MY_PTY_ID\b/);
    // Lock the WHOLE arrow body, not just its prefix. The earlier `\b`-only
    // assertion (review P2: codex + code-reviewer both caught it) would pass
    // against `getSenderPtyId: () => MY_PTY_ID || ENV_PTY_HINT` — exactly the
    // downgrade this invariant exists to block. Inspect only the body up to the
    // object-literal comma/newline and forbid any weak source there.
    expect(mcpIndexSrc).not.toMatch(/getSenderPtyId:\s*\(\)\s*=>[^\n,]*ENV_PTY_HINT/);
    expect(mcpIndexSrc).not.toMatch(/getSenderPtyId:\s*\(\)\s*=>[^\n,]*process\.env/);
    expect(mcpIndexSrc).not.toMatch(/getSenderPtyId:\s*\(\)\s*=>[^\n,]*getTaskSenderPtyId/);
  });

  it('the A2A task + terminal tools use the weak-allowing getter (>= 5 call sites)', () => {
    // Consumers: terminal_send, terminal_send_key, a2a_whoami,
    // send_message/a2a_task_send (one shared handler), a2a_task_update.
    // The `getTaskSenderPtyId()` token also matches the function declaration
    // `function getTaskSenderPtyId()`, so subtract the declaration count to get
    // the call-site count and require at least the five tool consumers.
    const tokens = (mcpIndexSrc.match(/getTaskSenderPtyId\s*\(\s*\)/g) ?? []).length;
    const decls = (mcpIndexSrc.match(/function\s+getTaskSenderPtyId\s*\(\s*\)/g) ?? []).length;
    expect(tokens - decls).toBeGreaterThanOrEqual(5);
  });

  it('PTYManager local-mode spawn stamps WMUX_PTY_ID so a local-mode pane has the weak anchor', () => {
    // Daemon mode already sets it (DaemonSessionManager); local mode must match
    // or a bundled MCP server in a local-mode pane has no walk-free ptyId source.
    expect(ptyManagerSrc).toMatch(/identity\[ENV_KEYS\.PTY_ID\]\s*=\s*id\s*;/);
  });
});
