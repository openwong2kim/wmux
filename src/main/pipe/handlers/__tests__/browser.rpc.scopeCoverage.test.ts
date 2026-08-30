// #810 — structural invariant: no target-resolving browser handler may pick a
// workspace on its own.
//
// The hole this guards is how #810 happened in the first place. Scoping was
// added handler by handler, so "is this call scoped?" was answered by whoever
// wrote the handler, and a later one that forgot simply kept the old
// workspace-blind lookup. Nothing failed; the gap was invisible until someone
// re-read the file.
//
// A behavioral test cannot catch that: it can only assert about handlers it
// already knows to check, which is exactly the set that is not the problem.
// So this reads the source instead and asserts the shape:
//
//   registerBrowserRpc
//     │
//     ├─ registerLeased('browser.X', (params, scope) => …)
//     │     └─ scopeFor() runs in the wrapper, once, before any lookup
//     │
//     └─ router.register('browser.Y', (params, ctx) => …)
//           └─ must call scopeFor() itself if it resolves a target
//
// Precedent for source-scan invariants in this repo: remoteInboxNoPaste.test.ts.

import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = path.join(__dirname, '..', 'browser.rpc.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

/**
 * Calls that pick or wake a browser surface. Any handler using one of these is
 * making a workspace decision, whether or not it looks like it.
 */
const TARGET_RESOLVERS = [
  'getTarget(',
  'ensureAwake(',
  'waitForTarget(',
  'resolveWc(',
  'resolveTargetSurface(',
];

interface HandlerBlock {
  kind: 'leased' | 'plain';
  method: string;
  body: string;
}

/** Split the file into per-handler blocks, in registration order. */
function handlerBlocks(): HandlerBlock[] {
  const pattern = /(registerLeased|router\.register)\('(browser\.[A-Za-z.]+)'/g;
  const starts: { kind: 'leased' | 'plain'; method: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    starts.push({
      kind: match[1] === 'registerLeased' ? 'leased' : 'plain',
      method: match[2],
      index: match.index,
    });
  }
  return starts.map((start, i) => ({
    kind: start.kind,
    method: start.method,
    // Up to the next registration, or end of file for the last one. Coarse but
    // sufficient: the trailing slice only ever adds non-handler code, which
    // cannot make a failing block pass.
    body: source.slice(start.index, starts[i + 1]?.index ?? source.length),
  }));
}

describe('browser RPC workspace-scope coverage (#810)', () => {
  const blocks = handlerBlocks();

  it('finds the handlers (guards against the scan silently matching nothing)', () => {
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.some((b) => b.method === 'browser.evaluate')).toBe(true);
  });

  it('every leased handler takes the resolved scope instead of deriving one', () => {
    const offenders = blocks
      .filter((b) => b.kind === 'leased')
      .filter((b) => !/registerLeased\('browser\.[A-Za-z.]+',\s*async \(params, scope\b/.test(b.body))
      .map((b) => b.method);

    // Failure means a leased handler was added with the old `(params)` shape.
    // Give it the `scope` argument the wrapper already computed — do NOT read
    // `params['workspaceId']` inside the handler.
    expect(offenders).toEqual([]);
  });

  it('every non-leased handler that resolves a target computes the scope first', () => {
    const offenders = blocks
      .filter((b) => b.kind === 'plain')
      .filter((b) => TARGET_RESOLVERS.some((call) => b.body.includes(call)))
      .filter((b) => !b.body.includes('scopeFor('))
      .map((b) => b.method);

    // Failure means a handler resolves a browser surface without deciding which
    // workspace may see it — the #810 defect. Call
    // `scopeFor('<method>', params, ctx)` before the lookup and pass its result.
    expect(offenders).toEqual([]);
  });

  it('only the documented handlers read workspaceId out of the request body', () => {
    // Reading `params['workspaceId']` IS the opt-out #810 is about, so the set
    // of handlers that still do it is an explicit, reviewed list rather than a
    // habit. Adding to it should require changing this test.
    //
    // The list is EMPTY as of #922 PR-C: no browser handler resolves a
    // workspace out of the request body any more. `browser.open`'s 'external'
    // branch is still unscoped — the OS browser owns no workspace — but it
    // returns before a workspace is needed, so it reads nothing rather than
    // reading a value it discards.
    //
    // `browser.close` and `browser.tabs` LEFT this list in #922 PR-C: all of
    // their branches now resolve through `scopeFor`, so none of them reads the
    // request field. The entries used to say they were "surface LIFECYCLE, not
    // target resolution" and had to wait for traffic evidence before flipping —
    // the evidence question was answered differently in the end. The `verified`
    // lane gave an omitted workspaceId an answer, so folding them in stopped
    // being a new refusal for approved callers and became the removal of an
    // exception.
    //
    // One thing folding `browser.tabs` did NOT close, recorded so the next
    // reader does not assume it did: it is `wmux.internal`, which no plugin can
    // declare, but the enforcer allows an envelope-less caller before it checks
    // the capability. Ruling (c) leaves the legacy lane accepting the workspace
    // such a caller names, so that one caller class is unchanged here. It
    // closes with the grandfather, on #1111.
    const ALLOWED: string[] = [];

    const readers = blocks
      .filter((b) => /params\[['"]workspaceId['"]\]/.test(b.body))
      .map((b) => b.method);

    expect(readers.sort()).toEqual([...ALLOWED].sort());
  });
});
