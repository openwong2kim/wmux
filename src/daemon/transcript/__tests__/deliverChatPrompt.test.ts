import { describe, expect, it, vi } from 'vitest';
import { claudeComposerEmpty, claudeComposerRows, claudeComposerShows, claudeComposerVisible, codexComposerEmpty, codexComposerVisible, deliverChatPrompt, type ChatDeliveryDeps } from '../deliverChatPrompt';
import type { ScheduledPromptAgentState } from '../../sessionPromptDelivery';
import { generateTextSnapshot } from '../../HeadlessSnapshot';

function fixture() {
  let approval = false;
  let transcript = 'conversation-1';
  let screen: string[] | null = ['● done', '', '❯ ', '  ? for shortcuts'];
  const state: ScheduledPromptAgentState = { slug: 'claude', incarnationId: 'process-1', status: 'complete', inputQuiet: true, inputRevision: 0 };
  const write = vi.fn(() => { state.inputRevision++; return true; });
  const deps: ChatDeliveryDeps = { getAgentState: () => ({ ...state }), getTranscriptSessionId: () => transcript,
    hasOpenApproval: () => approval, readScreen: async () => screen, isAgentProcessAlive: async () => true, write, delay: async () => undefined };
  return { deps, state, write, show: (rows: string[] | null) => { screen = rows; }, gate: () => { approval = true; }, replace: () => { transcript = 'conversation-2'; } };
}
describe('identity-bound chat delivery', () => {
  it('never appends a new task to a potentially restored interrupted draft', async () => {
    const f = fixture(); f.state.status = 'idle';
    expect(await deliverChatPrompt('conversation-1', 'next task', f.deps)).toBe('unconfirmed');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('sends a multiline prompt to the same Claude process using bracketed paste', async () => {
    const f = fixture();
    expect(await deliverChatPrompt('conversation-1', 'first\nsecond', f.deps)).toBe('sent');
    expect(f.write.mock.calls).toHaveLength(2);
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~first\nsecond\x1b[201~');
    expect(f.write).toHaveBeenNthCalledWith(2, '\r\r');
  });
  it('refuses permission prompts, other agents, old conversations, busy input and oversized drafts', async () => {
    const f = fixture(); f.gate();
    expect(await deliverChatPrompt('conversation-1', 'yes', f.deps)).toBe('blocked');
    const other = fixture(); other.state.slug = 'grok';
    expect(await deliverChatPrompt('conversation-1', 'hello', other.deps)).toBe('unavailable');
    const stale = fixture(); stale.replace();
    expect(await deliverChatPrompt('conversation-1', 'hello', stale.deps)).toBe('session_changed');
    const busy = fixture(); busy.state.status = 'running';
    expect(await deliverChatPrompt('conversation-1', 'hello', busy.deps)).toBe('busy');
    const huge = fixture();
    expect(await deliverChatPrompt('conversation-1', 'x'.repeat(16001), huge.deps)).toBe('error');
    for (const x of [f, other, stale, busy, huge]) expect(x.write).not.toHaveBeenCalled();
  });
  it('cannot escape bracketed paste through message text', async () => {
    const f = fixture();
    expect(await deliverChatPrompt('conversation-1', 'text\x1b[201~command', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~text␛[201~command\x1b[201~');
  });
  it.each(['gate', 'conversation', 'process', 'typing'] as const)('never submits if %s changes after paste', async (change) => {
    const f = fixture();
    f.deps.delay = async () => {
      if (change === 'gate') f.gate();
      if (change === 'conversation') f.replace();
      if (change === 'process') f.state.incarnationId = 'process-2';
      if (change === 'typing') f.state.inputRevision++;
    };
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('error');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  // Screens captured live (dogfood 2026-09-22): Claude opened these on its own
  // while the pane read `complete`, and Enter confirmed the highlighted row.
  it.each([
    ['post-turn wizard', ['Teach auto mode about your environment?', '', '❯ 1. Yes', '  2. Not now', "  3. Don't show again", '', 'Enter to confirm · Esc to cancel', '❯ ']],
    ['wizard step without numbered rows', ['❯ Also scan shell history    [✓]', '  Also scan your other repos [ ]', '  Continue', '←/→ to change usage · Enter to continue · Esc to cancel']],
    ['/model select', ['Select model', '  1. Default (recommended)', '❯ 2. Opus (1M context) ✓', 'Enter to set as default · s to use this session only · Esc to cancel']],
    ['unreadable screen', null],
    ['blank screen', ['', '   ']],
  ] as const)('refuses while the composer does not own the keyboard: %s', async (_name, rows) => {
    const f = fixture(); f.show(rows ? [...rows] : null);
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('blocked');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('treats a screen read failure as no evidence of a free composer', async () => {
    const f = fixture(); f.deps.readScreen = async () => { throw new Error('parse budget'); };
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('blocked');
    expect(f.write).not.toHaveBeenCalled();
  });
});

// Claude Code 2.1.282 screens captured with a PTY probe (2026-09-25).
const RULE = '─'.repeat(40);
const emptyComposer = (above: string[]) => [...above, RULE, '❯ ', RULE, '  ⏸ manual mode on'];
describe('chat delivery into Claude mid-turn and after Stop', () => {
  it('queues a prompt mid-turn only while the composer is visibly empty', async () => {
    const f = fixture(); f.state.status = 'running';
    f.show(emptyComposer(['✢ Effecting… (9s · thinking)']));
    expect(await deliverChatPrompt('conversation-1', 'then say BANANA', f.deps)).toBe('sent');
    expect(f.write.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['\x1b[200~then say BANANA\x1b[201~', '\r']);
    const draft = fixture(); draft.state.status = 'running';
    draft.show([RULE, '❯ half-typed in Terminal', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'then say BANANA', draft.deps)).toBe('busy');
    expect(draft.write).not.toHaveBeenCalled();
  });
  it('sends after a late ESC left the composer empty, but not over a restored draft', async () => {
    const f = fixture(); f.state.status = 'idle';
    f.show(emptyComposer(['  ⎿  Interrupted · What should Claude do instead?']));
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('sent');
    const fresh = fixture(); fresh.state.status = 'idle';
    fresh.show([RULE, '❯ Try "refactor constants.ts"', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'next', fresh.deps)).toBe('sent');
    const restored = fixture(); restored.state.status = 'idle';
    restored.show([RULE, '❯ Write a 900-word essay about the history of tunnels.', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'next', restored.deps)).toBe('unconfirmed');
    expect(restored.write).not.toHaveBeenCalled();
  });
  it('pastes each image path on its own before the prompt, then submits once', async () => {
    const leftover = fixture();
    leftover.show([RULE, '❯ [Image #1] What is this?', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'What is this?', leftover.deps, ['/tmp/a.png'])).toBe('unconfirmed');
    expect(leftover.write).not.toHaveBeenCalled();
    const f = fixture();
    f.show(emptyComposer(['● done']));
    expect(await deliverChatPrompt('conversation-1', 'What is this?', f.deps, ['/tmp/a.png', '/tmp/my shot.png'])).toBe('sent');
    expect(f.write.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      '\x1b[200~/tmp/a.png\x1b[201~', "\x1b[200~'/tmp/my shot.png'\x1b[201~", '\x1b[200~ What is this?\x1b[201~', '\r']);
  });
  it('refuses image paths for Codex and never submits if typing lands between pastes', async () => {
    const codex = fixture(); codex.state.slug = 'codex';
    codex.show(['› Ask Codex to do anything', '  gpt-5 · ~/project']);
    expect(await deliverChatPrompt('conversation-1', 'look', codex.deps, ['/tmp/a.png'])).toBe('unavailable');
    expect(codex.write).not.toHaveBeenCalled();
    const f = fixture();
    f.show(emptyComposer(['● done']));
    let delays = 0;
    f.deps.delay = async () => { if (delays++ === 0) f.state.inputRevision++; };
    expect(await deliverChatPrompt('conversation-1', 'look', f.deps, ['/tmp/a.png', '/tmp/b.png'])).toBe('error');
    // Typing after the first path stops the second paste, not only Enter.
    expect(f.write).toHaveBeenCalledTimes(1);
  });
});

describe('Claude\'s dimmed next-prompt suggestion', () => {
  const RULE80 = '─'.repeat(80);
  // Captured shape of Claude Code 2.1.282 after a turn: the suggestion is SGR 2
  // (dim) inside the prompt row; typed text is drawn without it.
  const screenBytes = (prompt: string) => Buffer.from(
    `● two\r\n\r\n${RULE80}\r\n❯ ${prompt}\x1b[0m\r\n${RULE80}\r\n  ⏵⏵ auto mode on (shift+tab to cycle)`);
  const render = async (bytes: Buffer) => {
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, scrollback: 0, initial: bytes, undimmed: true });
    if (!outcome.ok) throw new Error('snapshot failed');
    return Object.assign(outcome.rows.map((r) => r.text), { undimmed: outcome.rows.map((r) => r.undimmed ?? r.text) });
  };
  it('reads as an empty composer, while the same words typed do not', async () => {
    const suggested = await render(screenBytes('\x1b[2mReply with exactly the word: three\x1b[22m'));
    expect(suggested.some((row) => row.includes('Reply with exactly the word: three'))).toBe(true);
    expect(claudeComposerEmpty(suggested)).toBe(true);
    const typed = await render(screenBytes('Reply with exactly the word: three'));
    expect(claudeComposerEmpty(typed)).toBe(false);
    // Without the undimmed copy the suggestion still reads as a draft: fail closed.
    expect(claudeComposerEmpty([...suggested])).toBe(false);
  });
  it('lets an idle Claude with only a suggestion take the send', async () => {
    const f = fixture(); f.state.status = 'idle';
    const rows = await render(screenBytes('\x1b[2mReply with exactly the word: three\x1b[22m'));
    f.deps.readScreen = async () => rows;
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('sent');
    const draft = fixture(); draft.state.status = 'idle';
    const typedRows = await render(screenBytes('half-typed in Terminal'));
    draft.deps.readScreen = async () => typedRows;
    expect(await deliverChatPrompt('conversation-1', 'next', draft.deps)).toBe('unconfirmed');
    expect(draft.write).not.toHaveBeenCalled();
  });
});

describe('a named Claude session (the name drawn into the composer\'s top rule)', () => {
  // The bottom of a live pane (2026-10-11, Claude Code 2.1, fullscreen
  // renderer, 86 columns): the session name sits in the top rule, the prompt
  // row holds only the dimmed suggestion (`❯` NBSP, SGR 2 … SGR 22), and the
  // bottom rule is plain. Account details in the footer are replaced.
  const bytes = Buffer.from([
    '\x1b[?1049h\x1b[H',
    `${'─'.repeat(55)} workspace-identity-card-plan ─\r\n`,
    '❯\u00a0\x1b[2m현상황 보고해라\x1b[22m\r\n',
    `${'─'.repeat(86)}\r\n`,
    '  Opus 5.5 (high) · ctx 23%\r\n',
    '  ⏵⏵ bypass permissions on · 2 shells · ← 2 agents',
  ].join(''));
  const render = async (data: Buffer) => {
    const outcome = await generateTextSnapshot({ cols: 86, rows: 12, scrollback: 0, initial: data, undimmed: true });
    if (!outcome.ok) throw new Error('snapshot failed');
    return Object.assign(outcome.rows.map((r) => r.text), { undimmed: outcome.rows.map((r) => r.undimmed ?? r.text) });
  };
  it('still reads as the composer, empty under its suggestion', async () => {
    const rows = await render(bytes);
    expect(claudeComposerVisible(rows)).toBe(true);
    expect(claudeComposerEmpty(rows)).toBe(true);
    expect(claudeComposerRows(rows)).toEqual({ rows: [], width: 86 });
  });
  it('takes a queued (idle-only) send instead of holding it as a screen without a composer', async () => {
    const f = fixture(); f.state.status = 'idle';
    const rows = await render(bytes);
    f.deps.readScreen = async () => rows;
    const holds: string[] = [];
    expect(await deliverChatPrompt('conversation-1', 'how many lines?', { ...f.deps, idleOnly: true, onScreenHold: (why) => holds.push(why) })).toBe('sent');
    expect(holds).toEqual([]);
  });
  it('accepts a label only as Claude draws it: between dash runs, from column 0, as wide as the rule under the prompt', () => {
    const RULE = '─'.repeat(40);
    const labeled = `${'─'.repeat(27)} my-session ─`;
    expect(labeled.length).toBe(40);
    expect(claudeComposerVisible([labeled, '❯ ', RULE])).toBe(true);
    for (const top of [`${'─'.repeat(27)} my-session`, `notes ${'─'.repeat(34)}`, `${'─'.repeat(38)}x─`, `${'─'.repeat(4)} short ─`,
      `${'─'.repeat(20)} my-session ─`, `  ${'─'.repeat(25)} my-session ─`]) {
      expect(claudeComposerVisible([top, '❯ ', RULE])).toBe(false);
    }
    // A rule-like block typed into a draft (indented continuation rows) is not the composer.
    const draft = [RULE, '❯ look at this:', `  ${'─'.repeat(25)} Example ─`, '  ❯', `  ${RULE.slice(2)}`, RULE];
    expect(claudeComposerEmpty(draft)).toBe(false);
    expect(claudeComposerRows(draft)).toBeNull();
    // The bottom rule stays plain.
    expect(claudeComposerVisible([RULE, '❯ ', `${'─'.repeat(20)} my-session ─`])).toBe(false);
  });
  it('says which screen hold it was: a dialog, or no composer at all', async () => {
    const holds: string[] = [];
    const dialog = fixture(); dialog.show(['Select model', '❯ 1. Sonnet', 'Esc to cancel']);
    expect(await deliverChatPrompt('conversation-1', 'x', { ...dialog.deps, onScreenHold: (why) => holds.push(why) })).toBe('blocked');
    const usage = fixture(); usage.show(['  Total cost: $0.12', '  Press any key to continue']);
    expect(await deliverChatPrompt('conversation-1', 'x', { ...usage.deps, idleOnly: true, onScreenHold: (why) => holds.push(why) })).toBe('blocked');
    expect(holds).toEqual(['dialog', 'no-composer']);
  });
});

describe('Claude composer rows and the exact match', () => {
  const RULE = '─'.repeat(40);
  const shows = (rows: string[], text: string, prefix = false) => {
    const shown = claudeComposerRows(rows);
    return !!shown && claudeComposerShows(shown, text, prefix);
  };
  it('reads rows, empty as none, and refuses anything that is not the composer', () => {
    expect(claudeComposerRows(['● done', RULE, '❯ fix the login', '  bug now', RULE, '  ⏸ manual mode on'])).toEqual({ rows: ['fix the login', 'bug now'], width: 40 });
    expect(claudeComposerRows([RULE, '❯ ', RULE])).toEqual({ rows: [], width: 40 });
    expect(claudeComposerRows([RULE, '❯ Try "how does <filepath> work?"', RULE])).toEqual({ rows: [], width: 40 });
    expect(claudeComposerRows([RULE, '❯ draft', 'not indented', RULE])).toBeNull();
    expect(claudeComposerRows([RULE, '❯ draft'])).toBeNull();
    expect(claudeComposerRows([RULE, '❯ draft', RULE, 'Esc to cancel'])).toBeNull();
    expect(claudeComposerRows(null)).toBeNull();
  });
  it('counts spaces and line breaks; only a soft wrap the next word forced is undone', () => {
    expect(shows([RULE, '❯ a b', RULE], 'a b')).toBe(true);
    // The live prompt row: `❯` and a no-break space.
    expect(shows([RULE, '❯\u00a0reply with hello world', RULE], 'reply with hello world')).toBe(true);
    expect(shows([RULE, '❯ a b', RULE], 'ab')).toBe(false);
    expect(shows([RULE, '❯ ab', RULE], 'a b')).toBe(false);
    expect(shows([RULE, '❯ one', '  two', RULE], 'one\ntwo')).toBe(true);
    // Two short rows are a line break the user typed, not a wrap.
    expect(shows([RULE, '❯ one', '  two', RULE], 'one two')).toBe(false);
    // 36 chars + prefix leave no room for the next word: a wrap at the dropped space.
    const long = 'x'.repeat(30) + ' yyyyy';
    expect(shows([RULE, `❯ ${long}`, '  zzzz', RULE], `${long} zzzz`)).toBe(true);
    expect(shows([RULE, `❯ ${long}`, '  zzzz', RULE], `${long}zzzz`)).toBe(true);
    expect(shows([RULE, '❯ one two', RULE], 'one two three')).toBe(false);
    expect(shows([RULE, '❯ one two', RULE], 'one two three', true)).toBe(true);
    expect(shows([RULE, '❯ one tw', RULE], 'one two', true)).toBe(true);
  });
});

describe('Codex 0.157 composer', () => {
  // Captured shape: a dim placeholder, the model/cwd/thread footer, then a
  // `? for shortcuts` hint row that 0.156 did not draw.
  const screenBytes = (prompt: string) => Buffer.from(
    `• pong\r\n\r\n› ${prompt}\x1b[0m\r\n\r\n  gpt-5 medium · ~/project · Reply with pong\r\n  ? for shortcuts`);
  const render = async (bytes: Buffer) => {
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, scrollback: 0, initial: bytes, undimmed: true });
    if (!outcome.ok) throw new Error('snapshot failed');
    return Object.assign(outcome.rows.map((r) => r.text), { undimmed: outcome.rows.map((r) => r.undimmed ?? r.text) });
  };
  it('is empty with its dim placeholder or a dim suggestion, not with typed text', async () => {
    expect(codexComposerEmpty(await render(screenBytes('\x1b[2mAsk Codex to do anything\x1b[22m')))).toBe(true);
    expect(codexComposerEmpty(await render(screenBytes('\x1b[2mExplain this codebase\x1b[22m')))).toBe(true);
    expect(codexComposerEmpty(await render(screenBytes('half-typed in Terminal')))).toBe(false);
  });
  it('still refuses an unknown extra row under the footer', async () => {
    const rows = await render(Buffer.from(`› \x1b[2mAsk Codex to do anything\x1b[22m\r\n\r\n  gpt-5 medium · ~/project\r\n  Press enter to confirm`));
    expect(codexComposerEmpty(rows)).toBe(false);
  });
});

describe('Codex 0.158 composer', () => {
  // 0.158 draws `← for agents · ? for shortcuts` under the footer, and a
  // weekly-limit warning adds a right-aligned `⚠ 1 warning · f2 to view`.
  const render = async (bytes: string, cols = 80) => {
    const outcome = await generateTextSnapshot({ cols, rows: 24, scrollback: 0, initial: Buffer.from(bytes), undimmed: true });
    if (!outcome.ok) throw new Error('snapshot failed');
    return Object.assign(outcome.rows.map((r) => r.text), { undimmed: outcome.rows.map((r) => r.undimmed ?? r.text) });
  };
  const screen = (prompt: string, hint: string) =>
    `• pong\r\n\r\n› ${prompt}\x1b[0m\r\n\r\n  GPT-5.6-Sol low · D:\\work · Reply with pong\r\n  ${hint}`;
  const placeholder = '\x1b[2mAsk Codex to do anything\x1b[22m';

  it('is empty under the 0.158 hint row, with or without the warning badge', async () => {
    expect(codexComposerEmpty(await render(screen(placeholder, '← for agents · ? for shortcuts')))).toBe(true);
    expect(codexComposerEmpty(await render(screen(placeholder, `← for agents · ? for shortcuts${' '.repeat(20)}⚠ 1 warning · f2 to view`)))).toBe(true);
    // A narrow pane cuts the hint to make room for the badge.
    expect(codexComposerEmpty(await render(screen(placeholder, '← for agents · ? for shortcut  ⚠ 1 warning · f2 to view'), 60))).toBe(true);
    expect(codexComposerEmpty(await render(screen('\x1b[2mExplain this codebase\x1b[22m', '← for agents · ? for shortcuts')))).toBe(true);
  });

  it('matches the rows captured from a live 0.158 pane on Windows', () => {
    // From the daemon text render of native Windows codex-cli 0.158.0 panes.
    const top = ['  12:56 AM', '                     ⚠ weekly limit: 19% left', '', '› Ask Codex to do anything', ''];
    expect(codexComposerEmpty([...top, '  GPT-5.6-Sol low · ~\\AppData\\Local\\Temp\\cx80work · Call …', '  ← for agents · ? for shortcuts'])).toBe(true);
    expect(codexComposerEmpty([...top, '  GPT-5.6-Sol low · D:\\wmux-work\\wv1780b\\work · Run wmux …',
      '  ← for agents · ? for shortcut  ⚠ 1 warning · f2 to view'])).toBe(true);
    expect(codexComposerEmpty([...top, '  GPT-5.6-Sol low · D:\\wmux-work\\wv1780b\\work · Run wmux channel check',
      `  ← for agents · ? for shortcuts${' '.repeat(61)}⚠ 1 warning · f2 to view`])).toBe(true);
  });

  it('still refuses typed text and any other row under the footer', async () => {
    expect(codexComposerEmpty(await render(screen('half-typed', '← for agents · ? for shortcuts')))).toBe(false);
    expect(codexComposerEmpty(await render(screen(placeholder, '← for agents · Press enter to confirm')))).toBe(false);
    expect(codexComposerEmpty(await render(screen(placeholder, '← for agents · ? for shortcuts  Press enter to confirm')))).toBe(false);
  });
});

describe('Codex 0.163 composer', () => {
  // A long-running `codex --no-daemon` session on codex-cli 0.163.0 (80x54,
  // 2026-10-19) left its model/cwd footer row blank: the composer, an empty
  // row, the blank footer row, then the hint, which `--no-daemon` draws
  // without `← for agents`. Layout from the pane's own bytes; text replaced.
  const render = async (prompt: string, cols = 80) => {
    const bytes = `• done\r\n\r\n\x1b[2m  Worked for 8m 37s • 4:03 PM\x1b[0m\r\n\r\n\r\n› ${prompt}\x1b[0m\r\n\r\n\r\n  ? for shortcuts`;
    const outcome = await generateTextSnapshot({ cols, rows: 24, scrollback: 0, initial: Buffer.from(bytes), undimmed: true });
    if (!outcome.ok) throw new Error('snapshot failed');
    return Object.assign(outcome.rows.map((r) => r.text), { undimmed: outcome.rows.map((r) => r.undimmed ?? r.text) });
  };
  const placeholder = '\x1b[2mAsk Codex to do anything\x1b[22m';

  it('is empty with a blank footer row when the hint marks the bottom composer', async () => {
    expect(codexComposerEmpty(await render(placeholder))).toBe(true);
    expect(codexComposerVisible(await render(placeholder))).toBe(true);
  });

  it('still refuses a draft over a blank footer, as a visible composer', async () => {
    const draft = await render('half-typed in Terminal');
    expect(codexComposerEmpty(draft)).toBe(false);
    expect(codexComposerVisible(draft)).toBe(true);
  });

  it('refuses a placeholder with nothing under it, or an unknown row in the footer\'s place', () => {
    expect(codexComposerEmpty(['› Ask Codex to do anything', '', ''])).toBe(false);
    expect(codexComposerEmpty(['› Ask Codex to do anything', '', '  Press enter to confirm', '  ? for shortcuts'])).toBe(false);
  });

  it('refuses a typed draft that holds the placeholder\'s words or a hint-like line', async () => {
    const multiline = await render('Explain why I see this:\r\n  › Ask Codex to do anything');
    expect(codexComposerEmpty(multiline)).toBe(false);
    const withFooter = Object.assign(
      ['› Ask Codex to do anything', '  ? for shortlist', '', '  GPT-6.1-Sol low · ~/work', '  ? for shortcuts'],
      { undimmed: ['› Ask Codex to do anything', '  ? for shortlist', '', '  GPT-6.1-Sol low · ~/work', '  ? for shortcuts'] });
    expect(codexComposerEmpty(withFooter)).toBe(false);
  });

  it('reads the hint a 30-column pane cuts to `? for shortcu`', () => {
    expect(codexComposerEmpty(['› Ask Codex to do anything', '', '  GPT-6.1-Sol default · /priv…', '  ← for agents · ? for shortcu'])).toBe(true);
  });

  it('sends into the blank-footer composer when idle', async () => {
    const f = fixture(); f.state.slug = 'codex'; f.state.status = 'idle';
    f.show(await render(placeholder));
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~next\x1b[201~');
  });
});

describe('Codex 0.162 scrolled-back transcript', () => {
  // Captured live on codex-cli 0.162.1 at 40x27 (2026-10-13): a wheel-up during
  // a turn leaves a `New activity · ↓ Back to bottom · esc` banner over the
  // composer and swaps the shortcut hint under the footer.
  const withUndimmed = (rows: string[], undimmed: string[]) => Object.assign(rows, { undimmed });
  const empty = () => withUndimmed(
    ['  19', ' New activity · ↓ Back to bottom · esc', '', '› Ask Codex to do anything', '',
      '  GPT-6.1-Sol low · /private/tmp/claude…', '  New activity · enter/esc latest'],
    ['  19', ' New activity · ↓ Back to bottom · esc', '', '›', '',
      '  GPT-6.1-Sol low · /private/tmp/claude…', '                 enter/esc']);

  it('reads the empty composer as empty while scrolled back', () => {
    expect(codexComposerEmpty(empty())).toBe(true);
    // A wide pane keeps the shortcut hint after it.
    const wide = empty(); wide[6] = '  New activity · enter/esc latest · ? shortcuts';
    expect(codexComposerEmpty(wide)).toBe(true);
  });

  it('still refuses a draft, which turns the hint into `esc latest`', () => {
    const draft = withUndimmed(
      ['  19', ' New activity · ↓ Back to bottom · esc', '', '› Reply with just the word PONG.', '',
        '  GPT-6.1-Sol low · /private/tmp/claude…', '  New activity · esc latest'],
      ['  19', ' New activity · ↓ Back to bottom · esc', '', '› Reply with just the word PONG.', '',
        '  GPT-6.1-Sol low · /private/tmp/claude…', '                 esc']);
    expect(codexComposerEmpty(draft)).toBe(false);
    const unknown = empty(); unknown[6] = '  New activity · enter to confirm';
    expect(codexComposerEmpty(unknown)).toBe(false);
  });

  it('sends into it when idle, and holds while the title spinner says Codex is still working', async () => {
    const f = fixture(); f.state.slug = 'codex'; f.state.status = 'idle';
    f.show(empty());
    let title: { title: string; at: number } | null = { title: '⠼ Rust review | wmux', at: Date.now() };
    f.deps.readTitle = () => title;
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('busy');
    expect(f.write).not.toHaveBeenCalled();
    // A spinner frame older than the refresh window proves nothing.
    title = { title: '⠼ Rust review | wmux', at: Date.now() - 10_000 };
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('sent');
    title = { title: 'Rust review | wmux', at: Date.now() };
    expect(await deliverChatPrompt('conversation-1', 'again', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~next\x1b[201~');
    expect(f.write).toHaveBeenNthCalledWith(2, '\r');
  });
});
