// Claude Code's WebSearch permission dialog, captured from Claude Code 2.1.296
// in manual mode (fixtures/terminal-prompts/claude-2.1.296/). It draws the
// generic title "Tool use" and boxes the call as `Web Search("<query>")`, so
// before this shape was known it parsed with no title (3 of 4 captures) and
// bound nothing. Its option 2 is the standing grant, cut by the TUI at 80 and
// 120 columns and not drawn at 50, where `2` is `No`: so its deny is the Esc
// decline, never a digit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import {
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  type ApprovalRequest,
  type ApprovalResolveParams,
} from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import {
  dialogMatchesToolCall,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  toolOfDialog,
  webSearchDetail,
} from '../terminalPromptParse';

type Fixture = { cols: number; screen: string[] };
const load = (dir: string, name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terminal-prompts', dir, name), 'utf8')) as Fixture;

const WIDE = load('claude-2.1.296', 'claude-websearch-01-initial-2.1.296.json');
const NARROW = load('claude-2.1.296', 'claude-websearch-02-narrow-2.1.296.json');
const NARROW50 = load('claude-2.1.296', 'claude-websearch-03-narrow50-2.1.296.json');
const DOMAINS = load('claude-2.1.296', 'claude-websearch-04-long-domains-2.1.296.json');
const HOOKED = load('claude-2.1.296', 'claude-websearch-05-initial-100x30-2.1.296.json');
const FETCH_296 = load('claude-2.1.296', 'claude-webfetch-01-initial-2.1.296.json');
const BASH_TIP = load('claude-2.1.293', 'claude-bash-tip-01-initial-2.1.293.json');

const QUERY = 'xterm.js headless terminal';
const LONG_QUERY = '"node-pty" resize SIGWINCH behaviour on macOS terminals with headless xterm rendering and Ink redraws';

// The calls the captured dialogs were for, as the transcript recorded them.
const CALL: PendingToolUse = { id: 'toolu_ws', name: 'WebSearch', input: { query: QUERY, mode: 'standard' } };
const DOMAINS_CALL: PendingToolUse = {
  id: 'toolu_ws_d',
  name: 'WebSearch',
  input: { query: LONG_QUERY, allowed_domains: ['github.com'], mode: 'standard' },
};

const parse = (fx: Fixture) => parseTerminalPrompt(fx.screen, { cols: fx.cols });
const with_ = (fx: Fixture, from: string, to: string): Fixture => {
  expect(fx.screen.some((row) => row.includes(from))).toBe(true);
  return { ...fx, screen: fx.screen.map((row) => row.replace(from, to)) };
};
/** The call as the registry hands it to `dialogMatchesToolCall`. */
const wsCall = (query: string, input: Record<string, unknown> = { query, mode: 'standard' }) => {
  const detail = webSearchDetail(input);
  return { name: 'WebSearch', command: query, ...(detail ? { description: detail } : {}) };
};
const bindsTo = (fx: Fixture, query: string, input?: Record<string, unknown>) =>
  dialogMatchesToolCall(parse(fx)!, wsCall(query, input));

describe('the captured WebSearch dialogs', () => {
  it.each([
    ['120 columns', WIDE, [`Web Search("${QUERY}")`]],
    ['80 columns', NARROW, [`Web Search("${QUERY}")`]],
    ['50 columns', NARROW50, [`Web Search("${QUERY}")`]],
    ['100 columns (hook installed)', HOOKED, ['Web Search("wmux terminal multiplexer")']],
    ['a wrapped call with a domain filter', DOMAINS, [
      'Web Search(""node-pty" resize SIGWINCH behaviour on macOS terminals with',
      'headless xterm rendering and Ink redraws", only allowing domains:',
      'github.com)',
    ]],
  ])('%s: titled "Tool use", the box read as the call, active', (_label, fx, commandRows) => {
    const parsed = parse(fx);
    expect(parsed).toMatchObject({ title: 'Tool use', commandRows, topRuleFound: true, active: true, bodyCut: false });
    expect(parsed!.question).toBe('Do you want to proceed?');
    expect(toolOfDialog(parsed!)).toBe('WebSearch');
  });

  it('the standing grant is cut at 80 and 120 columns and not drawn at 50', () => {
    for (const fx of [WIDE, NARROW, DOMAINS, HOOKED]) {
      const parsed = parse(fx)!;
      expect(parsed.cut).toBe(true);
      expect(parsed.options.map((o) => [o.key, !!o.cut])).toEqual([['1', false], ['2', true], ['3', false]]);
      expect(parsed.options[1]!.label).toMatch(/^Yes, and don't ask again for Web Search commands in \/private\/tmp\/.*…$/);
    }
    const narrow = parse(NARROW50)!;
    expect(narrow.cut).toBe(false);
    expect(narrow.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    // A resize re-cuts option 2: another fingerprint, so the record is refreshed.
    expect(parse(NARROW)!.fingerprint).not.toBe(parse(WIDE)!.fingerprint);
  });

  it('offers the Yes only, in every layout: the deny is the Esc decline', () => {
    for (const fx of [WIDE, NARROW, NARROW50, DOMAINS, HOOKED]) {
      expect(terminalPromptAnswerability(parse(fx)!)).toEqual({ answerable: true, choices: [{ key: '1', label: 'Yes' }] });
    }
  });

  it('binds the call whose query (and domain filter) the box spells', () => {
    for (const fx of [WIDE, NARROW, NARROW50]) expect(bindsTo(fx, QUERY)).toBe(true);
    expect(bindsTo(HOOKED, 'wmux terminal multiplexer')).toBe(true);
    expect(bindsTo(DOMAINS, LONG_QUERY, DOMAINS_CALL.input)).toBe(true);
    // The input without `mode` draws the same box.
    expect(bindsTo(WIDE, QUERY, { query: QUERY })).toBe(true);
  });

  it('the WebFetch dialog is unchanged on 2.1.296', () => {
    const parsed = parse(FETCH_296)!;
    expect(parsed).toMatchObject({ title: 'Fetch', commandRows: ['url: https://example.com/', 'prompt: What is the page title?'], active: true, cut: false });
    expect(toolOfDialog(parsed)).toBe('WebFetch');
  });
});

describe('webSearchDetail: only the measured input shapes', () => {
  it.each([
    [{ query: 'q' }, ''],
    [{ query: 'q', mode: 'standard' }, ''],
    [{ query: 'q', allowed_domains: ['github.com'], mode: 'standard' }, 'only allowing domains: github.com'],
    [{ query: 'q', allowed_domains: ['docs.example-site.org'] }, 'only allowing domains: docs.example-site.org'],
  ])('%j → %j', (input, detail) => {
    expect(webSearchDetail(input)).toBe(detail);
  });

  it.each([
    ['no query', { mode: 'standard' }],
    ['two domains', { query: 'q', allowed_domains: ['github.com', 'gitlab.com'] }],
    ['an empty domain list', { query: 'q', allowed_domains: [] }],
    ['blocked domains', { query: 'q', blocked_domains: ['github.com'] }],
    ['a domain with a quote', { query: 'q', allowed_domains: ['x"'] }],
    ['a domain with a space', { query: 'q', allowed_domains: ['git hub.com'] }],
    ['a domain that is not a string', { query: 'q', allowed_domains: [42] }],
    ['another mode', { query: 'q', mode: 'deep' }],
    ['an unknown key', { query: 'q', mode: 'standard', extra: 1 }],
  ])('%s → null', (_label, input) => {
    expect(webSearchDetail(input as Record<string, unknown>)).toBeNull();
  });
});

describe('near misses stay unbound', () => {
  it.each([
    ['a query one character off', QUERY.replace('xterm', 'xtern')],
    ['a query with an extra word', `${QUERY} docs`],
    ['a query cut short', 'xterm.js headless'],
    ['the query in other quotes', `'${QUERY}'`],
  ])('%s', (_label, query) => {
    expect(bindsTo(WIDE, query)).toBe(false);
  });

  it('a domain filter the box does not show, or one it shows that the call does not have', () => {
    expect(bindsTo(WIDE, QUERY, { query: QUERY, allowed_domains: ['github.com'] })).toBe(false);
    expect(bindsTo(DOMAINS, LONG_QUERY)).toBe(false);
    expect(bindsTo(DOMAINS, LONG_QUERY, { query: LONG_QUERY, allowed_domains: ['gitlab.com'] })).toBe(false);
  });

  it('a query disguised as a domain filter', () => {
    const disguised = 'a", only allowing domains: github.com';
    expect(bindsTo(DOMAINS, disguised)).toBe(false);
    // The box drawn for a real filter on query `a`: the call that only SAYS it
    // has one does not spell it (its closing quote lands after the domain).
    const drawn = with_(
      with_(with_(DOMAINS, 'Web Search(""node-pty" resize SIGWINCH behaviour on macOS terminals with', 'Web Search("a", only allowing domains: github.com)'),
        '│ headless xterm rendering and Ink redraws", only allowing domains:', ''),
      '│ github.com)', '',
    );
    expect(parse(drawn)!.commandRows).toEqual(['Web Search("a", only allowing domains: github.com)']);
    expect(bindsTo(drawn, disguised)).toBe(false);
    expect(bindsTo(drawn, 'a', { query: 'a', allowed_domains: ['github.com'] })).toBe(true);
  });

  it('a query with an ellipsis in it never binds, drawn whole or cut', () => {
    const query = 'xterm.js headless termin…';
    expect(bindsTo(with_(WIDE, `Web Search("${QUERY}")`, `Web Search("${query}")`), query)).toBe(false);
    // The TUI cutting the box row: unanswerable whatever binds.
    const cut = parse(with_(WIDE, `Web Search("${QUERY}")`, 'Web Search("xterm.js headless termin…'))!;
    expect(cut.bodyCut).toBe(true);
    expect(terminalPromptAnswerability(cut).answerable).toBe(false);
  });

  it('another tool with the same text: ToolSearch has a `query` too', () => {
    expect(dialogMatchesToolCall(parse(WIDE)!, { name: 'ToolSearch', command: QUERY })).toBe(false);
  });

  it('"Tool use" over another box names no tool and binds nothing', () => {
    const mcp = with_(WIDE, `Web Search("${QUERY}")`, `wmux - pane_list(query: "${QUERY}") (MCP)`);
    const parsed = parse(mcp)!;
    expect(parsed.title).toBe('Tool use');
    expect(toolOfDialog(parsed)).toBeUndefined();
    expect(dialogMatchesToolCall(parsed, wsCall(QUERY))).toBe(false);
    // Its options are not WebSearch's: the plain No is offered as for any dialog.
    expect(terminalPromptAnswerability(parsed).choices.map((c) => c.key)).toEqual(['1', '3']);
    // A box row that only CONTAINS the call.
    expect(bindsTo(with_(WIDE, `Web Search("${QUERY}")`, `xWeb Search("${QUERY}")`), QUERY)).toBe(false);
    expect(bindsTo(with_(WIDE, `Web Search("${QUERY}")`, `Web Search("${QUERY}") now`), QUERY)).toBe(false);
  });

  it.each([['Web Search'], ['Tool Use'], ['Tool use:'], ['WebSearch']])('a lookalike title %j binds nothing', (title) => {
    const fx = with_(WIDE, ' Tool use', ` ${title}`);
    const parsed = parse(fx);
    expect(parsed ? toolOfDialog(parsed) : undefined).toBeUndefined();
    expect(parsed ? dialogMatchesToolCall(parsed, wsCall(QUERY)) : false).toBe(false);
  });

  it('never binds with the top cut off', () => {
    const top = WIDE.screen.findIndex((row) => row === ' Tool use');
    const parsed = parseTerminalPrompt(WIDE.screen.slice(top + 2), { cols: WIDE.cols })!;
    expect(parsed.title).toBeUndefined();
    expect(dialogMatchesToolCall(parsed, wsCall(QUERY))).toBe(false);
    expect(dialogMatchesToolCall(parsed, wsCall(QUERY), { topCut: true })).toBe(false);
  });

  it('with its footer gone it is not active', () => {
    const fx = with_(WIDE, ' Esc to cancel · Tab to amend', '');
    expect(parse(fx)!.active).toBe(false);
  });

  it('a wide-character query the box breaks inside a word binds', () => {
    // Synthesized from the 04 capture's layout: a wrapped box draws a gutter
    // on every row, and a CJK run breaks wherever the row ends.
    const query = '터미널 멀티플렉서 헤드리스 렌더링 비교 xterm.js';
    const fx = with_(
      with_(with_(DOMAINS, 'Web Search(""node-pty" resize SIGWINCH behaviour on macOS terminals with', 'Web Search("터미널 멀티플렉서 헤드리스 렌더'),
        '│ headless xterm rendering and Ink redraws", only allowing domains:', '│ 링 비교 xterm.js", only allowing domains:'),
      '│ github.com)', '│ github.com)',
    );
    expect(parse(fx)!.commandRows).toEqual(['Web Search("터미널 멀티플렉서 헤드리스 렌더', '링 비교 xterm.js", only allowing domains:', 'github.com)']);
    expect(bindsTo(fx, query, { query, allowed_domains: ['github.com'] })).toBe(true);
    const other = query.replace('렌더링', '렌더랑');
    expect(bindsTo(fx, other, { query: other, allowed_domains: ['github.com'] })).toBe(false);
  });
});

describe('a cut row: only a display-only option\'s cut is let through', () => {
  it.each([
    ['a standing grant cut before it says so', "2. Yes, and don't a…"],
    ['the Yes cut', '1. Yes…'],
    ['the No cut', '3. No, and tell…'],
  ])('%s refuses the dialog', (_label, row) => {
    const rows = WIDE.screen.map((r) => {
      const m = /^( (?:❯ | {2}) ?)(\d)\. /.exec(r);
      return m && row.startsWith(`${m[2]}.`) ? `${m[1]}${row}` : r;
    });
    const parsed = parseTerminalPrompt(rows, { cols: WIDE.cols })!;
    expect(parsed.options.some((o) => o.cut && o.label.startsWith(row.slice(3)))).toBe(true);
    expect(terminalPromptAnswerability(parsed)).toEqual({ answerable: false, choices: [] });
  });

  it('a Bash dialog with only its standing-grant option cut stays answerable', () => {
    const rows = BASH_TIP.screen.map((r) => (r.includes('2. Yes, and always allow access to') ? `${r.slice(0, 60)}…` : r));
    const parsed = parseTerminalPrompt(rows, { cols: BASH_TIP.cols })!;
    expect(parsed.cut).toBe(true);
    expect(parsed.bodyCut).toBe(false);
    expect(terminalPromptAnswerability(parsed)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '4', label: 'No' }],
    });
  });

  it('a cut on a wrapped option\'s continuation row belongs to that option', () => {
    const rows = [...BASH_TIP.screen];
    const at = rows.findIndex((r) => r.includes('2. Yes, and always allow access to'));
    rows.splice(at + 1, 0, '      from this project and every other one that keeps go…');
    const parsed = parseTerminalPrompt(rows, { cols: BASH_TIP.cols })!;
    expect(parsed.options[1]!.cut).toBe(true);
    expect(parsed.bodyCut).toBe(false);
    expect(terminalPromptAnswerability(parsed).answerable).toBe(true);
  });
});

// ── The record and the answer, through the registry ─────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-websearch-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const SESSION = 'b0c1d2e3-f405-4a6b-8c9d-0e1f2a3b4c5d';

function makeRegistry(fx: Fixture, pending: PendingToolUse | null) {
  const pane = { keyInputRevision: 3, incarnation: 'inc-1', bytes: 1, rows: fx.screen as readonly string[], cols: fx.cols, pending };
  const writes: string[] = [];
  const clock = { now: 10_000 };
  // Runs right after a screen read, before the registry's write: a resize there.
  const afterRead: { fn: (() => void) | null } = { fn: null };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    readPromptScreen: async () => {
      const read = {
        rows: pane.rows,
        cols: pane.cols,
        mark: { bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation },
      };
      afterRead.fn?.();
      return read;
    },
    promptScreenMark: () => ({ bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }),
    pendingToolUse: () => pane.pending,
    agentSessionId: () => SESSION,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, pane, writes, clock, afterRead };
}
type Harness = ReturnType<typeof makeRegistry>;

async function create(h: Harness, note: Partial<Parameters<ApprovalRegistry['noteTerminalPrompt']>[0]> = {}): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', source: 'detector', ...note });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

const answer = (h: Harness, record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}) =>
  h.registry.resolve({
    id: record.id,
    decision: 'approve',
    choiceKey: '1',
    promptFingerprint: record.promptFingerprint,
    resolvedBy: 'device Test phone (dev-1)',
    terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    ...over,
  });

const decline = (h: Harness, record: ApprovalRequest) =>
  h.registry.resolve({
    id: record.id,
    decision: 'deny',
    resolvedBy: 'device Test phone (dev-1)',
    terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE,
  });

describe('WebSearch records', () => {
  it('becomes an answerable record: the query as its subject, Yes as its one choice; the phone presses 1', async () => {
    const h = makeRegistry(WIDE, CALL);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'WebSearch',
      summary: QUERY,
      question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }],
      toolUseId: 'toolu_ws',
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('the domain filter shows next to the query', async () => {
    const h = makeRegistry(DOMAINS, DOMAINS_CALL);
    const record = await create(h);
    expect(record).toMatchObject({ summary: `${LONG_QUERY} (only allowing domains: github.com)`, choices: [{ key: '1', label: 'Yes' }] });
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('no digit denies: option 2 (the standing grant) and 3 are refused, the decline writes Esc', async () => {
    const h = makeRegistry(WIDE, CALL);
    const record = await create(h);
    expect(await answer(h, record, { choiceKey: '2' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(await answer(h, record, { decision: 'deny', choiceKey: '3' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.writes).toEqual([]);
    expect(await decline(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
  });

  it('resize race: made at 50 columns, the wide layout drawn after the fence read with the same bytes — a deny never writes 2', async () => {
    const h = makeRegistry(NARROW50, CALL);
    const record = await create(h);
    expect(record.choices).toEqual([{ key: '1', label: 'Yes' }]);
    // `2` is No on this screen, but it is not a choice: refused before any read.
    expect(await answer(h, record, { decision: 'deny', choiceKey: '2' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
    // The decline proves the 50-column dialog, then the pane is resized.
    h.afterRead.fn = () => { h.pane.rows = WIDE.screen; h.pane.cols = WIDE.cols; };
    expect(await decline(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
    expect(h.writes).not.toContain('2');
  });

  it('the same screen re-drawn at 50 columns before the press: prompt-changed, nothing written', async () => {
    const h = makeRegistry(WIDE, CALL);
    const record = await create(h);
    h.pane.rows = NARROW50.screen;
    h.pane.cols = NARROW50.cols;
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('binds by the PermissionRequest hook alone (its measured tool_input: query and mode)', async () => {
    const h = makeRegistry(HOOKED, null);
    const record = await create(h, {
      source: 'hook',
      toolName: 'WebSearch',
      toolInput: { query: 'wmux terminal multiplexer', mode: 'standard' },
      hookSessionId: SESSION,
      promptId: 'a1b2c3d4-0000-4000-8000-000000000001',
    });
    expect(record).toMatchObject({ toolName: 'WebSearch', summary: 'wmux terminal multiplexer', choices: [{ key: '1', label: 'Yes' }] });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it.each([
    ['another query', { query: 'xterm.js headless terminals', mode: 'standard' }],
    ['a domain filter the box does not show', { query: QUERY, allowed_domains: ['github.com'], mode: 'standard' }],
    ['a domain with a quote', { query: QUERY, allowed_domains: ['x"'], mode: 'standard' }],
    ['an unmeasured mode', { query: QUERY, mode: 'deep' }],
  ])('%s: informational, and cannot be declined either', async (_label, input) => {
    const h = makeRegistry(WIDE, { ...CALL, input });
    const record = await create(h);
    expect(record).toMatchObject({ toolName: 'WebSearch' });
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-unverified' });
    expect(h.writes).toEqual([]);
  });
});
