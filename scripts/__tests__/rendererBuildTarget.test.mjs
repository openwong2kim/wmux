import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

/**
 * Regression guard for the renderer's esbuild target.
 *
 * Below es2021 esbuild lowers logical assignment (`a ||= b`) to `a || (a = b)`,
 * and when it has proved the binding dead it drops the `let a;` declaration
 * while KEEPING the write — producing `void 0 || (x = {})` against an
 * undeclared name, which throws under ESM strict mode.
 *
 * That miscompiled @xterm/xterm 6's DECRQM handler (`InputHandler.requestMode`,
 * `CSI ? Ps $ p`). The throw escaped xterm's WriteBuffer drain loop, so the
 * first TUI to probe terminal modes (opencode does, on startup) permanently
 * wedged that pane's write buffer: the pane froze and every MCP read of it
 * (input.readScreen / pane.search) timed out.
 *
 * The shape below is xterm's source verbatim in structure — a `let` with no
 * initializer, fed to a TS-enum IIFE via `||=`, then never read again.
 */
const XTERM_REQUEST_MODE_SHAPE = `
export function requestMode(params, ansi) {
  let DecRqmTypes;
  ((v) => (v[v.NOT_RECOGNIZED = 0] = 'NOT_RECOGNIZED', v[v.SET = 1] = 'SET'))(DecRqmTypes ||= {});
  const modes = { origin: true };
  const reply = (m, s) => String(m) + ';' + String(s);
  return ansi ? reply(params, 0) : reply(params, modes.origin ? 1 : 2);
}
`;

function rendererTarget() {
  const src = readFileSync(new URL('../../vite.renderer.config.ts', import.meta.url), 'utf8');
  const match = /^\s*target:\s*'([^']+)'/m.exec(src);
  return match?.[1];
}

describe('renderer build target', () => {
  it('is pinned in vite.renderer.config.ts', () => {
    expect(rendererTarget()).toBeTruthy();
  });

  it('does not lower logical assignment (the es2020 miscompile)', () => {
    const { code } = transformSync(XTERM_REQUEST_MODE_SHAPE, {
      loader: 'js',
      format: 'esm',
      minify: true,
      target: rendererTarget(),
    });
    // The lowered form is what strands an undeclared binding.
    expect(code).not.toMatch(/void 0\s*\|\|\s*\(/);
    expect(code).toMatch(/\|\|=/);
  });

  it('produces a requestMode that actually runs instead of throwing ReferenceError', async () => {
    const { code } = transformSync(XTERM_REQUEST_MODE_SHAPE, {
      loader: 'js',
      format: 'esm',
      minify: true,
      target: rendererTarget(),
    });
    // Strict mode (module scope) is what turns the stray write into a throw,
    // so evaluate the same way the renderer does.
    const mod = await import(
      `data:text/javascript,${encodeURIComponent(code)}`
    );
    expect(() => mod.requestMode(6, false)).not.toThrow();
  });

  it('the es2020 default this guards against really does miscompile', () => {
    const { code } = transformSync(XTERM_REQUEST_MODE_SHAPE, {
      loader: 'js',
      format: 'esm',
      minify: true,
      target: 'es2020',
    });
    expect(code).toMatch(/void 0\s*\|\|\s*\(/);
  });
});
