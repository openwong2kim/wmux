// #922 PR2 — coverage drift guard.
//
// The first pass at this work surveyed ONE bypass pattern (the renderer's
// `params.workspaceId ?? store.activeWorkspaceId` fallback) and shipped a
// covered set built from that survey. It missed a second, larger pattern
// entirely: `assertWorkspaceOwnsPty` and `resolveTarget` both early-return
// when `workspaceId` is absent, so omitting the field skipped the check rather
// than failing it — `input.send` could write to a foreign terminal and
// `pane.getMetadata` could read a foreign pane's metadata, neither of which
// the first survey looked at.
//
// A test that re-lists the covered set cannot catch that; it only restates the
// author's belief. This one reads the TREE instead, finds every method that
// carries either pattern, and fails when a plugin-reachable one is not covered.
// A new method with a familiar bypass now fails here rather than shipping.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { RpcMethod } from '../../../shared/rpc';
import {
  HOSTED_BOUND_METHODS,
  HOSTED_CONFINED_METHODS,
} from '../hostedWorkspaceBinding';
import { METHOD_CAPABILITY } from '../../mcp/methodCapabilityMap';

const REPO_SRC = path.resolve(__dirname, '../../..');
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO_SRC, rel), 'utf8');

const COVERED = new Set<string>([...HOSTED_BOUND_METHODS, ...HOSTED_CONFINED_METHODS]);

/**
 * A method a plugin can actually call. `wmux.internal` is the reserved prefix
 * no plugin can declare, and a capability resolver means the gate depends on
 * params — none of those are in either pattern today, and one appearing is
 * itself worth a failure here.
 */
function pluginReachable(method: string): boolean {
  const entry = METHOD_CAPABILITY[method as RpcMethod];
  if (!entry) return false;
  if (typeof entry.capability === 'function') return true;
  return entry.capability !== null && entry.capability !== 'wmux.internal';
}

/**
 * Splits the renderer dispatch function into per-method blocks.
 *
 * The scan stops at the end of that function, so helpers defined below it are
 * not attributed to the last method seen — a false positive that made four
 * safe methods look uncovered on the first run of this test.
 */
function rendererBlocks(): Map<string, string> {
  const src = read('renderer/hooks/useRpcBridge.ts');
  const end = src.indexOf('return { error: `unknown method:');
  expect(end, 'dispatch function end marker').toBeGreaterThan(-1);
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of src.slice(0, end).split('\n')) {
    const header = /if \(method === '([a-zA-Z0-9._]+)'\)/.exec(line);
    if (header) {
      current = header[1];
      if (!blocks.has(current)) blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }
  return new Map([...blocks].map(([m, body]) => [m, body.join('\n')]));
}

const NAMES_WORKSPACE = /params(\.workspaceId|\['workspaceId'\])/;

/**
 * Pattern 1 — the renderer fallback: a block that reads a caller-named
 * `workspaceId` out of the body AND falls back to the active workspace, then
 * resolves inside whichever it got, with no owner check.
 *
 * Both halves are required. The fallback token alone also matches methods that
 * only ever act on the active workspace (`meta.setStatus`, `workspace.current`),
 * which are already confined for a hosted caller — its binding IS the active
 * workspace.
 */
function rendererFallbackMethods(): string[] {
  return [...rendererBlocks()]
    .filter(([, text]) => NAMES_WORKSPACE.test(text) && text.includes('store.activeWorkspaceId'))
    .map(([method]) => method);
}

/**
 * Pattern 1b — the same "declared, not verified" shape WITHOUT a fallback: the
 * block requires a caller-named `workspaceId` and then acts inside it. No
 * fallback means the original survey's grep never saw these, and the check
 * that is missing is the same one.
 */
function rendererDeclaredOnlyMethods(): string[] {
  return [...rendererBlocks()]
    .filter(([, text]) => NAMES_WORKSPACE.test(text) && !text.includes('store.activeWorkspaceId'))
    .map(([method]) => method);
}

/**
 * Methods that name a workspace in the body and are deliberately NOT bound,
 * recorded with the reason rather than left to look like an oversight — which
 * is exactly how the `assertWorkspaceOwnsPty` family was missed.
 *
 * The a2a family is the open one. There `workspaceId` is the caller's own
 * identity as a SENDER ("Ensure WMUX_WORKSPACE_ID is set"), not a lookup
 * scope, so binding it would be an impersonation fix rather than a confinement
 * fix — a different argument and a different blast radius than this PR's
 * ruling covers. Tracked on #922; listed here so the next reader sees a
 * decision instead of a gap.
 */
const KNOWN_UNBOUND: Record<string, string> = {
  'a2a.whoami': 'sender identity, not a lookup scope',
  'a2a.task.send': 'sender identity, not a lookup scope',
  'a2a.task.query': 'sender identity, not a lookup scope',
  'a2a.task.update': 'sender identity, not a lookup scope',
  'a2a.task.cancel': 'sender identity, not a lookup scope',
  'a2a.broadcast': 'sender identity, not a lookup scope',
  'fanout.requestApproval': 'main->renderer approval callback, not a router method',
  'pane.validateWorkspace': 'main->renderer channel with no router entry',
};

/**
 * Pattern 2a — the skipped PTY ownership check. Every call site passes the RPC
 * name as its last argument, which is the method the check belongs to.
 */
function ptyOwnershipMethods(): string[] {
  const src = read('main/pipe/handlers/input.rpc.ts');
  const found = new Set<string>();
  const re = /assertWorkspaceOwnsPty\([^)]*'([a-zA-Z0-9._]+)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  return [...found];
}

/**
 * Pattern 2b — the metadata target resolver, which validates a `paneId`
 * against "any workspace" when `workspaceId` is omitted. Attributed to the
 * enclosing `router.register('x.y', ...)`.
 */
function metadataTargetMethods(): string[] {
  const src = read('main/pipe/handlers/pane.rpc.ts');
  const lines = src.split('\n');
  const found = new Set<string>();
  let current: string | null = null;
  for (const line of lines) {
    const header = /router\.register\('([a-zA-Z0-9._]+)'/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current && /\bawait resolveTarget\(/.test(line)) found.add(current);
  }
  return [...found];
}

describe('#922 PR2 — hosted binding coverage does not drift', () => {
  it('finds the renderer-fallback family in the tree, not in a hand-kept list', () => {
    // A positive control: if the scanner silently stops matching, the
    // uncovered-methods assertions below would pass vacuously.
    expect(rendererFallbackMethods()).toEqual(
      expect.arrayContaining(['pane.list', 'pane.split', 'browser.open']),
    );
    expect(ptyOwnershipMethods()).toEqual(
      expect.arrayContaining(['input.send', 'input.sendKey', 'input.readScreen']),
    );
    expect(metadataTargetMethods()).toEqual(
      expect.arrayContaining(['pane.setMetadata', 'pane.getMetadata']),
    );
    expect(rendererDeclaredOnlyMethods()).toEqual(
      expect.arrayContaining(['meta.setSkills']),
    );
  });

  it('covers every plugin-reachable method that resolves a workspace from the body', () => {
    const uncovered = rendererFallbackMethods()
      .filter(pluginReachable)
      .filter((m) => !COVERED.has(m));
    expect(uncovered).toEqual([]);
  });

  it('covers every plugin-reachable method whose PTY ownership check can be skipped', () => {
    // This is the family the first survey missed. `assertWorkspaceOwnsPty`
    // early-returns on an absent workspaceId, so a method carrying it is only
    // safe for a hosted caller once the binding pins that field.
    const uncovered = ptyOwnershipMethods()
      .filter(pluginReachable)
      .filter((m) => !COVERED.has(m));
    expect(uncovered).toEqual([]);
  });

  it('covers every plugin-reachable method whose pane target resolves to any workspace', () => {
    const uncovered = metadataTargetMethods()
      .filter(pluginReachable)
      .filter((m) => !COVERED.has(m));
    expect(uncovered).toEqual([]);
  });

  it('confines every pane-addressed method that carries no workspaceId param', () => {
    // `pane.focus` / `close` / `stash` / `unstash` take a globally-unique
    // paneId the renderer resolves across ALL workspaces. There is no request
    // field to pin, so they must ride the confinement channel instead — and
    // main must actually stamp it, which is what this reads.
    const src = read('main/pipe/handlers/pane.rpc.ts');
    for (const method of HOSTED_CONFINED_METHODS) {
      const start = src.indexOf(`router.register('${method}'`);
      expect(start, method).toBeGreaterThan(-1);
      const next = src.indexOf('router.register(', start + 1);
      const block = src.slice(start, next === -1 ? undefined : next);
      expect(block, method).toContain(`paneConfinement('${method}'`);
      expect(block, method).toContain('confineWorkspaceId');
    }
  });

  it('leaves no body-named workspace unbound without a recorded reason', () => {
    // The half with no fallback. Anything here is either covered or carries an
    // explicit reason — a silent third state is what let the pty family through.
    const unexplained = rendererDeclaredOnlyMethods()
      .filter(pluginReachable)
      .filter((m) => !COVERED.has(m) && KNOWN_UNBOUND[m] === undefined);
    expect(unexplained).toEqual([]);
  });

  it('keeps the two covered sets disjoint — a method takes one mechanism, not both', () => {
    const both = [...HOSTED_BOUND_METHODS].filter((m) => HOSTED_CONFINED_METHODS.has(m));
    expect(both).toEqual([]);
  });
});
