import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArgsSummary, maskInlineCredentials, wrapHandler } from '../wrapHandler';

/**
 * A pairing code must never reach the main-process error log. The repro: a
 * Copy of the computer link whose clipboard write fails logged the link —
 * fragment code included — as the handler's args_summary.
 */
const CODE = 'QWXZ7K9M';
const LINK = `https://desk.tail1234.ts.net/pair#wmux-desktop-code=${CODE}`;

describe('pairing codes stay out of the IPC error log', () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    lines = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  it('a failing clipboard write logs no arguments at all', async () => {
    const write = wrapHandler('clipboard:write', (_e: unknown, _text: string) => {
      throw new Error('CLIPBOARD_WRITE_FAILED: pasteboard busy');
    });
    await expect(write({} as never, LINK)).rejects.toThrow();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.args_summary).toBeUndefined();
    expect(lines.join('')).not.toContain(CODE);
  });

  it('masks fragment codes, code= and token= in any other channel, and in the stack', async () => {
    const pair = wrapHandler('remote:hosts:pair', (_e: unknown, _a: string) => {
      throw new Error(`fetch failed for https://h.ts.net/api/pair?code=${CODE}`);
    });
    await expect(pair({} as never, `${LINK} extra`)).rejects.toThrow();
    expect(lines.join('')).not.toContain(CODE);
    expect(buildArgsSummary([{ link: LINK }])).not.toContain(CODE);
    expect(buildArgsSummary([`https://h.ts.net/pair?code=${CODE}`])).not.toContain(CODE);
  });

  it('a failing cross-PC join logs no arguments (the invite carries a live code)', async () => {
    const invite = `wmux-a2a://desk:45660/${CODE}#sha256=${'AB:'.repeat(31)}AB`;
    const join = wrapHandler('a2aRemote:join', (_e: unknown, _invite: string) => {
      throw new Error('DaemonClient not connected');
    });
    await expect(join({} as never, invite)).rejects.toThrow();
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.channel).toBe('a2aRemote:join');
    expect(entry.args_summary).toBeUndefined();
    expect(lines.join('')).not.toContain(CODE);
  });

  it('leaves text without credentials alone', () => {
    expect(maskInlineCredentials('https://h.ts.net/pair')).toBe('https://h.ts.net/pair');
    expect(maskInlineCredentials(`x #wmux-desktop-code=${CODE}&y=1`)).toBe('x #wmux-desktop-code=[redacted]&y=1');
  });
});
