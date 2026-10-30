import { describe, it, expect } from 'vitest';
import { EphemeralClipboard } from '../ephemeralClipboard';

const LINK = 'https://desk.ts.net/pair#wmux-desktop-code=QWXZ7K9M';

function rig(read?: () => Promise<string>) {
  let board = '';
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clip = new EphemeralClipboard({
    readText: read ?? (async () => board),
    writeText: async (t) => { board = t; },
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
  });
  return { clip, timers, get board() { return board; }, set board(v: string) { board = v; } };
}

describe('EphemeralClipboard', () => {
  it('clears the link at its expiry, owned outside any component', async () => {
    const r = rig();
    await r.clip.write(LINK, 5_000);
    expect(r.board).toBe(LINK);
    expect(r.timers[0].ms).toBe(5_000);
    r.timers[0].fn();
    // Steps run in turn: a clear asked for after the expiry's settles after it.
    await r.clip.clear();
    expect(r.board).toBe('');
  });

  it('clears on quit (clear()) only while the clipboard still holds exactly that link', async () => {
    const r = rig();
    await r.clip.write(LINK, 5_000);
    r.board = 'something the operator copied';
    await r.clip.clear();
    expect(r.board).toBe('something the operator copied');
  });

  it('clears as soon as the renderer says the link no longer pairs anything', async () => {
    const r = rig();
    await r.clip.write(LINK, 600_000);
    r.clip.keepOnly(LINK);
    expect(r.board).toBe(LINK);
    r.clip.keepOnly('');
    await r.clip.clear();
    expect(r.board).toBe('');
    expect(r.timers[0].cleared).toBe(true);
  });

  it('keeps a bundle while its link line is live, and clears it once that link is not', async () => {
    const r = rig();
    const bundle = `wmux-a2a://desk:45660/K7M2QX9P#AA\n${LINK}`;
    await r.clip.write(bundle, 600_000);
    r.clip.keepOnly(LINK);
    expect(r.board).toBe(bundle);
    r.clip.keepOnly(`${LINK}X`);
    await r.clip.clear();
    expect(r.board).toBe('');
  });

  it('a clear still reading the clipboard never empties a link written after it', async () => {
    let release: (text: string) => void = () => undefined;
    let asked: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => { asked = resolve; });
    const r = rig(() => new Promise<string>((resolve) => { release = resolve; asked(); }));
    await r.clip.write(LINK, 600_000);
    const clearing = r.clip.clear();
    const writing = r.clip.write(`${LINK}2`, 600_000);
    await reading;
    release(LINK);
    await Promise.all([clearing, writing]);
    expect(r.board).toBe(`${LINK}2`);
  });
});
