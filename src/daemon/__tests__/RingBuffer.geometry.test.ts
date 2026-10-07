import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';

describe('RingBuffer geometry log', () => {
  it('has no geometry until a size is recorded', () => {
    const ring = new RingBuffer(64);
    ring.write(Buffer.from('abc'));
    expect(ring.readAllWithGeometry()).toEqual({ data: Buffer.from('abc'), geometry: undefined, writtenAt: 3 });
  });

  it('reports size changes as offsets into the readAll copy', () => {
    const ring = new RingBuffer(64);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('aaaa'));
    ring.noteGeometry(40, 24);
    ring.write(Buffer.from('bb'));
    const { data, geometry } = ring.readAllWithGeometry();
    expect(data.toString()).toBe('aaaabb');
    expect(geometry).toEqual({
      start: { cols: 80, rows: 24 },
      changes: [{ offset: 4, cols: 40, rows: 24 }],
    });
  });

  it('ignores a repeat of the current size and collapses changes with no bytes between', () => {
    const ring = new RingBuffer(64);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('a'));
    ring.noteGeometry(80, 24);
    ring.noteGeometry(60, 24);
    ring.noteGeometry(50, 20);
    ring.write(Buffer.from('b'));
    expect(ring.readAllWithGeometry().geometry).toEqual({
      start: { cols: 80, rows: 24 },
      changes: [{ offset: 1, cols: 50, rows: 20 }],
    });
  });

  it('keeps the size that applies at the window start after the ring wraps', () => {
    const ring = new RingBuffer(8);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('aaaa'));
    ring.noteGeometry(40, 24);
    ring.write(Buffer.from('bbbb'));
    ring.noteGeometry(30, 24);
    ring.write(Buffer.from('cccc')); // window is now 'bbbbcccc'
    const { data, geometry } = ring.readAllWithGeometry();
    expect(data.toString()).toBe('bbbbcccc');
    expect(geometry).toEqual({
      start: { cols: 40, rows: 24 },
      changes: [{ offset: 4, cols: 30, rows: 24 }],
    });
  });

  it('starts from the size in effect when a change lands mid-window after a wrap', () => {
    const ring = new RingBuffer(8);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('aaaaaa'));
    ring.noteGeometry(40, 24);
    ring.write(Buffer.from('bbbb')); // window 'aaaabbbb': 80 applies to its start
    expect(ring.readAllWithGeometry().geometry).toEqual({
      start: { cols: 80, rows: 24 },
      changes: [{ offset: 4, cols: 40, rows: 24 }],
    });
  });
});
