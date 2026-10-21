// The owner's Commands IPC: only the main window's top frame is answered;
// read gives availability, the switch, the masked log and the rules;
// "Always allow" turns a command refused as not on the list into a rule for
// exactly that command (which the gate then allows), and a rule the store
// refuses comes back with its reason; Remove takes a rule out by index and
// text; the switch is saved and read by the gate.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

import type { BotProfile } from '../../../shared/bot';
import { BotCommandLog } from '../botCommandLog';
import { RUNS_CODE_WARNING, botCommandIpcHandlers } from '../botCommandModule';
import { BotCommandRulesStore, botCommandRulesPath } from '../botCommandRules';
import { evaluateBotExecTool, logBotExecDecision, reviewUnlistedCommand, setBotExecDecisionSink } from '../botExec';
import type { BotCommandReviewer, ReviewOutcome } from '../botCommandReviewer';

const BOT = 'bot-0000000a';
let dir = '';
let botDir = '';
let log: BotCommandLog;
let rules: BotCommandRulesStore;
const changed = vi.fn();

const mainFrame = { id: 'top' };
const webContents = { mainFrame };
const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
const OWNER = { sender: webContents, senderFrame: mainFrame };

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-commands-')));
  botDir = path.join(dir, 'factory', 'bots', BOT);
  fs.mkdirSync(botDir, { recursive: true });
  log = new BotCommandLog(dir);
  rules = new BotCommandRulesStore(botCommandRulesPath(dir));
  setBotExecDecisionSink((botId, rec) => {
    log.record(botId, rec);
  });
  changed.mockReset();
  verdict = null;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  setBotExecDecisionSink(null);
  await log.settled();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const handlers = (opts: { engine?: BotProfile['engine']; supported?: boolean } = {}) =>
  botCommandIpcHandlers(() => win, {
    log: () => log,
    rules: () => rules,
    bot: (id) => (id === BOT ? ({ id: BOT, engine: opts.engine ?? { kind: 'claude-sdk' } } as BotProfile) : null),
    support: async () => (opts.supported === false ? { ok: false, reason: 'no sandbox' } : { ok: true, version: '2.1.305' }),
    changed,
  });

/** The reviewer's answer in this test; null: the reviewer setting is off. */
let verdict: ReviewOutcome | null = null;

/** One Bash call through the gate and the reviewer step, logged as the
 *  adapter logs it. */
async function run(command: string) {
  let d = evaluateBotExecTool('Bash', { command }, { botId: BOT, botDir, attended: () => true, rules: () => rules.rulesFor(BOT), enabled: () => rules.commandsEnabled(BOT) });
  const reviewer = { review: async () => verdict } as unknown as BotCommandReviewer;
  d = await reviewUnlistedCommand(d, { command }, { enabled: () => verdict !== null, attended: () => true, reviewer, folder: { botDir } });
  logBotExecDecision(BOT, 'Bash', d, () => undefined);
  return d;
}

const newest = () => log.entries(BOT)[0];

describe('the Commands IPC', () => {
  it('answers only the main window\'s top frame', async () => {
    const h = handlers();
    await run('make build');
    const id = newest().id;
    for (const e of [{ sender: {}, senderFrame: mainFrame }, { sender: webContents, senderFrame: { id: 'sub' } }]) {
      expect(await h.read(e, { botId: BOT })).toEqual({ ok: false, error: 'only the wmux window may do this' });
      expect(await h.setEnabled(e, { botId: BOT, enabled: false })).toMatchObject({ ok: false });
      expect(await h.allow(e, { botId: BOT, entryId: id })).toMatchObject({ ok: false });
      expect(await h.removeRule(e, { botId: BOT, index: 0, text: 'x' })).toMatchObject({ ok: false });
    }
    expect(await botCommandIpcHandlers(() => null, { log: () => log, rules: () => rules, changed }).read(OWNER, { botId: BOT })).toMatchObject({ ok: false });
    expect(rules.commandsEnabled(BOT)).toBe(true);
    expect(rules.rulesFor(BOT)).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('reads availability, the switch, the log newest first and the rules', async () => {
    await run('ls');
    await run('make build');
    const r = await handlers().read(OWNER, { botId: BOT });
    expect(r).toMatchObject({ ok: true, available: true, enabled: true, rules: [] });
    if (!r.ok) throw new Error('read failed');
    expect(r.entries.map((e) => [e.target, e.decision, e.layer])).toEqual([['make build', 'deny', 'script'], ['ls', 'allow', 'allowlist']]);
    expect(await handlers({ supported: false }).read(OWNER, { botId: BOT })).toMatchObject({ ok: true, available: false });
    expect(await handlers({ engine: { kind: 'claude-pty' } }).read(OWNER, { botId: BOT })).toMatchObject({ ok: true, available: false });
    expect(await handlers().read(OWNER, { botId: '../x' })).toMatchObject({ ok: false });
  });

  it('Always allow saves a rule for exactly the refused command, which the gate then allows; one that runs code needs the owner\'s confirm', async () => {
    expect(await run("make 'a b'")).toMatchObject({ ok: false, layer: 'script' });
    const h = handlers();
    const r0 = await h.read(OWNER, { botId: BOT });
    expect(r0.ok && r0.entries[0]).toMatchObject({ canAllow: true, runsCode: true });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: RUNS_CODE_WARNING });
    expect(rules.rulesFor(BOT)).toEqual([]);
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id, confirm: true })).toEqual({ ok: true });
    expect(rules.rulesFor(BOT)).toEqual([{ argv: ['make', 'a b'] }]);
    expect(changed).toHaveBeenCalledWith(BOT);
    expect(await run("make 'a b'")).toMatchObject({ ok: true, layer: 'rule' });
    expect(newest()).toMatchObject({ decision: 'allow', layer: 'rule' });
    // Exactly that command: other arguments stay refused.
    expect(await run('make other')).toMatchObject({ ok: false, layer: 'script' });
    const r = await h.read(OWNER, { botId: BOT });
    expect(r.ok && r.rules).toEqual([{ text: "make 'a b'", anyArgs: false }]);
  });

  it('a rule the store refuses comes back with its reason; a floor refusal has no Always allow', async () => {
    // (An interpreter without its script never gets this far: the floor refuses it.)
    const long = ['make', ...Array.from({ length: 16 }, (_, k) => `a${k}`)].join(' ');
    expect(await run(long)).toMatchObject({ ok: false, layer: 'script' });
    const h = handlers();
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'a command rule has more than 16 words' });
    expect(rules.rulesFor(BOT)).toEqual([]);
    expect(await run('sudo ls')).toMatchObject({ ok: false, layer: 'floor' });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'Only a command refused as not on the list can be always allowed.' });
    expect(await h.allow(OWNER, { botId: BOT, entryId: 'gone' })).toEqual({ ok: false, error: 'That decision is no longer in the log.' });
    // A command kept masked (an inline credential) never becomes a rule.
    expect(await run("make 'http://x?token=abc123'")).toMatchObject({ ok: false, layer: 'script' });
    expect(newest().target).toContain('[redacted]');
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'This command held a secret and was kept masked, so it cannot become a rule.' });
    expect(changed).not.toHaveBeenCalled();
  });

  it('a built-in command refused for a blocked option is the floor\'s: never offered Always allow, and main refuses it', async () => {
    expect(await run('rg --pre=x foo')).toMatchObject({ ok: false, layer: 'floor' });
    const rgId = newest().id;
    await run('make build');
    const h = handlers();
    const r = await h.read(OWNER, { botId: BOT });
    if (!r.ok) throw new Error('read failed');
    expect(r.entries.find((e) => e.id === rgId)?.canAllow).toBeUndefined();
    expect(r.entries.find((e) => e.target === 'make build')?.canAllow).toBe(true);
    expect(await h.allow(OWNER, { botId: BOT, entryId: rgId })).toEqual({ ok: false, error: 'Only a command refused as not on the list can be always allowed.' });
    expect(rules.rulesFor(BOT)).toEqual([]);
  });

  it('Always allow covers a program that needs a rule, a script and a reviewer refusal; every rule needs confirm', async () => {
    const h = handlers();
    fs.writeFileSync(path.join(botDir, 'build.sh'), 'echo build\n');
    fs.writeFileSync(path.join(botDir, 'tool.py'), 'print(1)\n');
    // A plain unlisted program needs the confirm too.
    expect(await run('jq . data.json')).toMatchObject({ ok: false, layer: 'unlisted' });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: RUNS_CODE_WARNING });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id, confirm: true })).toEqual({ ok: true });
    for (const line of ['./build.sh', 'python3 tool.py']) {
      expect(await run(line), line).toMatchObject({ ok: false, layer: 'script' });
      const r = await h.read(OWNER, { botId: BOT });
      expect(r.ok && r.entries[0], line).toMatchObject({ canAllow: true, runsCode: true });
      expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id }), line).toEqual({ ok: false, error: RUNS_CODE_WARNING });
      expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id, confirm: true }), line).toEqual({ ok: true });
    }
    verdict = { allow: false, code: 'reviewer_deny', risk: 'high', rationale: 'creates a file', latencyMs: 12 };
    expect(await run('touch new.md')).toMatchObject({ ok: false, layer: 'reviewer' });
    expect(newest()).toMatchObject({ layer: 'reviewer', review: { code: 'reviewer_deny', risk: 'high', rationale: 'creates a file', latencyMs: 12 } });
    const r = await h.read(OWNER, { botId: BOT });
    expect(r.ok && r.entries[0]).toMatchObject({ canAllow: true, review: { risk: 'high', rationale: 'creates a file' } });
    expect(r.ok && r.entries[0].runsCode).toBe(true);
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: RUNS_CODE_WARNING });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id, confirm: true })).toEqual({ ok: true });
    // No file is pinned: nothing but the words is stored.
    expect(rules.rulesFor(BOT)).toEqual([{ argv: ['jq', '.', 'data.json'] }, { argv: ['./build.sh'] }, { argv: ['python3', 'tool.py'] }, { argv: ['touch', 'new.md'] }]);
    for (const line of ['jq . data.json', './build.sh', 'python3 tool.py', 'touch new.md']) expect(await run(line), line).toMatchObject({ ok: true, layer: 'rule' });
    // The bot changing the file does not change the grant; a line that writes
    // and runs it is not covered.
    fs.writeFileSync(path.join(botDir, 'build.sh'), 'echo other\n');
    expect(await run('./build.sh')).toMatchObject({ ok: true, layer: 'rule' });
    expect(await run('echo x > build.sh ; ./build.sh')).toMatchObject({ ok: false, layer: 'script', reason: expect.stringContaining('alone on its line') });
    expect(await run('./build.sh | cat')).toMatchObject({ ok: false });
  });

  it('a line with more than one command needing a rule gets no Always allow: each needs its own approval', async () => {
    fs.writeFileSync(path.join(botDir, 'a.sh'), 'a\n');
    fs.writeFileSync(path.join(botDir, 'x.sh'), 'x\n');
    const h = handlers();
    for (const line of ['./a.sh ; ./x.sh', 'jq . a && ./x.sh']) {
      expect(await run(line), line).toMatchObject({ ok: false, layer: 'script' });
      const r = await h.read(OWNER, { botId: BOT });
      expect(r.ok && r.entries[0].canAllow, line).toBeUndefined();
      expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id }), line).toEqual({ ok: false, error: 'This line runs more than one command that needs a rule; each one is allowed on its own, when the bot runs it alone.' });
    }
    expect(rules.rulesFor(BOT)).toEqual([]);
  });

  it('refuses an unknown bot on every write', async () => {
    const h = handlers();
    const other = 'bot-0000000f';
    expect(await h.setEnabled(OWNER, { botId: other, enabled: false })).toEqual({ ok: false, error: 'no such bot' });
    expect(await h.allow(OWNER, { botId: other, entryId: 'x' })).toEqual({ ok: false, error: 'no such bot' });
    expect(await h.removeRule(OWNER, { botId: other, index: 0, text: 'x' })).toEqual({ ok: false, error: 'no such bot' });
    expect(rules.commandsEnabled(other)).toBe(true);
  });

  it('Remove takes out the rule it names, and nothing when the text no longer matches', async () => {
    await rules.setRules(BOT, [{ argv: ['make'] }, { argv: ['npm', 'test'] }]);
    const h = handlers();
    expect(await h.removeRule(OWNER, { botId: BOT, index: 0, text: 'npm test' })).toMatchObject({ ok: false });
    expect(rules.rulesFor(BOT)).toHaveLength(2);
    expect(await h.removeRule(OWNER, { botId: BOT, index: 1, text: 'npm test' })).toEqual({ ok: true });
    expect(rules.rulesFor(BOT)).toEqual([{ argv: ['make'] }]);
  });

  it('the switch is saved, read back after a restart, and refuses every command at the gate', async () => {
    const h = handlers();
    expect(await h.setEnabled(OWNER, { botId: BOT, enabled: 'no' })).toMatchObject({ ok: false });
    expect(await h.setEnabled(OWNER, { botId: BOT, enabled: false })).toEqual({ ok: true });
    expect(new BotCommandRulesStore(botCommandRulesPath(dir)).commandsEnabled(BOT)).toBe(false);
    expect(await run('ls')).toMatchObject({ ok: false, layer: 'off' });
    expect(evaluateBotExecTool('Read', { file_path: path.join(botDir, 'x') }, { botId: BOT, botDir, attended: () => true, rules: () => [], enabled: () => false })).toMatchObject({ ok: false, layer: 'off' });
    expect(newest()).toMatchObject({ decision: 'deny', layer: 'off' });
    expect(await h.setEnabled(OWNER, { botId: BOT, enabled: true })).toEqual({ ok: true });
    expect(await run('ls')).toMatchObject({ ok: true });
  });

  it('a rules file of another version turns every bot\'s commands off', () => {
    const file = botCommandRulesPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, bots: {} }));
    expect(new BotCommandRulesStore(file).commandsEnabled(BOT)).toBe(false);
  });
});
