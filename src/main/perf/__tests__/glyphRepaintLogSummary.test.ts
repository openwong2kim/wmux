import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createGlyphRepaintLogSummary, GLYPH_REPAINT_SUMMARY_MS } from '../glyphRepaintLogSummary';

// The relay's `message` for the renderer's `console.debug('[wmux:glyph-repaint]', reason)`
// (src/renderer/hooks/useTerminal.ts): the arguments joined by a space.
const line = (reason: string) => `[wmux:glyph-repaint] ${reason}`;

/** A summary with a manually fired timer, and the lines it wrote. */
function makeSummary() {
  const written: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const summary = createGlyphRepaintLogSummary((l) => written.push(l), GLYPH_REPAINT_SUMMARY_MS, (fn, ms) => {
    timers.push({ fn, ms });
  });
  const fire = () => timers.shift()?.fn();
  return { summary, written, timers, fire };
}

describe('createGlyphRepaintLogSummary', () => {
  it('counts output repaints instead of logging each, then writes one summary line per interval', () => {
    const { summary, written, timers, fire } = makeSummary();
    for (let i = 0; i < 40; i++) expect(summary.consume(line('burst'))).toBe(true);
    for (let i = 0; i < 3; i++) expect(summary.consume(line('settle-verify'))).toBe(true);
    expect(written).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([GLYPH_REPAINT_SUMMARY_MS]);

    fire();
    expect(written).toEqual(['[wmux:glyph-repaint] summary: 43 in 60 s (burst 40, settle-verify 3)']);
  });

  it('leaves focus and visible repaints, and every other line, to the caller', () => {
    const { summary, timers } = makeSummary();
    expect(summary.consume(line('focus'))).toBe(false);
    expect(summary.consume(line('visible'))).toBe(false);
    expect(summary.consume('[wmux:reveal] ptyId=abc mechanism=dirty-snapshot')).toBe(false);
    expect(summary.consume('burst')).toBe(false);
    expect(timers).toEqual([]);
  });

  it('keeps no timer while nothing streams, and opens a new interval on the next repaint', () => {
    const { summary, written, timers, fire } = makeSummary();
    summary.consume(line('burst'));
    fire();
    expect(timers).toEqual([]);

    summary.consume(line('burst'));
    summary.consume(line('burst'));
    expect(timers).toHaveLength(1);
    fire();
    expect(written).toEqual([
      '[wmux:glyph-repaint] summary: 1 in 60 s (burst 1)',
      '[wmux:glyph-repaint] summary: 2 in 60 s (burst 2)',
    ]);
  });

  it('is asked by the renderer console relay before the line is written (source invariant)', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    const start = indexSrc.indexOf("mainWindow.webContents.on('console-message'");
    const write = indexSrc.indexOf("logLine(lvl, 'renderer'", start);
    expect(start).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(start);
    expect(indexSrc.slice(start, write)).toContain('if (glyphRepaintLog.consume(message)) return;');
  });
});
