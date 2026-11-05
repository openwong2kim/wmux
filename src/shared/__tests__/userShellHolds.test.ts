import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUserShellHolds, readUserShellHolds, userShellHoldsContent, USER_SHELL_HOLDS_MAX } from '../userShellHolds';

// #3049 — the hold list main writes and the daemon reads at boot: ids only,
// and anything unreadable holds nothing (recovery as it was).
describe('user shell hold list', () => {
  it('round-trips the ids main writes', () => {
    const content = userShellHoldsContent(['daemon-a', 'daemon-b']);
    expect(content).toEqual({ version: 1, ids: ['daemon-a', 'daemon-b'] });
    expect([...parseUserShellHolds(JSON.stringify(content))]).toEqual(['daemon-a', 'daemon-b']);
  });

  it('holds nothing for garbage, and skips what is not a session id', () => {
    expect(parseUserShellHolds('not json').size).toBe(0);
    expect(parseUserShellHolds('null').size).toBe(0);
    expect(parseUserShellHolds('{"ids":"daemon-a"}').size).toBe(0);
    expect([...parseUserShellHolds(JSON.stringify({ ids: ['daemon-a', '../etc', 42, 'x'.repeat(65)] }))]).toEqual(['daemon-a']);
  });

  it('caps the list', () => {
    const ids = Array.from({ length: USER_SHELL_HOLDS_MAX + 5 }, (_, i) => `daemon-${i}`);
    expect(parseUserShellHolds(JSON.stringify({ version: 1, ids })).size).toBe(USER_SHELL_HOLDS_MAX);
  });

  it('a missing file holds nothing', () => {
    expect(readUserShellHolds(path.join(os.tmpdir(), `wmux-no-holds-${process.pid}-${Date.now()}.json`)).size).toBe(0);
  });

  it('reads the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-holds-'));
    try {
      const file = path.join(dir, 'user-shell-holds.json');
      fs.writeFileSync(file, JSON.stringify(userShellHoldsContent(['daemon-a'])));
      expect([...readUserShellHolds(file)]).toEqual(['daemon-a']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
