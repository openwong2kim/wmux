import { describe, expect, it } from 'vitest';
import { wslAuthEvidencePlace } from '../wslAuthEvidence';
import { wslAccountHomeKey } from '../../shared/wslAccountHome';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const FOLDER = 'C:\\Users\\me\\.wmux\\accounts\\claude-b';
const TARGET = { distribution: 'Ubuntu', user: 'me' };
const ENV = { CLAUDE_CONFIG_DIR: FOLDER, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' };
const HOME = `/home/me/.wmux/accounts/claude-${wslAccountHomeKey(FOLDER)}`;
const under = (root: string) => ({ transcript_path: `${root}/projects/-home-me-repo/${SID}.jsonl` });

describe('wslAuthEvidencePlace', () => {
  it('names the pane\'s own target when the hook\'s transcript lies under its account home', () => {
    expect(wslAuthEvidencePlace({ wslTarget: TARGET, env: ENV }, SID, under(HOME))).toEqual(TARGET);
  });

  it('(c) is nothing for a claude run on another folder, another session, no target or no path', () => {
    // The distro's own ~/.claude is not the account's home.
    expect(wslAuthEvidencePlace({ wslTarget: TARGET, env: ENV }, SID, under('/home/me/.claude'))).toBeUndefined();
    expect(wslAuthEvidencePlace({ wslTarget: TARGET, env: ENV }, 'other-session', under(HOME))).toBeUndefined();
    expect(wslAuthEvidencePlace({ env: ENV }, SID, under(HOME))).toBeUndefined();
    expect(wslAuthEvidencePlace({ wslTarget: TARGET, env: ENV }, SID, {})).toBeUndefined();
    expect(wslAuthEvidencePlace({ wslTarget: TARGET, env: { CLAUDE_CONFIG_DIR: FOLDER } }, SID, under(HOME))).toBeUndefined();
    expect(wslAuthEvidencePlace({ wslTarget: { ...TARGET, user: 'other' }, env: ENV }, SID, under(HOME))).toBeUndefined();
  });
});
