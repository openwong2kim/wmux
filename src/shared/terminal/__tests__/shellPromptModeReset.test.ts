import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { installShellPromptModeReset, PROMPT_MODE_RESET_GUARD_OSC } from '../shellPromptModeReset';

const ESC = '\x1b';
const BEL = '\x07';
const PROMPT = `${ESC}]133;D;0${BEL}${ESC}]133;A${BEL}PS C:\\> ${ESC}]133;B${BEL}`;
const COMMAND = `${ESC}]133;C${BEL}`;
/** What Claude Code arms around its input box on Windows. */
const AGENT_ARMS = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`;
/** ConPTY's own session-start preamble. */
const CONPTY_START = `${ESC}[?9001h${ESC}[?1004h`;

function make() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const writes: string[] = [];
  const realWrite = term.write.bind(term);
  // Record what the guard writes terminal-side (pane output goes through `feed`).
  const guard = installShellPromptModeReset({
    get parser() { return term.parser; },
    get modes() { return term.modes; },
    get buffer() { return term.buffer; },
    write: (data: string) => { writes.push(data); realWrite(data); },
  });
  const feed = (data: string) => new Promise<void>((resolve) => realWrite(data, resolve));
  /** Resolves once everything queued so far (guard writes included) has parsed. */
  const drain = () => new Promise<void>((resolve) => realWrite('', resolve));
  return { term, guard, writes, feed, drain };
}

const armed = (term: Terminal) => ({
  mouse: term.modes.mouseTrackingMode,
  focus: term.modes.sendFocusMode,
  paste: term.modes.bracketedPasteMode,
});

describe('installShellPromptModeReset (#1792)', () => {
  it('resets mouse and focus once an agent that armed them is replaced by the shell prompt', async () => {
    const { term, guard, feed, drain } = make();
    await feed(CONPTY_START + `${ESC}[?2004h` + PROMPT);
    await feed(COMMAND + AGENT_ARMS + 'claude is running');
    expect(armed(term)).toEqual({ mouse: 'any', focus: true, paste: true });
    // Killed: no ?1003l / ?1004l ever arrives, the shell just prints its prompt.
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toEqual({ mouse: 'none', focus: false, paste: true });
    expect(guard.appliedCount).toBe(1);
  });

  it('leaves bracketed paste (?2004) alone', async () => {
    const { term, writes, feed, drain } = make();
    await feed(`${ESC}[?2004h` + PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await drain();
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(writes.join('')).not.toContain('?2004l');
  });

  it('does not fire while the agent is still running', async () => {
    const { term, guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS + 'thinking...\r\n' + 'more output');
    await drain();
    expect(armed(term).mouse).toBe('any');
    expect(writes).toEqual([]);
    expect(guard.appliedCount).toBe(0);
  });

  it('does not fire for an alt-screen TUI (vim) that is still drawing', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h` + '~\r\n~');
    await drain();
    expect(term.buffer.active.type).toBe('alternate');
    expect(armed(term).mouse).toBe('vt200');
    expect(writes).toEqual([]);
  });

  it('does not fire when a dead TUI left the alternate screen active', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1049h${ESC}[?1000h`);
    await feed(PROMPT);
    await drain();
    expect(term.buffer.active.type).toBe('alternate');
    expect(armed(term).mouse).toBe('vt200');
    expect(writes).toEqual([]);
  });

  it('does not touch a TUI that arms the mouse after the prompt with no command mark', async () => {
    // A shell whose integration emits A but never C (no PSReadLine Enter hook).
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + AGENT_ARMS + 'agent running without a C mark');
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'any', focus: true });
    expect(writes).toEqual([]);
    // ...and when it dies, the next prompt does reset.
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('is idempotent: later prompts write nothing more', async () => {
    const { guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await drain();
    await feed(PROMPT);
    await feed(COMMAND + 'dir\r\n' + PROMPT);
    await drain();
    expect(writes).toHaveLength(1);
    expect(guard.appliedCount).toBe(1);
  });

  it('writes nothing when the agent exited cleanly', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS + `${ESC}[?1003l${ESC}[?1006l${ESC}[?1004l`);
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
    expect(writes).toEqual([]);
  });

  it("leaves ConPTY's own session-start ?1004h alone at a plain prompt", async () => {
    const { term, writes, feed, drain } = make();
    await feed(CONPTY_START + PROMPT);
    await feed(COMMAND + 'Directory listing\r\n' + PROMPT);
    await drain();
    expect(term.modes.sendFocusMode).toBe(true);
    expect(writes).toEqual([]);
  });

  it('counts a mouse mode armed before any prompt mark (a pane attached mid-agent)', async () => {
    const { term, feed, drain } = make();
    await feed(CONPTY_START + AGENT_ARMS + 'agent output from the replay');
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('re-validates where the reset lands: a TUI launched behind the prompt keeps its mouse', async () => {
    const { term, guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    // One backlog chunk: the dead agent's prompt, then a new agent started
    // before xterm reached the reset queued at that prompt.
    await feed(PROMPT + 'claude\r\n' + COMMAND + `${ESC}[?1003h${ESC}[?1006h`);
    await drain();
    expect(writes).toHaveLength(1);
    expect(guard.appliedCount).toBe(0);
    expect(armed(term).mouse).toBe('any');
  });

  it('applies the reset for the latest prompt when several are queued', async () => {
    const { term, feed, drain } = make();
    const term1 = PROMPT + COMMAND + AGENT_ARMS;
    // dead agent → prompt → new agent → dead again → prompt, all in one parse.
    await feed(term1 + PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('ignores a guard marker with the wrong nonce (pane output cannot veto anything)', async () => {
    const { term, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1000h`);
    await feed(`${ESC}]${PROMPT_MODE_RESET_GUARD_OSC};bogus;begin${BEL}${ESC}[?1000l`);
    await drain();
    expect(armed(term).mouse).toBe('none');
  });

  it('installs once per terminal', () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const a = installShellPromptModeReset(term);
    const b = installShellPromptModeReset(term);
    expect(a).toBe(b);
    a.dispose();
    expect(installShellPromptModeReset(term)).not.toBe(a);
  });
});
