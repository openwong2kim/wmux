import { describe, it, expect } from 'vitest';
import { REDACTED, maskInlineCredentials, redactSecrets, redactSecretsCounted } from '../redactSecrets';

const KEYS = [
  `sk-proj-${'A1b2'.repeat(8)}`,
  `sk-ant-api03-${'x9Y8'.repeat(8)}`,
  `ghp_${'a1B2'.repeat(9)}`,
  `github_pat_11ABCDEFG0${'q1W2'.repeat(6)}`,
  'AKIAIOSFODNN7EXAMPLE',
  'xoxb-123456789012-abcdefghij',
];

describe('redactSecrets', () => {
  it.each(KEYS)('masks %s wherever it sits in text', (key) => {
    const out = redactSecrets(`Error: invalid key ${key} (check your settings)`);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
    expect(out).toContain('Error: invalid key');
  });

  it('masks a value after a secret-like name, a private key block and a random token', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter')).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED);
    expect(redactSecrets('session q8Zr2LpX0vKt9mNw4YcB7sHd ok')).toBe(`session ${REDACTED} ok`);
  });

  it.each([
    'sk-abcdefghijklmnop',
    `ghp_${'a1B2'.repeat(5)}`,
    'xoxb-12345678',
    'auth xK9mQ2pL7vR4nT8wZ3yB6cF1hJ5',
    'TOKEN=xq8Zr2LpX0vKt9mNw4YcB7sHd',
  ])('keeps masking short and x-led values: %s', (s) => {
    const secret = s.split(/[ =]/).at(-1) ?? s;
    expect(redactSecrets(`log ${s} end`)).not.toContain(secret);
  });

  it('masks a token as a whole even when a newer key shape matches its start', () => {
    const token = `sk_live_${'4eC3'.repeat(6)}.Sensitive12`;
    expect(redactSecrets(`log ${token} end`)).toBe(`log ${REDACTED} end`);
  });

  it('masks wmux\'s own guest and peer bearer credentials, whole', () => {
    // Built at run time: no credential-shaped literal in the source.
    for (const prefix of ['wmuxguest', 'wmuxpeer']) {
      const cred = [prefix, '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'abc_DEF-12'].join('~');
      expect(redactSecrets(`Authorization: Bearer ${cred} ok`)).toBe(`Authorization: Bearer ${REDACTED} ok`);
    }
    expect(redactSecrets('the wmuxguest prefix')).toBe('the wmuxguest prefix');
  });

  it('keeps the inline URL credential masking the IPC log uses', () => {
    expect(maskInlineCredentials('http://h/x?token=abc&y=1')).toBe('http://h/x?token=[redacted]&y=1');
    expect(redactSecrets('open http://h/#wmux-desktop-code=zzz')).toContain('wmux-desktop-code=[redacted]');
  });

  it.each([
    'Ready for input',
    'Do you want to proceed? 1. Yes 2. No',
    `Running ${'x'.repeat(100)}`,
    'src/renderer/components/Git/GitDetail.tsx',
    'Esc to interrupt · 12s · ↑ 3.4k tokens',
  ])('leaves ordinary screen text alone: %s', (s) => expect(redactSecrets(s)).toBe(s));
});

describe('redactSecrets — URL passwords and the key-shapes-only variant', () => {
  // Built at run time: no credential-shaped literal in the source.
  const url = (user: string, pw: string, rest: string) => `postgres://${user}:${pw}@${rest}`;

  it('masks the password of a URL\'s userinfo and keeps the user, the host and the rest', () => {
    expect(redactSecrets(`db ${url('app', 'hunter2pw', 'db.local:5432/x')} ok`)).toBe(`db ${url('app', REDACTED, 'db.local:5432/x')} ok`);
    expect(maskInlineCredentials(url('u', 'p', 'h'))).toBe(url('u', REDACTED, 'h'));
    // Already masked, a port, a user with no password: unchanged.
    expect(redactSecrets(url('app', REDACTED, 'h'))).toBe(url('app', REDACTED, 'h'));
    expect(redactSecrets('https://example.com:8443/a@b')).toBe('https://example.com:8443/a@b');
    expect(redactSecrets('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
  });

  it('keyShapesOnly keeps branch names and paths with digits that the long-token rule takes', () => {
    for (const s of ['feat/p1-7-remote-handoff-v2', 'src/daemon/a2aRemote/spawnRequester.ts']) {
      expect(redactSecrets(s)).toBe(REDACTED);
      expect(redactSecretsCounted(s, { keyShapesOnly: true })).toEqual({ text: s, masked: 0 });
    }
  });

  it('keyShapesOnly still masks key shapes, assigned secrets and URL passwords, and counts them', () => {
    const r = redactSecretsCounted(`branch ${KEYS[1]} token=${'q'.repeat(12)} ${url('a', 'b', 'c')}`, { keyShapesOnly: true });
    expect(r.text).toBe(`branch ${REDACTED} token=${REDACTED} ${url('a', REDACTED, 'c')}`);
    expect(r.masked).toBe(3);
  });

  it('counts what the full rules mask and nothing for clean text', () => {
    expect(redactSecretsCounted(`a ${KEYS[0]} b ${KEYS[2]}`).masked).toBe(2);
    expect(redactSecretsCounted('nothing here').masked).toBe(0);
  });
});
