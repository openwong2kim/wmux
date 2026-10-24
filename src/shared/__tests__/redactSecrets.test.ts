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

describe('redactSecrets — URLs, readable names and the masked count', () => {
  // Built at run time: no credential-shaped literal in the source.
  const url = (user: string, pw: string, rest: string) => `postgres://${user}:${pw}@${rest}`;

  it('masks the password of a URL\'s userinfo and keeps the user, the host and the rest', () => {
    expect(redactSecrets(`db ${url('app', 'hunter2pw', 'db.local:5432/x')} ok`)).toBe(`db ${url('app', REDACTED, 'db.local:5432/x')} ok`);
    expect(maskInlineCredentials(url('u', 'p', 'h'))).toBe(url('u', REDACTED, 'h'));
    // Already masked, a port, a user with no password: unchanged.
    expect(redactSecrets(url('app', REDACTED, 'h'))).toBe(url('app', REDACTED, 'h'));
    expect(redactSecrets('https://example.com:8443/a@b')).toBe('https://example.com:8443/a@b');
    expect(redactSecrets('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    // A raw `@` in the password: all of it goes, up to the last `@` before the host.
    expect(redactSecrets(`db ${url('app', 'p@ss', 'db.local/x')} ok`)).toBe(`db ${url('app', REDACTED, 'db.local/x')} ok`);
    expect(redactSecrets(url('app', 'a@b@c', 'h'))).toBe(url('app', REDACTED, 'h'));
  });

  it('readableNames keeps branch names, paths and ids that the long-token rule takes, and still masks a bare key', () => {
    for (const s of ['feat/p1-7-remote-handoff-v2', 'src/daemon/a2aRemote/spawnRequester.ts', 'id 0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b']) {
      expect(redactSecretsCounted(s, { readableNames: true })).toEqual({ text: s, masked: 0 });
    }
    expect(redactSecrets('feat/p1-7-remote-handoff-v2')).toBe(REDACTED);
    const bare = 'xK9mQ2pL7vR4nT8wZ3yB6cF1hJ5';
    expect(redactSecretsCounted(`Authorization: Bearer ${bare}`, { readableNames: true }).text).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecretsCounted(`cookie sid=${bare}; path=/`, { readableNames: true }).text).toBe(`cookie ${REDACTED}; path=/`);
    const b64 = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IGxpbmUgMTIzNDU2Nzg5MA==';
    expect(redactSecretsCounted(b64, { readableNames: true }).text).toBe(REDACTED);
  });

  it('readableNames still masks key shapes, assigned secrets and URL passwords', () => {
    const r = redactSecretsCounted(`branch ${KEYS[1]} token=${'q'.repeat(12)} ${url('a', 'b', 'c')}`, { readableNames: true });
    expect(r.text).toBe(`branch ${REDACTED} token=${REDACTED} ${url('a', REDACTED, 'c')}`);
    expect(r.masked).toBe(3);
  });

  it('a URL inside JSON or a log line never runs into the text after it', () => {
    const line = `{"url":"${url('u', 'p', 'h')}","by":"a@b.c"}`;
    expect(redactSecrets(line)).toBe(`{"url":"${url('u', REDACTED, 'h')}","by":"a@b.c"}`);
    expect(redactSecrets(`(${url('u', 'p', 'h')}), x@y`)).toBe(`(${url('u', REDACTED, 'h')}), x@y`);
  });

  it('masks a key-like user with no password, and keeps a plain one', () => {
    const user = 'Zq8Lp2Xv9KtMnW4Y7cBs';
    expect(redactSecrets(`https://${user}@github.com/o/r`)).toBe(`https://${REDACTED}@github.com/o/r`);
    expect(redactSecrets('https://deploy-bot@example.com/x')).toBe('https://deploy-bot@example.com/x');
  });

  it.each(['access_token', 'api_key', 'apikey', 'password', 'client_secret', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token'])('masks the %s query parameter', (name) => {
    expect(maskInlineCredentials(`https://h/x?a=1&${name}=v4lu3&b=2`)).toBe(`https://h/x?a=1&${name}=${REDACTED}&b=2`);
  });

  it('counts each masked value once, even when two rules take it, and nothing for clean text', () => {
    expect(redactSecretsCounted(`a ${KEYS[0]} b ${KEYS[2]}`).masked).toBe(2);
    // The sk- shape takes the start, the assignment rule the rest: one value, one marker.
    expect(redactSecretsCounted(`token=${KEYS[0]}.tail1234`).masked).toBe(1);
    expect(redactSecretsCounted(`already ${REDACTED} here`).masked).toBe(0);
    expect(redactSecretsCounted('nothing here').masked).toBe(0);
  });
});
