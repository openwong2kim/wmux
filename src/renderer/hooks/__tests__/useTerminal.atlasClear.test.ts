import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #191 regression lock (source-level).
//
// The focus/visible glyph repaint must NEVER clearTextureAtlas. xterm shares
// one glyph texture atlas across every same-config terminal (CharAtlasCache),
// so clearing it from one pane empties it for all of them — the non-focused
// siblings then sample an emptied/repositioned atlas and render garbled or
// blank glyphs. The repaint repairs only the dirty-region desync, via a
// full-range refresh, which does not touch the shared atlas.
//
// This is the kind of "must not reintroduce X" invariant a future contributor
// chasing a glyph artifact would naturally break by reaching for
// clearTextureAtlas. The repaint is an xterm-bound side effect that can't be
// asserted without a real WebGL context, so the invariant is pinned at the
// source level (matching the Fix D / A6 regression-lock tests in
// src/renderer/hooks/__tests__).
describe('#191 — repaint must not clear the shared texture atlas (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  // Slice the glyphRepaint scheduler's repaint callback: from the
  // createGlyphRepaintScheduler call to where the scheduler ref is assigned.
  const start = src.indexOf('const glyphRepaint = createGlyphRepaintScheduler({');
  const end = src.indexOf('glyphRepaintRef.current = glyphRepaint;', start);
  const repaintBlock = src.slice(start, end);

  it('locates the repaint scheduler block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('does not call clearTextureAtlas in the repaint path', () => {
    expect(repaintBlock).not.toMatch(/clearTextureAtlas\(/);
  });

  it('repairs staleness with a full-range refresh instead', () => {
    expect(repaintBlock).toMatch(/terminal\.refresh\(0, terminal\.rows - 1\)/);
  });
});
