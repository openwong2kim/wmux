// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { useStore } from '../../stores';
import { installScrollbackCompactionOnFlag } from '../scrollbackCompactionBootstrap';
import { isLineCompacted, COMPACTION_MARGIN } from '../scrollbackCompaction';

type Lines = { length: number; get(i: number): object };
const lines = (t: Terminal): Lines => (t as unknown as { _core: { buffers: { normal: { lines: Lines } } } })._core.buffers.normal.lines;
const packedCount = (t: Terminal): number => {
  let n = 0;
  for (let i = 0; i < lines(t).length; i++) if (isLineCompacted(lines(t).get(i))) n++;
  return n;
};

async function openAndFill(): Promise<Terminal> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols: 30, rows: 5, scrollback: 2000 });
  term.open(host);
  let data = '';
  for (let i = 0; i < 600; i++) data += `row ${i}\r\n`;
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term;
}

describe('installScrollbackCompactionOnFlag', () => {
  it('installs nothing while the flag is off, then sweeps terminals opened after it turns on', async () => {
    installCanvas2dStub();
    const open = Terminal.prototype.open;
    useStore.setState({ terminalCompactScrollback: false });
    installScrollbackCompactionOnFlag();
    expect(Terminal.prototype.open).toBe(open);
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lines(await openAndFill()).get(0)), '_data')).toBeUndefined();

    useStore.setState({ terminalCompactScrollback: true });
    expect(Terminal.prototype.open).not.toBe(open);
    const term = await openAndFill();
    await vi.waitFor(() => expect(packedCount(term)).toBe(term.buffer.normal.baseY - (term.rows + COMPACTION_MARGIN)), { timeout: 5_000 });
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('row 0');

    // Off again: the sweep stops; reads still work.
    useStore.setState({ terminalCompactScrollback: false });
    term.buffer.normal.getLine(1)?.getCell(0);
    await new Promise<void>((resolve) => term.write('more\r\n', resolve));
    await deliberateSleep(200, 'a negative check: the sweep must not run while the flag is off');
    expect(isLineCompacted(lines(term).get(1))).toBe(false);
    term.dispose();
  });
});
