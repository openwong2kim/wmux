// The owner's decision log: one file per bot, the newest
// BOT_COMMAND_LOG_LIMIT decisions kept, masked when written and again when
// read, a missing or foreign file read as empty (and a foreign one never
// written over), and a removed bot's file deleted. logBotExecDecision hands
// every decision to it through the sink.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_COMMAND_LOG_LIMIT } from '../../../shared/botCommand';
import { BOT_COMMAND_LOG_VERSION, BotCommandLog, botCommandLogDir, botCommandLogFile } from '../botCommandLog';
import { logBotExecDecision, setBotExecDecisionSink, type BotExecDecisionRecord } from '../botExec';
import { __resetRedactedSecretsForTesting, setRedactedSecrets } from '../secretRedaction';

const A = 'bot-0000000a';
const B = 'bot-0000000b';
let dir = '';
let clock = 1_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-command-log-'));
  clock = 1_000;
});
afterEach(() => {
  setBotExecDecisionSink(null);
  __resetRedactedSecretsForTesting();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const newLog = () => new BotCommandLog(dir, () => clock++);
const deny = (target: string, layer = 'unlisted', reason = 'not on the list'): BotExecDecisionRecord => ({ tool: 'Bash', decision: 'deny', layer, reason, target });

describe('the decision log', () => {
  it('is empty for a bot with no file, and for an id that is not a bot\'s', () => {
    const log = newLog();
    expect(log.entries(A)).toEqual([]);
    expect(log.record('../x', deny('ls'))).toBeNull();
    expect(botCommandLogFile(dir, '../x')).toBeNull();
  });

  it('keeps the newest decisions only, newest first, on disk too', async () => {
    const log = newLog();
    for (let k = 0; k < BOT_COMMAND_LOG_LIMIT + 5; k++) log.record(A, deny(`cmd${k}`));
    await log.settled();
    const shown = log.entries(A);
    expect(shown).toHaveLength(BOT_COMMAND_LOG_LIMIT);
    expect(shown[0].target).toBe(`cmd${BOT_COMMAND_LOG_LIMIT + 4}`);
    expect(shown.at(-1)?.target).toBe('cmd5');
    const raw = JSON.parse(fs.readFileSync(botCommandLogFile(dir, A) as string, 'utf8'));
    expect(raw.version).toBe(BOT_COMMAND_LOG_VERSION);
    expect(raw.entries).toHaveLength(BOT_COMMAND_LOG_LIMIT);
    // A new instance (a restart) reads the same log back.
    expect(newLog().entries(A).map((e) => e.target)).toEqual(shown.map((e) => e.target));
  });

  it('keeps each bot\'s decisions apart', async () => {
    const log = newLog();
    log.record(A, deny('make'));
    log.record(B, { tool: 'Write', decision: 'allow', layer: 'path', target: '/b/notes.md' });
    await log.settled();
    expect(log.entries(A).map((e) => e.target)).toEqual(['make']);
    expect(log.entries(B)).toEqual([expect.objectContaining({ tool: 'Write', decision: 'allow', layer: 'path', target: '/b/notes.md' })]);
    expect(log.entry(B, log.entries(A)[0].id)).toBeNull();
  });

  it('masks a stored secret when it writes, and one stored since when it reads', async () => {
    setRedactedSecrets([{ name: 'GH', value: 'ghp_first_secret_value_1' }]);
    const log = newLog();
    log.record(A, deny('curl -H ghp_first_secret_value_1', 'floor', 'ghp_first_secret_value_1 is refused'));
    log.record(A, deny('echo late_secret_value_22'));
    await log.settled();
    const disk = fs.readFileSync(botCommandLogFile(dir, A) as string, 'utf8');
    expect(disk).not.toContain('ghp_first_secret_value_1');
    expect(disk).toContain('[secret:GH]');
    setRedactedSecrets([{ name: 'GH', value: 'ghp_first_secret_value_1' }, { name: 'LATE', value: 'late_secret_value_22' }]);
    const shown = JSON.stringify(log.entries(A));
    expect(shown).not.toContain('late_secret_value_22');
    expect(shown).toContain('[secret:LATE]');
  });

  it('keeps a reviewer\'s verdict with its risk and rationale, the rationale masked', async () => {
    setRedactedSecrets([{ name: 'GH', value: 'ghp_first_secret_value_1' }]);
    const log = newLog();
    log.record(A, { tool: 'Bash', decision: 'deny', layer: 'reviewer', target: 'touch a', reason: 'reviewer_deny: …', review: { code: 'reviewer_deny', risk: 'medium', rationale: 'mentions ghp_first_secret_value_1', latencyMs: 40 } });
    await log.settled();
    expect(newLog().entries(A)[0].review).toEqual({ code: 'reviewer_deny', risk: 'medium', rationale: 'mentions [secret:GH]', latencyMs: 40 });
  });

  it('masks anything shaped like a credential, not only stored secrets', async () => {
    const log = newLog();
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3QifQ.c2lnbmF0dXJlX3Rlc3Q';
    const key = 'sk-ant-api03-AbCdEf0123456789GhIjKl0123456789MnOpQr';
    log.record(A, deny(`curl -H 'Authorization: ${bearer}' x`, 'floor'));
    log.record(A, deny(`tool --api-key ${key}`, 'unlisted', `refused ${key}`));
    await log.settled();
    const disk = fs.readFileSync(botCommandLogFile(dir, A) as string, 'utf8');
    const shown = JSON.stringify(log.entries(A));
    for (const text of [disk, shown, JSON.stringify(newLog().entries(A))]) {
      expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(text).not.toContain(key);
      expect(text).toContain('[redacted]');
    }
  });

  it('a write scheduled for a folder that is gone settles quietly (logged, never an unhandled rejection)', async () => {
    const gone = path.join(dir, 'gone');
    const log = new BotCommandLog(gone);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A file where the folder would be: every write under it fails.
    fs.writeFileSync(gone, 'not a folder');
    expect(log.record(A, deny('ls'))).not.toBeNull();
    await log.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('bot command log of bot-0000000a not written'))).toBe(true);
    expect(log.entries(A)).toHaveLength(1);
  });

  it('reads a file of another version as empty and never writes over it', async () => {
    const file = botCommandLogFile(dir, A) as string;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [{ id: 'x' }] }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = newLog();
    expect(log.entries(A)).toEqual([]);
    log.record(A, deny('ls'));
    await log.settled();
    expect(log.entries(A)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(99);
  });

  it('drops malformed entries on load', () => {
    const file = botCommandLogFile(dir, A) as string;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: BOT_COMMAND_LOG_VERSION, entries: [{ id: 'a', at: 1, tool: 'Bash', decision: 'deny', layer: 'floor', target: 'sudo ls' }, { id: 'b', tool: 'Rm' }, null] }));
    expect(newLog().entries(A)).toEqual([{ id: 'a', at: 1, tool: 'Bash', decision: 'deny', layer: 'floor', target: 'sudo ls' }]);
  });

  it('deletes a removed bot\'s log and its backup, and the logs of bots gone while wmux was not running', async () => {
    const log = newLog();
    log.record(A, deny('a1'));
    await log.settled();
    log.record(A, deny('a2'));
    log.record(B, deny('b1'));
    await log.remove(A);
    await log.settled();
    expect(fs.existsSync(botCommandLogFile(dir, A) as string)).toBe(false);
    expect(fs.existsSync(`${botCommandLogFile(dir, A)}.bak`)).toBe(false);
    expect(newLog().entries(A)).toEqual([]);
    expect(fs.existsSync(botCommandLogFile(dir, B) as string)).toBe(true);
    expect(newLog().forgetRemoved((id) => id !== B)).toBe(1);
    expect(fs.readdirSync(botCommandLogDir(dir)).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('gets every decision logBotExecDecision makes, through the sink', async () => {
    const log = newLog();
    setBotExecDecisionSink((botId, rec) => {
      log.record(botId, rec);
    });
    logBotExecDecision(A, 'Bash', { ok: false, layer: 'unlisted', reason: 'make is not on the built-in list', command: 'make' }, () => undefined);
    logBotExecDecision(A, 'Edit', { ok: true, layer: 'path', input: { file_path: '/bot/a.md' } }, () => undefined);
    expect(log.entries(A)).toEqual([
      expect.objectContaining({ tool: 'Edit', decision: 'allow', layer: 'path', target: '/bot/a.md' }),
      expect.objectContaining({ tool: 'Bash', decision: 'deny', layer: 'unlisted', target: 'make', reason: 'make is not on the built-in list' }),
    ]);
    await log.settled();
  });
});
