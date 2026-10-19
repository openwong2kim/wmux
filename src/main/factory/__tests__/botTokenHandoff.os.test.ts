// The bot token hand-off end to end: main writes the token for one spawn,
// the MCP entry's reader consumes it from the argv-named file — with no
// environment variable involved — and anything off yields '' (fail closed).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBotTokenHandoff, botTokenHandoffDir } from '../botTokenHandoff';
import { readBotTokenFromArgv } from '../../../mcp/botTokenHandoff';
import { botArgValue } from '../../../shared/bot';
import { mintBotToken, revokeCommanderToken, botTokenBinding } from '../../deck/commanderTrust';

const BINDING = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'triage' as const };

let dir = '';
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-handoff-'));
  savedEnv = process.env.WMUX_COMMANDER_TOKEN;
  delete process.env.WMUX_COMMANDER_TOKEN;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WMUX_COMMANDER_TOKEN;
  else process.env.WMUX_COMMANDER_TOKEN = savedEnv;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('bot token hand-off', () => {
  it('carries a live bot token to the MCP side without the environment, once', () => {
    const token = mintBotToken(BINDING);
    try {
      const handoff = writeBotTokenHandoff(BINDING, token, { dir });
      const argv = ['node', '/bundle/index.js', ...handoff.mcpArgs];
      expect(botArgValue(argv)).toBe('triage');
      expect(path.dirname(handoff.filePath)).toBe(botTokenHandoffDir(dir));
      expect(process.env.WMUX_COMMANDER_TOKEN).toBeUndefined();

      const read = readBotTokenFromArgv(argv);
      expect(read).toBe(token);
      expect(botTokenBinding(read)).toEqual(BINDING);
      // Consumed: a second reader (or a later process) gets nothing.
      expect(fs.existsSync(handoff.filePath)).toBe(false);
      expect(readBotTokenFromArgv(argv)).toBe('');
      handoff.dispose();
    } finally {
      revokeCommanderToken(token);
    }
  });

  it.skipIf(process.platform === 'win32')('writes the file owner-only', () => {
    const handoff = writeBotTokenHandoff(BINDING, 'tok-1', { dir });
    expect(fs.statSync(handoff.filePath).mode & 0o777).toBe(0o600);
    handoff.dispose();
    expect(fs.existsSync(handoff.filePath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a token file other users can read, and still removes it', () => {
    const file = path.join(dir, 'open.token');
    fs.writeFileSync(file, 'tok-2', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(readBotTokenFromArgv(['--bot=lead', `--bot-token-file=${file}`])).toBe('');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('yields an empty token for no flag, a missing file, an empty or malformed file', () => {
    expect(readBotTokenFromArgv(['--bot=lead'])).toBe('');
    expect(readBotTokenFromArgv(['--bot=lead', `--bot-token-file=${path.join(dir, 'nope')}`])).toBe('');
    const empty = path.join(dir, 'empty.token');
    fs.writeFileSync(empty, '', { mode: 0o600 });
    expect(readBotTokenFromArgv([`--bot-token-file=${empty}`])).toBe('');
    const junk = path.join(dir, 'junk.token');
    fs.writeFileSync(junk, 'a b\nc', { mode: 0o600 });
    expect(readBotTokenFromArgv([`--bot-token-file=${junk}`])).toBe('');
  });

  it('never reads the environment token in bot mode', () => {
    process.env.WMUX_COMMANDER_TOKEN = 'env-token';
    expect(readBotTokenFromArgv(['--bot=lead'])).toBe('');
  });

  it('refuses a malformed binding or an empty token', () => {
    expect(() => writeBotTokenHandoff({ ...BINDING, botId: 'x' }, 'tok', { dir })).toThrow();
    expect(() => writeBotTokenHandoff(BINDING, '', { dir })).toThrow();
  });
});
