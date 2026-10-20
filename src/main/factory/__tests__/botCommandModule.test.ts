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
import { botCommandIpcHandlers } from '../botCommandModule';
import { BotCommandRulesStore, botCommandRulesPath } from '../botCommandRules';
import { evaluateBotExecTool, logBotExecDecision, setBotExecDecisionSink } from '../botExec';

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

/** One Bash call through the gate, logged as the adapter logs it. */
function run(command: string) {
  const d = evaluateBotExecTool('Bash', { command }, { botId: BOT, botDir, attended: () => true, rules: () => rules.rulesFor(BOT), enabled: () => rules.commandsEnabled(BOT) });
  logBotExecDecision(BOT, 'Bash', d, () => undefined);
  return d;
}

const newest = () => log.entries(BOT)[0];

describe('the Commands IPC', () => {
  it('answers only the main window\'s top frame', async () => {
    const h = handlers();
    run('make build');
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
    run('ls');
    run('make build');
    const r = await handlers().read(OWNER, { botId: BOT });
    expect(r).toMatchObject({ ok: true, available: true, enabled: true, rules: [] });
    if (!r.ok) throw new Error('read failed');
    expect(r.entries.map((e) => [e.target, e.decision, e.layer])).toEqual([['make build', 'deny', 'unlisted'], ['ls', 'allow', 'allowlist']]);
    expect(await handlers({ supported: false }).read(OWNER, { botId: BOT })).toMatchObject({ ok: true, available: false });
    expect(await handlers({ engine: { kind: 'claude-pty' } }).read(OWNER, { botId: BOT })).toMatchObject({ ok: true, available: false });
    expect(await handlers().read(OWNER, { botId: '../x' })).toMatchObject({ ok: false });
  });

  it('Always allow saves a rule for exactly the refused command, which the gate then allows', async () => {
    expect(run("make 'a b'")).toMatchObject({ ok: false, layer: 'unlisted' });
    const h = handlers();
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: true });
    expect(rules.rulesFor(BOT)).toEqual([{ argv: ['make', 'a b'] }]);
    expect(changed).toHaveBeenCalledWith(BOT);
    expect(run("make 'a b'")).toMatchObject({ ok: true, layer: 'rule' });
    expect(newest()).toMatchObject({ decision: 'allow', layer: 'rule' });
    // Exactly that command: other arguments stay refused.
    expect(run('make other')).toMatchObject({ ok: false, layer: 'unlisted' });
    const r = await h.read(OWNER, { botId: BOT });
    expect(r.ok && r.rules).toEqual([{ text: "make 'a b'", anyArgs: false }]);
  });

  it('a rule the store refuses comes back with its reason; a floor refusal has no Always allow', async () => {
    // (An interpreter without its script never gets this far: the floor refuses it.)
    const long = ['make', ...Array.from({ length: 16 }, (_, k) => `a${k}`)].join(' ');
    expect(run(long)).toMatchObject({ ok: false, layer: 'unlisted' });
    const h = handlers();
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'a command rule has more than 16 words' });
    expect(rules.rulesFor(BOT)).toEqual([]);
    expect(run('sudo ls')).toMatchObject({ ok: false, layer: 'floor' });
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'Only a command refused as not on the list can be always allowed.' });
    expect(await h.allow(OWNER, { botId: BOT, entryId: 'gone' })).toEqual({ ok: false, error: 'That decision is no longer in the log.' });
    // A command kept masked (an inline credential) never becomes a rule.
    expect(run("make 'http://x?token=abc123'")).toMatchObject({ ok: false, layer: 'unlisted' });
    expect(newest().target).toContain('[redacted]');
    expect(await h.allow(OWNER, { botId: BOT, entryId: newest().id })).toEqual({ ok: false, error: 'This command held a secret and was kept masked, so it cannot become a rule.' });
    expect(changed).not.toHaveBeenCalled();
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
    expect(run('ls')).toMatchObject({ ok: false, layer: 'off' });
    expect(evaluateBotExecTool('Read', { file_path: path.join(botDir, 'x') }, { botId: BOT, botDir, attended: () => true, rules: () => [], enabled: () => false })).toMatchObject({ ok: false, layer: 'off' });
    expect(newest()).toMatchObject({ decision: 'deny', layer: 'off' });
    expect(await h.setEnabled(OWNER, { botId: BOT, enabled: true })).toEqual({ ok: true });
    expect(run('ls')).toMatchObject({ ok: true });
  });

  it('a rules file of another version turns every bot\'s commands off', () => {
    const file = botCommandRulesPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, bots: {} }));
    expect(new BotCommandRulesStore(file).commandsEnabled(BOT)).toBe(false);
  });
});
