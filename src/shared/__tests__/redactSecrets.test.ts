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
    // RFC 3986 sub-delims in the password are part of it, never a reason to leave it whole.
    for (const pw of ['pa;ss', 'pa,ss', 'pa(ss)', 'pa;ss(1),x']) {
      expect(redactSecrets(`db ${url('app', pw, 'h/x')} ok`)).toBe(`db ${url('app', REDACTED, 'h/x')} ok`);
    }
    // A raw `@` in the password: all of it goes, up to the last `@` before the host.
    expect(redactSecrets(`db ${url('app', 'p@ss', 'db.local/x')} ok`)).toBe(`db ${url('app', REDACTED, 'db.local/x')} ok`);
    expect(redactSecrets(url('app', 'a@b@c', 'h'))).toBe(url('app', REDACTED, 'h'));
  });

  it('readableNames keeps branch names, paths and ids that the long-token rule takes, and still masks a bare key', () => {
    for (const s of ['feat/p1-7-remote-handoff-v2', 'src/daemon/a2aRemote/spawnRequester.ts', 'fix-login-redirect-2026-10-24', 'src/renderer/components/Pane/UsageLimitCard.tsx', 'scripts/rust-terminal-core-bench.mjs']) {
      expect(redactSecretsCounted(s, { readableNames: true })).toEqual({ text: s, masked: 0 });
    }
    expect(redactSecrets('feat/p1-7-remote-handoff-v2')).toBe(REDACTED);
    const bare = 'xK9mQ2pL7vR4nT8wZ3yB6cF1hJ5';
    expect(redactSecretsCounted(`Authorization: Bearer ${bare}`, { readableNames: true }).text).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecretsCounted(`cookie sid=${bare}; path=/`, { readableNames: true }).text).toBe(`cookie ${REDACTED}; path=/`);
    const b64 = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IGxpbmUgMTIzNDU2Nzg5MA==';
    expect(redactSecretsCounted(b64, { readableNames: true }).text).toBe(REDACTED);
  });

  it('readableNames scores the whole run too: a token split into short parts does not pass', () => {
    // Built at run time: no credential-shaped literal in the source.
    for (const token of [['tAnLEMyQw2Fw', '8yxjKN9mec23', 'RRrgBvc2W9dw', 'x1'].join('-'), ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'), 'k3j4h5g6f7d8s9a0q1w2e3r4t5', '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b']) {
      expect(redactSecretsCounted(`use ${token} now`, { readableNames: true }).text).toBe(`use ${REDACTED} now`);
    }
  });

  it('hex keys: 32 and 64 digits are always masked; a 40-digit commit stays readable unless a key word sits before it', () => {
    const hex = (n: number) => Array.from({ length: n }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
    for (const n of [32, 48, 64]) {
      expect(redactSecretsCounted(`k ${hex(n)} k`, { readableNames: true }).text).toBe(`k ${REDACTED} k`);
      expect(redactSecrets(`k ${hex(n)} k`)).toBe(`k ${REDACTED} k`);
      expect(redactSecrets(`k ${hex(n).toUpperCase()} k`)).toBe(`k ${REDACTED} k`);
    }
    const sha = hex(40);
    expect(redactSecretsCounted(`commit ${sha} landed`, { readableNames: true }).text).toBe(`commit ${sha} landed`);
    expect(redactSecretsCounted(`api token: ${sha}`, { readableNames: true }).text).toBe(`api token: ${REDACTED}`);
    expect(redactSecretsCounted(`Bearer ${sha}`, { readableNames: true }).text).toBe(`Bearer ${REDACTED}`);
    // The default path too: a report naming a commit keeps it; a token named as one does not.
    expect(redactSecrets(`merged as ${sha}`)).toBe(`merged as ${sha}`);
    expect(redactSecrets(`token: ${sha}`)).toBe(`token: ${REDACTED}`);
    // All digits, all letters or mixed case: not a hex key.
    for (const s of ['1'.repeat(40), 'a'.repeat(40), `${hex(20)}${hex(20).toUpperCase()}`]) {
      expect(redactSecretsCounted(s, { readableNames: true }).text).toBe(s);
    }
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

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/eval_cases_test.go, fieldvalue_test.go, digest_test.go), MIT
describe('redactSecrets — credential forms', () => {
  // Built at run time: no credential-shaped literal in the source.
  const run = (n: number) => 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7'.repeat(4).slice(0, n);
  const pem = (label: string) => [`-----BEGIN ${label}-----`, 'bG9yZW0gaXBzdW0', `-----END ${label}-----`].join('\n');

  it.each([
    ['DB_PASS=hunter22x', `DB_PASS=${REDACTED}`],
    ['SERVICE_X_KEY=abc123def456', `SERVICE_X_KEY=${REDACTED}`],
    ['groqAPIKey = "abc123def456"', `groqAPIKey = "${REDACTED}"`],
    ['API Key: abc123def456', `API Key: ${REDACTED}`],
    ['password: "correcthorse battery"', `password: "${REDACTED}"`],
    ['password=12345678', `password=${REDACTED}`],
    ['{"key": "AbC123dEf456GhI789xyz"}', `{"key": "${REDACTED}"}`],
    ['{\\"access_token\\":\\"abc123def456\\"}', `{\\"access_token\\":\\"${REDACTED}\\"}`],
    ['UI_PASSWORD= UI_TOKEN=t0k3nValue2', `UI_PASSWORD= UI_TOKEN=${REDACTED}`],
    ['secret.txt:hunter2pass9', `secret.txt:${REDACTED}`],
    ['a=1\\nSECRET_TOKEN=abc123def456', `a=1\\nSECRET_TOKEN=${REDACTED}`],
    ['POST /login {"password":"hunter2SECRET"}', `POST /login {"password":"${REDACTED}"}`],
    ['password: abc$def(1)xy', `password: ${REDACTED}`],
    ['AWS_SECRET_ACCESS_KEY=abc123def456', `AWS_SECRET_ACCESS_KEY=${REDACTED}`],
    ["apiKey: 'sk-ant-api03-test'", `apiKey: '${REDACTED}'`],
  ])('masks a value by its field name: %s', (input, want) => {
    expect(redactSecrets(input)).toBe(want);
  });

  it.each([
    ['Authorization: Basic dXNlcjpwYXNz', `Authorization: Basic ${REDACTED}`],
    ['Authorization: Bearer abcd1234efgh', `Authorization: Bearer ${REDACTED}`],
    ['authorization: abcd1234efgh', `authorization: ${REDACTED}`],
    ['  Proxy-Authorization: Basic dXNlcjpwYXNz', `  Proxy-Authorization: Basic ${REDACTED}`],
    ['> Authorization: Bearer abcd1234efgh', `> Authorization: Bearer ${REDACTED}`],
    ['Authorization: Digest username="u", nonce="n1", response="r2"', `Authorization: Digest ${REDACTED}`],
    ['Cookie: sid=abc123def456', `Cookie: ${REDACTED}`],
    ['Cookie: a=1; sid=abc123def456; theme=dark', `Cookie: ${REDACTED}`],
    ['< Set-Cookie: sid=abc123def456; Path=/; HttpOnly', `< Set-Cookie: ${REDACTED}`],
    [`curl -H 'Authorization: Bearer abcd1234efgh' -H 'Cookie: sid=abc123def456' https://h/x`, `curl -H 'Authorization: Bearer ${REDACTED}' -H 'Cookie: ${REDACTED}' https://h/x`],
    ['{"Authorization": "Bearer abcd1234efgh", "Accept": "*/*"}', `{"Authorization": "Bearer ${REDACTED}", "Accept": "*/*"}`],
    [`{'Cookie': "sid=abc123def456"}`, `{'Cookie': "${REDACTED}"}`],
  ])('masks a header value whole: %s', (input, want) => {
    expect(redactSecrets(input)).toBe(want);
    expect(redactSecretsCounted(input, { readableNames: true }).text).toBe(want);
  });

  it.each([
    ['비밀번호: hunter22x', `비밀번호: ${REDACTED}`],
    ['비밀번호는 hunter22x입니다', `비밀번호는 ${REDACTED}입니다`],
    ['비밀번호 hunter22x', `비밀번호 ${REDACTED}`],
    ['패스워드: 1234', `패스워드: ${REDACTED}`],
    ['토큰은 abc123def456', `토큰은 ${REDACTED}`],
    ['API 키: abcd1234efgh', `API 키: ${REDACTED}`],
    ['密码：hunter22x。', `密码：${REDACTED}。`],
    ['密碼是 hunter22x.', `密碼是 ${REDACTED}.`],
    ['服务器密码是 Qw8!zLp3mN，用完记得改掉', `服务器密码是 ${REDACTED}，用完记得改掉`],
    ['密钥为12231241', `密钥为${REDACTED}`],
    ['令牌是 abc123def456', `令牌是 ${REDACTED}`],
    ['パスワードは hunter22x', `パスワードは ${REDACTED}`],
    ['token 是 abc123def456', `token 是 ${REDACTED}`],
    ['API Key：abc123def456', `API Key：${REDACTED}`],
    ['密码："correct horse"', `密码："${REDACTED}"`],
  ])('masks a value after its name in Chinese, Japanese or Korean: %s', (input, want) => {
    expect(redactSecrets(input)).toBe(want);
  });

  it('recognises more vendor key shapes, with readable names too', () => {
    const keys = [
      `hf_${run(34)}`, `gsk_${run(52)}`, `xai-${run(60)}`, `pypi-${run(60)}`,
      `dop_v1_${'0123456789abcdef'.repeat(4)}`, ['SG', run(22), run(43)].join('.'), `oc_sk_${run(24)}`, `ark-${run(20)}`,
    ];
    for (const key of keys) {
      expect(redactSecrets(`use ${key} now`)).toBe(`use ${REDACTED} now`);
      expect(redactSecretsCounted(`use ${key} now`, { readableNames: true }).text).toBe(`use ${REDACTED} now`);
    }
  });

  it('masks a vendor key whole when a part of it reads as hex, or a longer run goes on from it', () => {
    const hex = 'abc123'.repeat(8).slice(0, 43);
    expect(redactSecrets(['SG', run(22), hex].join('.'))).toBe(REDACTED);
    expect(redactSecrets(`hf_${run(34)}.${run(12)}`)).toBe(REDACTED);
  });

  it('masks a private key block whole, whatever its label', () => {
    for (const label of ['PGP PRIVATE KEY BLOCK', 'RSA PRIVATE KEY', 'X448 PRIVATE KEY', 'PRIVATE KEY']) {
      expect(redactSecrets(`before\n${pem(label)}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    }
  });
});

describe('redactSecrets — ordinary text stays as written', () => {
  const sha256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const ordinary = [
    // Names that hold no secret.
    'keyboard: enabled-mode',
    'keyword = terminalAgent',
    'monkey: bananas-and-more',
    'hotkey: ctrl+shift+p',
    '"tokenCount": 12345678',
    'max_tokens: 12345678',
    '"token_type": "bearer-token"',
    '"next_page_token": "abc123def456"',
    '{"cache_key": "a1b2c3d4e5f60718293a"}',
    'SORT_KEY=abc123def456',
    'public_key: abc123def456',
    '{"key": "5d41402abc4b2a76"}',
    '{"key": "some-value-here"}',
    'PWD=/somewhere/deep/inside',
    // Code naming a value.
    'const key = getApiKeyFromEnvironment()',
    'token: process.env.GITHUB_TOKEN',
    'const accessToken2 = refreshToken2;',
    'let secretV2 = loadSecretV2;',
    'secretKey:=base64Encode(raw)',
    'password = hashPassword256;',
    'self.token = generate_token_v2',
    '  secret: env.SECRET_V2',
    'access_token = get_access_token_v2',
    'secretKey: Uint8Array;',
    'token: ${{ secrets.GH_TOKEN }}',
    'password: ${DB_PASSWORD}',
    'token: <your-token-here>',
    "credentials: 'same-origin',",
    'token:\n  type: string-value',
    "password: 'Password must be at least 8 characters'",
    // Places: a file and line, a path, a skill.
    'internal/auth/token.go:L643-669.',
    'src/secret_store.ts:L643-669. and L12-40',
    'src/credentials.py:L12-L40',
    'PRIVATE_KEY_PATH=~/.ssh/id_ed25519',
    '/secret-scan:audit-x7k2p9q1',
    // Versions and moments.
    '"js-tokens": "^4.0.0-beta.1"',
    'jsonwebtoken = "9.2.0-beta1"',
    '"access_token_expires_at": "2026-08-30T11:44:31.312645+08:00",',
    'token_expiry: 2026-08-30T11:44:31',
    // An empty field before the next one.
    'env -i UI_PASSWORD= UI_ADDR=127.0.0.1:39117 ./syncer serve',
    // Headers in prose, code and docs.
    'Authorization: the user must sign in first',
    'Authorization: Bearer <token>',
    'Authorization: Bearer $TOKEN',
    'Authorization: Bearer YOUR_API_TOKEN',
    'Authorization: Bearer accessToken',
    'Authorization: authorizationHeader,',
    'Authorization: `Bearer ${token}`',
    'authorization: `Bearer ${String(this.deps.relaySecret)}`,',
    "extra: 'Authorization: Bearer forged\\r\\n'",
    '{ secret: \'never expose\' }',
    'key: `${name} ${where}`,',
    '"Authorization": "Bearer " + token',
    'Authorization: admin-only-access',
    'Cookie: chocolate chip recipe',
    'Cookie: note that a=b here',
    'cookie: document.cookie',
    // Named digests.
    `sha256:${sha256}`,
    `sha256: ${sha256}`,
    `image@sha256:${sha256}`,
    `sha256-${sha256}`,
    'integrity sha512-oYp4Zq1m3Vb2xGQ9nKfL7hT0sR8uWdE5yC6aJ1iM3pX==',
    'h1:Xr3Ez0pQkE9yJ5m2Lq7sT1vU8wN4oB6cD0fG2hI3jK4=',
    // A page's address, a project's name.
    'sk-hynix-third-quarter-profit',
    "token: 'test-token-123',",
    'ark-survival-evolved-server',
    // Chinese, Japanese and Korean prose.
    '비밀번호를 변경하세요',
    '비밀번호 reset 메일을 보냈습니다',
    '암호화 알고리즘은 AES256',
    '암호 AES256',
    '토큰 1234개',
    '토큰 수: 12345',
    '토큰 claude-3-5-sonnet',
    '密码 reset 了',
    '密钥为 2048 位',
    '令牌 300000 毫秒',
    '私钥 ~/.ssh/id_ed25519',
    '令牌是 2026-08-30T11:44:31',
    '密码是 ${DB_PASS}',
    '请帮我把这个函数改成异步的，并且加上错误处理和单元测试。',
    'token 是 expired',
    'key 是 value',
  ];

  it.each(ordinary)('leaves it alone: %s', (s) => {
    expect(redactSecrets(s)).toBe(s);
    expect(redactSecretsCounted(s, { readableNames: true })).toEqual({ text: s, masked: 0 });
  });

  // The long-token rule takes any long run with digits in it by default; only
  // readableNames keeps these.
  it.each([
    'max_tokens=max_tokens_v3',
    'token_dir=/private/tmp/some-folder/skill-v2',
    '--token-file=/tmp/some-folder/token',
    'cnbc.com/2026/sk-hynix-third-quarter-profit.html',
  ])('readableNames leaves it alone: %s', (s) => {
    expect(redactSecretsCounted(s, { readableNames: true })).toEqual({ text: s, masked: 0 });
  });

  it('still masks a digest-sized hex run with no algorithm, or the wrong length for it', () => {
    expect(redactSecrets(`k ${sha256} k`)).toBe(`k ${REDACTED} k`);
    expect(redactSecrets(`sha256:${sha256.slice(0, 48)}`)).toBe(`sha256:${REDACTED}`);
    expect(redactSecrets(`token: sha256:${sha256}`)).toBe(`token: ${REDACTED}`);
  });
});

describe('redactSecrets — fixed point and cost', () => {
  it('a second pass changes nothing and counts nothing', () => {
    const inputs = [
      'DB_PASS=hunter22x', 'Authorization: Basic dXNlcjpwYXNz', 'Cookie: sid=abc123def456', 'Authorization: Bearer abcd1234efgh ok',
      '비밀번호: hunter22x', '비밀번호는 hunter22x입니다', 'API 키: abcd1234efgh', '密码：hunter22x。', 'パスワードは hunter22x', '密码："correct horse"',
      'password: "correcthorse battery"', 'token=abc123def456.tail', 'keyboard: enabled-mode', '"tokenCount": 12345678',
      `curl -H 'Authorization: Bearer abcd1234efgh' -H 'Cookie: sid=abc123def456' https://h/x`, 'Authorization: Digest username="u", nonce="n1"',
      'UI_PASSWORD= UI_TOKEN=t0k3nValue2', 'postgres://app:hunter2pw@db.local:5432/x?token=abc',
    ];
    for (const s of inputs) {
      for (const opts of [{}, { readableNames: true }]) {
        const once = redactSecretsCounted(s, opts).text;
        expect(redactSecretsCounted(once, opts)).toEqual({ text: once, masked: 0 });
      }
    }
  });

  it('counts a masked header or named value once', () => {
    expect(redactSecretsCounted('Authorization: Bearer abcd1234efgh').masked).toBe(1);
    expect(redactSecretsCounted('Cookie: a=1; sid=abc123def456; theme=dark').masked).toBe(1);
    expect(redactSecretsCounted('비밀번호: hunter22x').masked).toBe(1);
  });

  it.each([
    'a', 'a-', 'a.', 'a ', 'A1', 'key', 'key=', 'key-', 'key:', 'key = ', 'key: "', 'key:"\\a', "key:'", 'token', 'token:', 'password ', 'password: "',
    '-', '_', '.', ' ', '\t', '\n', ':', '=', '"', "'", '\\', '\\"', '_KEY=', 'A_', '_PASS', '_pass:', 'x_sk_', 'ab_sk_a',
    'Authorization: ', '"Authorization', '"Authorization: ', '"Authorization: \\a', 'authorization', 'Authorization: x\n', 'Cookie: a=b; ', 'Cookie: ', 'Cookie:\n',
    'eyJ-', 'eyJ.', 'sk-', 'ark-', 'hf_', 'gsk_', 'xai-', 'pypi-', 'dop_v1_', 'SG.', 'SG.a', 'x://', 'a://b:', 'a://b:c@', 'a://b:c@d@', '?token=',
    '密码', '密码：', '密码："', '비밀번호', '비밀번호 ', '토큰은 a', 'パスワード', 'key 是 ', 'token：', '0', 'f', 'sha256:', 'sha256-', 'h1:', '-----BEGIN ', '-----BEGIN A ',
    '-----BEGIN PRIVATE KEY-----', '[redacted]', 'wmuxguest~', 'wmuxguest~a-',
  ])('takes well under a second on 1 MB of %j', (unit) => {
    const hostile = unit.repeat(Math.ceil((1 << 20) / unit.length)).slice(0, 1 << 20);
    const started = performance.now();
    redactSecrets(hostile);
    redactSecretsCounted(hostile, { readableNames: true });
    // Two passes; on a loaded CI machine a linear pass is still far below this.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
