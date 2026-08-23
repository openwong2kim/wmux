import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `workspace.close` must not hand out a false receipt (issue #799).
 *
 * The handler returned `{ok:true}` unconditionally, but `removeWorkspace` is a
 * silent no-op in two cases: an id that matches nothing, and the store's
 * last-workspace guard (wmux always keeps one workspace open). A scripted
 * cleanup therefore saw `Closed workspace: ws-…` for a workspace that was still
 * open — and the reporter's "confirmed-closed workspace reappeared and is now
 * the only workspace" was never a resurrection: it was the last one, the removal
 * was refused, and only the CLI lied about it.
 *
 * Same false-receipt class `getResultError()` (cli/utils.ts) was introduced for
 * on surface.close — the CLI already exits 1 on a payload-level `{error}`, so
 * returning one is all it takes for `close-workspace` to report honestly.
 *
 * handleRpcMethod is not exported and pulls in the store/window, so it can't be
 * imported under vitest (same constraint as useRpcBridge.browserClose.test.ts /
 * useRpcBridge.focus.test.ts); these are source-structural guards.
 */
describe('useRpcBridge — workspace.close receipt honesty (#799)', () => {
  // Normalize CRLF: a Windows checkout hands this file to us with \r\n, which
  // breaks the \n-anchored handler-isolation regex (same treatment as
  // useTerminal.deferredFit.test.ts).
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8')
    .replace(/\r\n/g, '\n');

  /** Isolate the workspace.close handler so no other close path can match. */
  function closeHandler(): string {
    const m = src.match(
      /if \(method === 'workspace\.close'\)[\s\S]*?\n {2}\}\n/,
    );
    if (!m) {
      throw new Error(
        "workspace.close handler not found in useRpcBridge.ts. " +
          'Update the regex if the handler layout changed.',
      );
    }
    return m[0];
  }

  it('errors on an unknown workspace id instead of acknowledging it', () => {
    const block = closeHandler();
    expect(block).toMatch(/if \(!ws\)\s*\{[\s\S]*?return \{ error:/);
  });

  it('errors when the last workspace cannot be removed', () => {
    const block = closeHandler();
    // The guard that used to only skip the PTY dispose now also refuses the
    // call. Asserting the length check and the error return separately would
    // still pass if a rewrite left the old silent-success fall-through.
    expect(block).toMatch(
      /if \(store\.workspaces\.length <= 1\)\s*\{[\s\S]*?return \{[\s\S]*?error:/,
    );
  });

  it('verifies the removal actually landed before returning ok', () => {
    const block = closeHandler();
    // Post-check against FRESH state. Not a race fix — nothing awaits between
    // the guards and the mutation, so the check cannot fail today. It is an
    // assertion that the handler's guards and removeWorkspace's own agree,
    // which is precisely what drifted apart to produce #799.
    const postCheck = block.match(
      /useStore\.getState\(\)\.workspaces\.some\([\s\S]*?\)\s*\)\s*\{[\s\S]*?return \{ error:/,
    );
    expect(postCheck).not.toBeNull();
    // …and it has to sit AFTER the mutation, or it proves nothing.
    expect(block.indexOf('store.removeWorkspace(id)')).toBeLessThan(
      block.indexOf('useStore.getState().workspaces.some'),
    );
  });

  it('still disposes the workspace PTYs before dropping it', () => {
    const block = closeHandler();
    // #977 — everything the workspace OWNS, not just what is on screen. A
    // stashed pane left running after its workspace is gone is an orphan daemon
    // session nothing can reach. This is the RPC mirror of the sidebar's close
    // button, and a teardown that one of the two paths forgets is precisely the
    // bug class this pin exists to catch.
    expect(block).toMatch(/getWorkspacePtyIds\(ws\)/);
    expect(block).toMatch(/window\.electronAPI\.pty\.dispose\(ptyId\)/);
    expect(block.indexOf('pty.dispose')).toBeLessThan(
      block.indexOf('store.removeWorkspace(id)'),
    );
  });

  it('has exactly one ok receipt, and it comes after the removal check', () => {
    const block = closeHandler();
    expect(block.match(/return \{ ok: true \};/g)).toHaveLength(1);
    // Counting alone would still pass if the single receipt were returned
    // BEFORE the check — which is the old behaviour this test exists to forbid.
    expect(block.indexOf('useStore.getState().workspaces.some')).toBeLessThan(
      block.indexOf('return { ok: true };'),
    );
  });
});
