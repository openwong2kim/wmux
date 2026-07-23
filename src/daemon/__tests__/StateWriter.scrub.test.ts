import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scrubPersistedCredentials } from '../StateWriter';

// PR2 boot migration: scrub credential values from existing sessions.json primary + .bak
// slots while remaining total and non-throwing — never lose sessions.
describe('scrubPersistedCredentials', () => {
  let dir: string;
  const primary = (): string => path.join(dir, 'sessions.json');
  const readSessions = (file: string): Array<{ id: string; env?: Record<string, unknown> }> =>
    JSON.parse(fs.readFileSync(file, 'utf-8')).sessions;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-scrub-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips credential values from primary file while preserving non-credential env and sessions', () => {
    fs.writeFileSync(primary(), JSON.stringify({
      version: 1,
      sessions: [
        { id: 'a', env: { PATH: '/usr/bin', WMUX_SURFACE_ID: 's1', GITHUB_TOKEN: 'ghp', KAD_GATEWAY_KEY: 'sec' } },
        { id: 'b', env: { PATH: '/bin' } },
      ],
    }));
    scrubPersistedCredentials(dir);
    const sessions = readSessions(primary());
    expect(sessions).toHaveLength(2);               // sessions preserved
    expect(sessions[0].env!.PATH).toBe('/usr/bin'); // non-credential preserved
    expect(sessions[0].env!.WMUX_SURFACE_ID).toBe('s1');
    expect(sessions[0].env!.GITHUB_TOKEN).toBeUndefined(); // credential removed
    expect(sessions[0].env!.KAD_GATEWAY_KEY).toBeUndefined();
    expect(sessions[1].env!.PATH).toBe('/bin');
  });

  it('scrubs .bak slot too', () => {
    const bak = `${primary()}.bak`;
    fs.writeFileSync(bak, JSON.stringify({
      version: 1, sessions: [{ id: 'a', env: { PATH: '/p', ANTHROPIC_API_KEY: 'sk' } }],
    }));
    // Each slot is independent — .bak is processed even without primary file
    scrubPersistedCredentials(dir);
    expect(readSessions(bak)[0].env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(readSessions(bak)[0].env!.PATH).toBe('/p');
  });

  it('replaces non-object env with {} but does not drop sessions (blocks credential string hiding)', () => {
    fs.writeFileSync(primary(), JSON.stringify({
      version: 1,
      sessions: [
        { id: 'a', env: null },                       // null → {}
        { id: 'b' },                                  // no env → unchanged
        { id: 'c', env: 'GITHUB_TOKEN=ghp_leak' },    // string (credential hiding) → {}
        { id: 'd', env: { API_KEY: 'x', PATH: '/p' } },
      ],
    }));
    expect(() => scrubPersistedCredentials(dir)).not.toThrow();
    const sessions = readSessions(primary());
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']); // all preserved
    expect(sessions[0].env).toEqual({});              // null → {}
    expect('env' in sessions[1]).toBe(false);         // session without env unchanged
    expect(sessions[2].env).toEqual({});              // credential string removed
    expect(sessions[3].env!.API_KEY).toBeUndefined();
    expect(sessions[3].env!.PATH).toBe('/p');
  });

  it('does not throw on missing or corrupt JSON and continues processing other slots', () => {
    // Primary corrupted, .bak valid — .bak must be scrubbed, no throw overall
    fs.writeFileSync(primary(), '{ this is not json');
    fs.writeFileSync(`${primary()}.bak`, JSON.stringify({
      version: 1, sessions: [{ id: 'a', env: { GH_TOKEN: 't', HOME: '/h' } }],
    }));
    expect(() => scrubPersistedCredentials(dir)).not.toThrow();
    expect(readSessions(`${primary()}.bak`)[0].env!.GH_TOKEN).toBeUndefined();
    expect(readSessions(`${primary()}.bak`)[0].env!.HOME).toBe('/h');
  });

  it('does not touch file when no credentials present (avoids unnecessary rewrite)', () => {
    fs.writeFileSync(primary(), JSON.stringify({ version: 1, sessions: [{ id: 'a', env: { PATH: '/p' } }] }));
    const mtimeBefore = fs.statSync(primary()).mtimeMs;
    scrubPersistedCredentials(dir);
    // changed=false → no rewrite — sessions unchanged
    expect(readSessions(primary())[0].env!.PATH).toBe('/p');
    expect(mtimeBefore).toBeGreaterThan(0);
  });
});
