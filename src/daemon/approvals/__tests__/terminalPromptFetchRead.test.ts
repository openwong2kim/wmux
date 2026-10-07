// Claude Code's WebFetch ("Fetch") and Read ("Read file") permission dialogs,
// captured from Claude Code 2.1.292 in manual mode inside an isolated wmux
// daemon (fixtures/terminal-prompts/claude-2.1.292/). Before these titles were
// known, both dialogs parsed with no title and the WebFetch one never read as
// active (it draws no footer), so their records carried no fingerprint and no
// choices: nothing a phone could answer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalRequest, type ApprovalResolveParams } from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import {
  dialogMatchesToolCall,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  toolFromDialogTitle,
} from '../terminalPromptParse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.292');
const load = (name: string): { cols: number; screen: string[] } =>
  JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { cols: number; screen: string[] };

const FETCH = load('claude-webfetch-01-initial-2.1.292.json');
const FETCH_NARROW = load('claude-webfetch-02-narrow-2.1.292.json');
const FETCH_LONG = load('claude-webfetch-03-long-gutter-2.1.292.json');
const READ = load('claude-read-01-initial-2.1.292.json');
const READ_LONG = load('claude-read-02-long-narrow-2.1.292.json');

const LONG_URL = 'https://example.com/some/really/long/path/segment/that/keeps/going/and/going/for/a/while/index.html?query=alpha&other=beta';
const LONG_PROMPT = 'Summarize the main heading of this page in one short sentence please, and also mention any links you see on it';

// The calls the captured dialogs were for, as the transcript records them.
// The model asked for `https://example.com`; the dialog draws the parsed URL.
const FETCH_CALL: PendingToolUse = { id: 'toolu_fetch', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'What is the page title?' } };
const READ_CALL: PendingToolUse = { id: 'toolu_read', name: 'Read', input: { file_path: '/etc/shells' } };

const parse = (fx: { cols: number; screen: string[] }) => parseTerminalPrompt(fx.screen, { cols: fx.cols });

describe('the captured dialogs parse like a Bash dialog', () => {
  it.each([
    ['WebFetch, 100 columns', FETCH, 'WebFetch', 'Fetch', ['url: https://example.com/', 'prompt: What is the page title?']],
    ['WebFetch, 50 columns (wrapped question)', FETCH_NARROW, 'WebFetch', 'Fetch', ['url: https://example.com/', 'prompt: What is the page title?']],
    ['WebFetch, long URL (gutter rows)', FETCH_LONG, 'WebFetch', 'Fetch', [
      'url: https://example.com/some/really/long/path/segment/that/keeps/going/and/',
      'going/for/a/while/index.html?query=alpha&other=beta',
      'prompt: Summarize the main heading of this page in one short sentence',
      'please, and also mention any links you see on it',
    ]],
    ['Read', READ, 'Read', 'Read file', ['Read(/etc/shells)']],
    ['Read, long path at 50 columns', READ_LONG, 'Read', 'Read file', ['Read(/System/Library/CoreServices/SystemVersion.', 'plist)']],
  ])('%s', (_label, fx, tool, title, commandRows) => {
    const parsed = parse(fx);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ title, commandRows, topRuleFound: true, active: true, cut: false });
    expect(toolFromDialogTitle(parsed!.title)).toBe(tool);
    expect(parsed!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reads the WebFetch question whole, wrapped or not, and its options without a footer', () => {
    for (const fx of [FETCH, FETCH_NARROW]) {
      const parsed = parse(fx)!;
      expect(parsed.question).toBe('Do you want to allow Claude to fetch this content?');
      expect(parsed.options.map((o) => o.label)).toEqual([
        'Yes',
        "Yes, and don't ask again for example.com",
        'No, and tell Claude what to do differently (esc)',
      ]);
    }
    // A narrow pane re-wraps the same dialog: same fingerprint, so a resize
    // alone does not refresh the record.
    expect(parse(FETCH_NARROW)!.fingerprint).toBe(parse(FETCH)!.fingerprint);
  });

  it('never offers the option that writes a lasting rule', () => {
    expect(terminalPromptAnswerability(parse(FETCH)!)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No, and tell Claude what to do differently (esc)' }],
    });
    for (const fx of [READ, READ_LONG]) {
      expect(terminalPromptAnswerability(parse(fx)!)).toEqual({
        answerable: true,
        choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
      });
    }
  });

  it('a footerless dialog is active only under its own title, with nothing below its options', () => {
    // Something printed under the options: not the live dialog.
    const below = [...FETCH.screen.slice(0, 21), '$ '];
    expect(parseTerminalPrompt(below, { cols: FETCH.cols })?.active).toBe(false);
    // The same box under a title that names no footerless tool.
    const retitled = FETCH.screen.map((row) => (row === ' Fetch' ? ' Bash command' : row));
    expect(parseTerminalPrompt(retitled, { cols: FETCH.cols })?.active).toBe(false);
    // The title scrolled off: nothing says the footer is not missing.
    expect(parseTerminalPrompt(FETCH.screen.slice(12), { cols: FETCH.cols })?.active).toBe(false);
  });
});

describe('dialogMatchesToolCall for Fetch and Read dialogs', () => {
  const fetchCall = (url: string, prompt?: string) => ({ name: 'WebFetch', command: url, ...(prompt !== undefined ? { description: prompt } : {}) });

  it('binds the call whose URL (as Claude draws it) and prompt the box spells', () => {
    expect(dialogMatchesToolCall(parse(FETCH)!, fetchCall('https://example.com', 'What is the page title?'))).toBe(true);
    expect(dialogMatchesToolCall(parse(FETCH)!, fetchCall('https://example.com/', 'What is the page title?'))).toBe(true);
    expect(dialogMatchesToolCall(parse(FETCH_NARROW)!, fetchCall('https://example.com', 'What is the page title?'))).toBe(true);
    // A URL broken inside a path segment and a prompt wrapped at a space.
    expect(dialogMatchesToolCall(parse(FETCH_LONG)!, fetchCall(LONG_URL, LONG_PROMPT))).toBe(true);
  });

  it.each([
    ['another host', fetchCall('https://example.org', 'What is the page title?')],
    ['another path', fetchCall('https://example.com/a', 'What is the page title?')],
    ['another prompt', fetchCall('https://example.com', 'What is the page heading?')],
    ['no prompt', fetchCall('https://example.com')],
    ['no URL at all', fetchCall('not a url', 'What is the page title?')],
    ['another tool', { name: 'Read', command: 'https://example.com' }],
  ])('refuses %s', (_label, call) => {
    expect(dialogMatchesToolCall(parse(FETCH)!, call)).toBe(false);
  });

  it('binds a Read call by the exact path, including one broken inside a word', () => {
    expect(dialogMatchesToolCall(parse(READ)!, { name: 'Read', command: '/etc/shells' })).toBe(true);
    expect(dialogMatchesToolCall(parse(READ_LONG)!, { name: 'Read', command: '/System/Library/CoreServices/SystemVersion.plist' })).toBe(true);
    expect(dialogMatchesToolCall(parse(READ)!, { name: 'Read', command: '/etc/shell' })).toBe(false);
    expect(dialogMatchesToolCall(parse(READ)!, { name: 'Read', command: '/etc/shells2' })).toBe(false);
    expect(dialogMatchesToolCall(parse(READ)!, { name: 'Bash', command: 'Read(/etc/shells)' })).toBe(false);
  });

  it('never binds with the top cut off', () => {
    expect(dialogMatchesToolCall(parse(READ)!, { name: 'Read', command: '/etc/shells' }, { topCut: true })).toBe(false);
  });
});

// ── The record and the answer, through the registry ─────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fetch-read-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(fx: { cols: number; screen: string[] }, pending: PendingToolUse) {
  const pane = { keyInputRevision: 3, incarnation: 'inc-1', rows: fx.screen as readonly string[], cols: fx.cols, pending };
  const writes: string[] = [];
  const clock = { now: 10_000 };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    readPromptScreen: async () => ({
      rows: pane.rows,
      cols: pane.cols,
      mark: { bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation },
    }),
    promptScreenMark: () => ({ bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }),
    pendingToolUse: () => pane.pending,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, pane, writes, clock };
}

async function create(h: ReturnType<typeof makeRegistry>): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', source: 'detector' });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

const answer = (h: ReturnType<typeof makeRegistry>, record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}) =>
  h.registry.resolve({
    id: record.id,
    decision: 'approve',
    choiceKey: '1',
    promptFingerprint: record.promptFingerprint,
    resolvedBy: 'device Test phone (dev-1)',
    terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    ...over,
  });

describe('Fetch and Read records', () => {
  it('a WebFetch dialog becomes an answerable record: the URL as its subject, Yes and No as choices', async () => {
    const h = makeRegistry(FETCH, FETCH_CALL);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'WebFetch',
      summary: 'https://example.com',
      question: 'Do you want to allow Claude to fetch this content?',
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No, and tell Claude what to do differently (esc)' }],
      toolUseId: 'toolu_fetch',
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('a Read dialog becomes an answerable record: the path as its subject; deny presses the plain No', async () => {
    const h = makeRegistry(READ, READ_CALL);
    const record = await create(h);
    expect(record).toMatchObject({
      toolName: 'Read',
      summary: '/etc/shells',
      question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await answer(h, record, { decision: 'deny', choiceKey: '3' })).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['3']);
  });

  it('the "don\'t ask again" / session option cannot be pressed', async () => {
    for (const [fx, call] of [[FETCH, FETCH_CALL], [READ, READ_CALL]] as const) {
      const h = makeRegistry(fx, call);
      const record = await create(h);
      expect(await answer(h, record, { choiceKey: '2' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
      expect(h.writes).toEqual([]);
    }
  });

  it('a changed screen refuses the answer and writes nothing', async () => {
    const h = makeRegistry(FETCH, FETCH_CALL);
    const record = await create(h);
    h.pane.rows = FETCH.screen.map((row) => row.replace('url: https://example.com/', 'url: https://example.net/'));
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('a call the box does not spell stays informational', async () => {
    const h = makeRegistry(FETCH, { ...FETCH_CALL, input: { url: 'https://example.org', prompt: 'What is the page title?' } });
    const record = await create(h);
    expect(record).toMatchObject({ toolName: 'WebFetch', summary: 'https://example.org' });
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
  });
});
