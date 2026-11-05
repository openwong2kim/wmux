import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createPtyDispatcher } from '../useTerminal';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

// The page-wide IPC listener a dispatcher attaches lives as long as the page.
// A closure keeps its whole enclosing scope, so a listener created inside
// register() would keep the first registrant's handler — and the terminal that
// handler closes over — alive after that terminal unsubscribed and was
// disposed (an engine swap left a whole xterm buffer behind this way).
describe('createPtyDispatcher — retention', () => {
  it('does not keep an unsubscribed handler alive through the shared listener', async () => {
    let listener: ((id: string, payload: string) => void) | null = null;
    const d = createPtyDispatcher<string>((cb) => { listener = cb; return () => { listener = null; }; });
    let ref!: WeakRef<object>;
    (() => {
      const terminal = { buffer: new Array(10_000).fill(0) };
      ref = new WeakRef(terminal);
      const off = d.register('pty-1', () => { void terminal.buffer; });
      off();
    })();
    // Another pane keeps the shared listener attached.
    const seen: string[] = [];
    d.register('pty-2', (p) => seen.push(p));
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
    listener!('pty-2', 'still dispatched');
    expect(seen).toEqual(['still dispatched']);
  });
});

// An engine swap carries the old terminal's screen to the new mount (the
// serialized fallback, or a local transplant). The mount's long-lived
// closures (hydrateRegistry, the pty handlers) share the effect scope that
// holds `carry`, so the carry must drop those copies once the swap is set up,
// or every swapped pane keeps its old screen for as long as it lives. The hook
// needs a full renderer bootstrap to swap for real, so the heap itself is
// measured on a packaged build (10 panes, swap, GC, Runtime.getHeapUsage).
describe('useTerminal engine swap — retention', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8');
  it('drops the carried screen copies once the swap is set up', () => {
    const handOff = src.indexOf('swapFinishRef.current = { terminal, fromBottom: swap.fromBottom');
    const release = src.indexOf('if (carry) { carry.fallback = null; carry.transplant = null; }');
    expect(handOff).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(handOff);
  });
});
