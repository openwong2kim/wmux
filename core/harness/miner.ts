// E0 conformance harness — M1 auxiliary: .buf miner (spec: engine-core-decision-2026-07-09.md §5-1·§3 D4)
//
// Reads {stateDir}/buffers/*.buf (RingBuffer.dumpToFile output), multi-layer scrubs, and writes
// **local-only** output. Never commit (.gitignore lists core/harness/corpus-local/ — D4 governance).
//
// ── Nature of .buf (verified in RingBuffer.ts) ──
// .buf preserves only the **tail** of the circular buffer. No geometry, initial state, or resize
// trail. It cannot be the canonical source for deterministic replay (recorder.ts fills that role).
// Mined output is used for:
//   (a) mid-stream robustness cases — whether the core absorbs mid-sequence truncated input without crashing.
//   (b) fuzzer seeds (§5-4) — widen fuzzer coverage with real-session byte distributions.
// Neither use requires an "exact grid answer", so missing geometry is not a problem.
//
// ── Multi-layer scrub (D4 + §6.E + R7 reinforcement) ──
// Real-session bytes may contain credentials. There is no promotion (commit) path, only local
// storage, but secrets are scrubbed in layers so none remain at rest:
//   1) key=value form: (?i)(api[_-]?key|token|secret|password|passwd|pwd)=<value>
//   2) AWS-style uppercase snake credential env: AWS_SECRET_ACCESS_KEY=... etc. (R7).
//   3) URL userinfo: credentials in scheme://user:pass@host (R7).
//   4) JSON/colon form: "secret": "..." / "api_key": "..." etc. (R7).
//   5) PEM blocks: -----BEGIN ... PRIVATE KEY----- ... -----END ...----- (R7).
//   6) Known token prefixes: tokens starting with sk-/ghp_/gho_/xox... (R7).
//   7) Bearer tokens: Authorization: Bearer <token> / standalone Bearer <token>.
//   8) OSC 52 clipboard payloads (ESC ] 52 ; ... ST) — base64 clipboard exfiltration vector.
//   9) base64 high-entropy heuristic: base64-like tokens ≥32 chars with high Shannon entropy.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Marker replacing secrets during scrub. secret-span notation (§6.E at-rest handling). */
const REDACTED = '[[REDACTED]]';

/** key=value credentials (case-insensitive). Value runs until whitespace or control char. */
const KV_RE = /((?:api[_-]?key|token|secret|password|passwd|pwd))=\S+/gi;

/**
 * AWS-style uppercase snake credential env (R7). AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID,
 * AWS_SESSION_TOKEN, etc. — broadly matches "UPPER_SNAKE + (SECRET|ACCESS|SESSION|PRIVATE|CREDENTIAL) + KEY/TOKEN/ID".
 * Value runs from = until whitespace/control char.
 */
const AWS_ENV_RE =
  /\b([A-Z][A-Z0-9]*_(?:SECRET|ACCESS|SESSION|PRIVATE|CREDENTIAL|CREDENTIALS)_[A-Z0-9_]*(?:KEY|TOKEN|ID))=\S+/g;

/**
 * URL userinfo credentials (R7). Redacts user:pass in scheme://user:pass@host (host preserved).
 * scheme is letters+digits+[.+-], user/pass run until @ or / (excluding control chars).
 */
// eslint-disable-next-line no-control-regex
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@\x00-\x1f]+):([^\s/@\x00-\x1f]+)@/g;

/**
 * JSON/colon credential form (R7). "secret": "..." / "api_key": "..." / 'token': '...' etc.
 * Keys: secret/password/passwd/pwd/token/api_key/apikey/access_key/private_key (case-insensitive).
 */
const JSON_KV_RE =
  /(["']?(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|password|passwd|pwd|token)["']?\s*:\s*)["'][^"']*["']/gi;

/** PEM private-key block (R7). -----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----. */
const PEM_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

/**
 * Known token prefixes (R7). sk- (OpenAI), ghp_/gho_/ghs_/ghr_ (GitHub PAT), xox[baprs]- (Slack).
 * Redacts prefix plus token body (alphanumeric, _, -).
 */
const TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,})/g;

/** Bearer token (Authorization header or standalone). */
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;

/**
 * OSC 52 clipboard sequence. ESC ] 52 ; <target> ; <base64> (BEL | ESC \).
 * Redacts entire payload (base64) — prevents clipboard exfiltration.
 */
// eslint-disable-next-line no-control-regex
const OSC52_RE = /\x1b\]52;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** base64-like token (length ≥32). Second pass uses entropy. */
const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** Shannon entropy (bits/char). High entropy = likely random secret. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** base64 high-entropy heuristic threshold (bits/char). ≥4.0 = high randomness (natural language usually <3.5). */
const ENTROPY_THRESHOLD = 4.0;

/**
 * Multi-layer scrub. Input is raw bytes (control chars included), output is bytes. OSC 52 at byte
 * level; everything else via latin1 string round-trip (byte↔char 1:1 preserving encoding).
 */
export function scrub(input: Uint8Array): Uint8Array {
  // latin1 (binary) maps 0..255 1:1 to chars → safe to restore bytes after regex replace.
  let s = Buffer.from(input).toString('latin1');

  // Order matters: clear structural patterns (PEM, URL, JSON, prefix, header) first, then run
  // base64 high-entropy heuristic last (so heuristic does not false-positive on skeletons/keys left by structural patterns).

  // 1) Remove OSC 52 payload (matches control chars). Keep skeleton, mark payload only.
  s = s.replace(OSC52_RE, (m) => {
    const head = m.slice(0, m.indexOf(';', m.indexOf(';') + 1) + 1); // "ESC]52;<target>;"
    const term = m.endsWith('\x07') ? '\x07' : '\x1b\\';
    return head + REDACTED + term;
  });

  // 2) Entire PEM private-key block (R7).
  s = s.replace(PEM_RE, REDACTED);

  // 3) URL userinfo (user:pass@) — redact user:pass only, preserve scheme·host skeleton (R7).
  s = s.replace(URL_USERINFO_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`);

  // 4) JSON/colon "key": "..." (R7) — preserve key/punctuation, mark value only.
  s = s.replace(JSON_KV_RE, (_m, keyPart: string) => `${keyPart}"${REDACTED}"`);

  // 5) key=value credentials (lowercase family).
  s = s.replace(KV_RE, (_m, key: string) => `${key}=${REDACTED}`);

  // 6) AWS-style uppercase snake credential env (R7).
  s = s.replace(AWS_ENV_RE, (_m, key: string) => `${key}=${REDACTED}`);

  // 7) Known token prefixes (sk-/ghp_/gho_/xox…) (R7).
  s = s.replace(TOKEN_PREFIX_RE, REDACTED);

  // 8) Bearer token.
  s = s.replace(BEARER_RE, `Bearer ${REDACTED}`);

  // 9) base64 high-entropy heuristic (last — catches random secrets missed above).
  s = s.replace(BASE64_CANDIDATE_RE, (m) => (shannonEntropy(m) >= ENTROPY_THRESHOLD ? REDACTED : m));

  return new Uint8Array(Buffer.from(s, 'latin1'));
}

export interface MinedSeed {
  readonly sourceFile: string;
  readonly bytes: Uint8Array;
}

/**
 * Read and scrub all *.buf in buffers/. Skip tmp companion files (.tmp.<hex>)
 * (RingBuffer atomic dump intermediate — same suffix as RingBuffer.isTmpFile convention).
 */
export function mineBufferDir(bufferDir: string): MinedSeed[] {
  let entries: string[];
  try {
    entries = readdirSync(bufferDir);
  } catch {
    return []; // Directory missing — nothing to mine.
  }
  const out: MinedSeed[] = [];
  for (const name of entries) {
    if (!name.endsWith('.buf')) continue;
    if (/\.tmp\.[0-9a-f]+$/.test(name)) continue; // Skip atomic dump intermediate.
    const full = path.join(bufferDir, name);
    const raw = readFileSync(full);
    out.push({ sourceFile: full, bytes: scrub(new Uint8Array(raw)) });
  }
  return out;
}

/**
 * Write mined output to a **local-only** directory. Path is .gitignore-listed and never committed.
 * Filenames reuse original session id with .seed.bin extension to mark mid-stream/fuzzer seeds.
 */
export const LOCAL_CORPUS_DIR_NAME = 'corpus-local';

/** Fixed local corpus dir in repo (core/harness/corpus-local/) — .gitignore path (R7). */
export const LOCAL_CORPUS_DIR = path.join(__dirname, LOCAL_CORPUS_DIR_NAME);

/** Repo root (two levels above core/harness). Isolation guard uses this for "in-repo non-ignored path" checks. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Isolation guard (R7): block mined output from leaking into in-repo non-ignored paths and being committed.
 * Allowed: (a) under fixed local corpus dir (LOCAL_CORPUS_DIR) (b) **outside** repo (e.g. os.tmpdir in tests).
 * Denied: inside repo but not under LOCAL_CORPUS_DIR (e.g. corpus/, src/).
 */
function assertIsolatedOutDir(outLocalDir: string): void {
  const resolved = path.resolve(outLocalDir);
  const insideLocalCorpus =
    resolved === LOCAL_CORPUS_DIR || resolved.startsWith(LOCAL_CORPUS_DIR + path.sep);
  const insideRepo = resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
  if (insideRepo && !insideLocalCorpus) {
    throw new Error(
      `[miner] isolation violation: mined output may only be written to ${LOCAL_CORPUS_DIR} (or outside the repo). ` +
        `rejected path: ${resolved} (non-ignored path inside repo — commit risk)`,
    );
  }
}

export function writeMinedSeeds(
  seeds: readonly MinedSeed[],
  outLocalDir: string = LOCAL_CORPUS_DIR,
): string[] {
  assertIsolatedOutDir(outLocalDir); // R7: reject in-repo non-ignored paths.
  mkdirSync(outLocalDir, { recursive: true });
  const written: string[] = [];
  for (const s of seeds) {
    const base = path.basename(s.sourceFile).replace(/\.buf$/, '');
    const dest = path.join(outLocalDir, `${base}.seed.bin`);
    writeFileSync(dest, s.bytes, { mode: 0o600 }); // at-rest handling (0600).
    written.push(dest);
  }
  return written;
}
