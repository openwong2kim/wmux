import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Local PTY mode reads the Claude file send setting (shared/claudeFileSend.ts)
// from the wmux data dir at each spawn and adds the variable only when it is on.
const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn((_cmd: string, _args: string[], _opts: { env?: Record<string, string> }) =>
    ({ pid: 4322, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn() })),
}));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
import { PTYManager } from '../PTYManager';
import { getWmuxDir } from '../../../daemon/config';
import { CLAUDE_FILE_SEND_ENV } from '../../../shared/claudeFileSend';
import { claudeFileSendPath } from '../../../daemon/claudeFileSendSetting';

describe('PTYManager Claude file send', () => {
  let tmp: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ptymgr-filesend-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    spawn.mockClear();
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const spawnedEnv = (): Record<string, string> | undefined => spawn.mock.calls.at(-1)?.[2]?.env;

  it('adds the variable to a new pane only while the setting is on', () => {
    const manager = new PTYManager();
    try {
      manager.create({});
      expect(spawnedEnv()?.[CLAUDE_FILE_SEND_ENV]).toBeUndefined();

      fs.mkdirSync(getWmuxDir(), { recursive: true });
      fs.writeFileSync(claudeFileSendPath(getWmuxDir()), JSON.stringify({ enabled: true }));
      manager.create({});
      expect(spawnedEnv()?.[CLAUDE_FILE_SEND_ENV]).toBe('1');

      fs.writeFileSync(claudeFileSendPath(getWmuxDir()), JSON.stringify({ enabled: false }));
      manager.create({});
      expect(spawnedEnv()?.[CLAUDE_FILE_SEND_ENV]).toBeUndefined();
    } finally { manager.disposeAll(); }
  });
});
