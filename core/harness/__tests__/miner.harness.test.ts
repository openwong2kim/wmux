// E0 harness — miner verification (spec: engine-core-decision-2026-07-09.md §5-1 pre-check deliverables)
//
// Verifies two axes:
//   (A) .buf real dump raw ANSI preservation — RingBuffer.dumpToFile leaves raw bytes unfiltered
//       round-trip with actual RingBuffer (no local dump so proven via fixture — spec allows).
//   (B) Multi-layer scrub — api key/token/secret·Bearer·OSC 52·base64 high-entropy erased, raw ANSI
//       control sequences (SGR·cursor move etc. not secrets) preserved.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../../../src/daemon/RingBuffer';
import { scrub, mineBufferDir, writeMinedSeeds, LOCAL_CORPUS_DIR } from '../miner';

const enc = new TextEncoder();
const decUtf8 = new TextDecoder('utf-8');
// Scrub tests only handle ASCII secrets so decode bytes 1:1 as latin1 (no multibyte issues).
const dec = new TextDecoder('latin1');

describe('miner — .buf raw ANSI preservation', () => {
  it('(A) RingBuffer.dumpToFile preserves raw ANSI bytes without filtering', async () => {
    // Real dump fixture: byte sequence mixing raw ANSI like SGR·cursor move·CJK·emoji (UTF-8 encoded).
    const src = '\x1b[31mred\x1b[0m \x1b[H\x1b[2J한글\u{1F600}\x1b[38;2;18;52;86mtrue\x1b[0m';
    const raw = enc.encode(src);
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-'));
    try {
      const rb = new RingBuffer(1 << 20);
      rb.write(Buffer.from(raw));
      const bufPath = path.join(dir, 'session-abc.buf');
      await rb.dumpToFile(bufPath);

      // Miner reads .buf and scrubs. This fixture has no secrets so raw bytes must be 100% preserved.
      const seeds = mineBufferDir(dir);
      expect(seeds.length, 'must read one session-abc.buf').toBe(1);
      // (Key) secret-free input must not change a single byte from scrub — canonical raw unfiltered preservation.
      expect(Buffer.from(seeds[0].bytes).equals(Buffer.from(raw)), 'secret-free bytes were mutated').toBe(
        true,
      );
      // Re-decode as UTF-8 yields original text (multibyte CJK·emoji intact — consequence of byte preservation).
      const minedText = decUtf8.decode(seeds[0].bytes);
      expect(minedText).toBe(src);
      // raw ANSI control sequences·CJK·emoji·truecolor all preserved.
      expect(minedText).toContain('\x1b[31m'); // SGR red.
      expect(minedText).toContain('\x1b[H\x1b[2J'); // Cursor home + clear screen.
      expect(minedText).toContain('한글'); // CJK intact.
      expect(minedText).toContain('\u{1F600}'); // Emoji intact.
      expect(minedText).toContain('\x1b[38;2;18;52;86m'); // truecolor SGR.
      expect(minedText).not.toContain('[[REDACTED]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(A2) tmp companion files (.tmp.<hex>) are skipped during mining', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-tmp-'));
    try {
      const rb = new RingBuffer(1 << 16);
      rb.write(Buffer.from(enc.encode('hello')));
      await rb.dumpToFile(path.join(dir, 'real.buf'));
      // Mimic atomic dump intermediate artifact: real.buf.tmp.deadbeef (skip target).
      await rb.dumpToFile(path.join(dir, 'real.buf.tmp.deadbeef'));
      const seeds = mineBufferDir(dir);
      // real.buf only picked up; .tmp.deadbeef skipped — filename doesn't end in .buf so excluded anyway.
      // (real.buf.tmp.deadbeef doesn't end in .buf so extension filter already excludes it — belt and suspenders.)
      expect(seeds.map((s) => path.basename(s.sourceFile))).toEqual(['real.buf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('miner — multi-layer scrub', () => {
  it('scrubs key=value credentials (api_key/token/secret/password)', () => {
    const input = enc.encode(
      'export API_KEY=sk-abc123DEF456 TOKEN=ghp_xyz secret=hunter2 password=p@ss normal=keep',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk-abc123DEF456');
    expect(out).not.toContain('ghp_xyz');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('[[REDACTED]]');
    // Non-secret key=value preserved.
    expect(out).toContain('normal=keep');
  });

  it('scrubs Bearer tokens', () => {
    const input = enc.encode('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('Bearer [[REDACTED]]');
  });

  it('scrubs OSC 52 clipboard payload but preserves sequence skeleton', () => {
    // ESC ] 52 ; c ; <base64> BEL
    const payload = 'c2VjcmV0LWNsaXBib2FyZC1kYXRh'; // "secret-clipboard-data" base64.
    const input = enc.encode(`before\x1b]52;c;${payload}\x07after`);
    const out = dec.decode(scrub(input));
    expect(out).not.toContain(payload);
    expect(out).toContain('\x1b]52;c;[[REDACTED]]\x07');
    // Before/after text preserved.
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('scrubs high-entropy base64 tokens but preserves low-entropy/short strings', () => {
    // High-entropy (near-random) 32+ char base64.
    const highEntropy = 'aZ9kQ2mX7pL4vB8nR1sT6wY3cF5gH0jD';
    // Low-entropy (repeated) — must not be erased.
    const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const input = enc.encode(`high=${highEntropy} low=${lowEntropy}`);
    const out = dec.decode(scrub(input));
    // high= is not a secret keyword for KV_RE, but value is high-entropy base64 so layer 4 erases it.
    expect(out).not.toContain(highEntropy);
    // Low-entropy repeated string preserved.
    expect(out).toContain(lowEntropy);
  });

  // ── R7 reinforcement patterns ──────────────────────────────────────────────────────────
  it('scrubs AWS-style uppercase snake credential env vars (R7)', () => {
    const input = enc.encode(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SESSION_TOKEN=FQoGZXIvYXdzE keep=me',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('FQoGZXIvYXdzE');
    // Key name remains, value only marked.
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=[[REDACTED]]');
    expect(out).toContain('keep=me');
  });

  it('scrubs URL userinfo (scheme://user:pass@) but preserves host (R7)', () => {
    const input = enc.encode('git clone https://alice:s3cr3tPass@github.com/org/repo.git done');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('s3cr3tPass');
    expect(out).not.toContain('alice:s3cr3tPass');
    expect(out).toContain('https://[[REDACTED]]@github.com/org/repo.git');
  });

  it('scrubs JSON/colon format ("secret": "...") but preserves keys (R7)', () => {
    const input = enc.encode('{"api_key": "sk_live_verysecretvalue123", "user": "bob"}');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk_live_verysecretvalue123');
    expect(out).toContain('"api_key": "[[REDACTED]]"');
    // Non-secret key/value preserved.
    expect(out).toContain('"user": "bob"');
  });

  it('scrubs entire PEM private-key blocks (R7)', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\nrandomkeymaterial\n-----END RSA PRIVATE KEY-----';
    const input = enc.encode(`before\n${pem}\nafter`);
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('[[REDACTED]]');
  });

  it('scrubs known token prefixes (sk-/ghp_/gho_/xox) (R7)', () => {
    const input = enc.encode(
      'openai sk-proj1234567890ABCDEFxyz github ghp_1234567890abcdefghijABCDEF12 slack xoxb-123456789012-abcdef done',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk-proj1234567890ABCDEFxyz');
    expect(out).not.toContain('ghp_1234567890abcdefghijABCDEF12');
    expect(out).not.toContain('xoxb-123456789012-abcdef');
    expect(out).toContain('[[REDACTED]]');
    // Non-prefix plain text preserved.
    expect(out).toContain('openai');
    expect(out).toContain('done');
  });

  it('preserves raw ANSI control sequences (SGR·cursor) after scrub', () => {
    const input = enc.encode('\x1b[1;31mBOLD-RED\x1b[0m\x1b[10;5H');
    const out = dec.decode(scrub(input));
    expect(out).toBe('\x1b[1;31mBOLD-RED\x1b[0m\x1b[10;5H');
  });

  it('writeMinedSeeds writes .seed.bin to a local directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-local-'));
    try {
      // New signature (R7): (seeds, outLocalDir). tmpdir is outside repo so passes isolation guard.
      const written = writeMinedSeeds([{ sourceFile: '/x/y/session-1.buf', bytes: enc.encode('data') }], dir);
      expect(written.length).toBe(1);
      expect(path.basename(written[0])).toBe('session-1.seed.bin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R7: Isolation guard — reject writes to non-ignored paths inside repo.
  it('writeMinedSeeds rejects non-ignored paths inside repo (e.g. corpus/)', () => {
    const repoCorpus = path.join(__dirname, '..', 'corpus'); // core/harness/corpus — commit target.
    expect(() =>
      writeMinedSeeds([{ sourceFile: '/x/session-x.buf', bytes: enc.encode('data') }], repoCorpus),
    ).toThrow(/isolation violation/);
  });

  it('writeMinedSeeds default output root is core/harness/corpus-local/ (only allowed path inside repo)', () => {
    // Verify default path matches LOCAL_CORPUS_DIR (guard allows only this path inside repo).
    expect(LOCAL_CORPUS_DIR.endsWith(path.join('core', 'harness', 'corpus-local'))).toBe(true);
  });
});
