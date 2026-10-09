import { describe, it, expect } from 'vitest';
import { EphemeralClipboard } from '../ephemeralClipboard';

const LINK = 'https://desk.ts.net/pair#wmux-desktop-code=QWXZ7K9M';

function rig() {
  let board = '';
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clip = new EphemeralClipboard({
    readText: () => board,
    writeText: (t) => { board = t; },
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
  });
  return { clip, timers, get board() { return board; }, set board(v: string) { board = v; } };
}

describe('EphemeralClipboard', () => {
  it('clears the link at its expiry, owned outside any component', () => {
    const r = rig();
    r.clip.write(LINK, 5_000);
    expect(r.board).toBe(LINK);
    expect(r.timers[0].ms).toBe(5_000);
    r.timers[0].fn();
    expect(r.board).toBe('');
  });

  it('clears on quit (clear()) only while the clipboard still holds exactly that link', () => {
    const r = rig();
    r.clip.write(LINK, 5_000);
    r.board = 'something the operator copied';
    r.clip.clear();
    expect(r.board).toBe('something the operator copied');
  });

  it('clears as soon as the renderer says the link no longer pairs anything', () => {
    const r = rig();
    r.clip.write(LINK, 600_000);
    r.clip.keepOnly(LINK);
    expect(r.board).toBe(LINK);
    r.clip.keepOnly('');
    expect(r.board).toBe('');
    expect(r.timers[0].cleared).toBe(true);
  });

  it('keeps a bundle while its link line is live, and clears it once that link is not', () => {
    const r = rig();
    const bundle = `wmux-a2a://desk:45660/K7M2QX9P#AA\n${LINK}`;
    r.clip.write(bundle, 600_000);
    r.clip.keepOnly(LINK);
    expect(r.board).toBe(bundle);
    r.clip.keepOnly(`${LINK}X`);
    expect(r.board).toBe('');
  });
});
