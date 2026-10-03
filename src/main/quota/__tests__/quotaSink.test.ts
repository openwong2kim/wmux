import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const quotaSink = require('../../../../integrations/agy/bin/quota-sink.js');
const {
  extractQuotaPayload,
  writeQuotaFile,
  readQuotaFile,
  resolveOriginalCommand,
  mergeQuotaRecord,
  isDeepEqual,
  recordsEqualIgnoringCapturedAt,
  hasQuota,
  hasAnyAllowlistedField,
} = quotaSink;

const SINK_SCRIPT = path.resolve(__dirname, '../../../../integrations/agy/bin/quota-sink.js');

describe('quota-sink.js field extraction and privacy allowlist', () => {
  it('extracts ONLY allowlisted fields and stamps capturedAtMs and quotaCapturedAtMs', () => {
    const fullPayload = {
      quota: {
        'gemini-weekly': {
          remaining_fraction: 0.85,
          reset_time: '2026-10-01T00:00:00Z',
          reset_in_seconds: 21600,
        },
      },
      plan_tier: 'pro_tier',
      model: {
        id: 'gemini-2.5-pro',
        display_name: 'Gemini 2.5 Pro',
        vendor: 'google',
      },
      context_window: {
        total_input_tokens: 1500,
        total_output_tokens: 300,
        context_window_size: 2000000,
      },
      conversation_id: 'conv-12345',
      version: '1.2.14',
      // SENSITIVE FIELDS TO DROP:
      email: 'sensitive-user@google.com',
      cwd: 'C:\\Users\\Lontra\\SecretProject',
      transcript_path: 'C:\\Users\\Lontra\\.gemini\\transcripts\\t1.json',
      vcs: { branch: 'main', commit: 'abcdef' },
      user: { id: 'u-999', name: 'John Doe' },
      messages: [{ role: 'user', content: 'hello' }],
      extra_junk: true,
    };

    const before = Date.now();
    const extracted = extractQuotaPayload(fullPayload);
    const after = Date.now();

    expect(extracted.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(extracted.capturedAtMs).toBeLessThanOrEqual(after);
    expect(extracted.quotaCapturedAtMs).toBeGreaterThanOrEqual(before);
    expect(extracted.quotaCapturedAtMs).toBeLessThanOrEqual(after);

    // Allowlisted fields must be present and accurate
    expect(extracted.quota).toEqual(fullPayload.quota);
    expect(extracted.plan_tier).toBe('pro_tier');
    expect(extracted.model).toEqual({ id: 'gemini-2.5-pro' });
    expect(extracted.context_window).toEqual(fullPayload.context_window);
    expect(extracted.conversation_id).toBe('conv-12345');
    expect(extracted.version).toBe('1.2.14');

    // Sensitive / non-allowlisted fields MUST be dropped
    expect((extracted as Record<string, unknown>).email).toBeUndefined();
    expect((extracted as Record<string, unknown>).cwd).toBeUndefined();
    expect((extracted as Record<string, unknown>).transcript_path).toBeUndefined();
    expect((extracted as Record<string, unknown>).vcs).toBeUndefined();
    expect((extracted as Record<string, unknown>).user).toBeUndefined();
    expect((extracted as Record<string, unknown>).messages).toBeUndefined();
    expect((extracted as Record<string, unknown>).extra_junk).toBeUndefined();

    // Nested model object should not leak extra properties like display_name or vendor
    expect(extracted.model.display_name).toBeUndefined();
    expect(extracted.model.vendor).toBeUndefined();
  });

  it('handles string model property by preserving id', () => {
    const payload = {
      model: 'gemini-2.5-flash',
    };
    const extracted = extractQuotaPayload(payload);
    expect(extracted.model).toEqual({ id: 'gemini-2.5-flash' });
  });

  it('handles null model gracefully without crashing', () => {
    const payload = {
      model: null,
      version: '1.2.14',
    };
    const extracted = extractQuotaPayload(payload);
    expect(extracted.model).toBeUndefined();
    expect(extracted.version).toBe('1.2.14');
  });

  it('gracefully handles missing, empty, or non-object inputs', () => {
    expect(extractQuotaPayload(null).capturedAtMs).toBeTypeOf('number');
    expect(extractQuotaPayload(undefined).capturedAtMs).toBeTypeOf('number');
    expect(extractQuotaPayload({}).capturedAtMs).toBeTypeOf('number');
    expect(Object.keys(extractQuotaPayload({}))).toEqual(['capturedAtMs']);
  });
});

describe('mergeQuotaRecord pure persisting policy', () => {
  it('sequence of payloads [no quota, quota, no quota, quota-changed] produces the right merged state', () => {
    const t1 = 100000;
    const t2 = 100300;
    const t3 = 100600;
    const t4 = 101000;

    // 1. Initial payload of a turn: no quota, only conversation_id, context_window, version
    const payload1 = {
      conversation_id: 'conv-abc',
      version: '1.2.14',
      context_window: { total_input_tokens: 1000, context_window_size: 2000000 },
      cwd: 'C:\\leak\\dir',
      email: 'user@example.com',
    };

    const res1 = mergeQuotaRecord(null, payload1, t1);
    expect(res1.shouldWrite).toBe(true);
    expect(res1.record).toEqual({
      capturedAtMs: t1,
      conversation_id: 'conv-abc',
      version: '1.2.14',
      context_window: { total_input_tokens: 1000, context_window_size: 2000000 },
    });
    expect(res1.record.quota).toBeUndefined();
    expect(res1.record.quotaCapturedAtMs).toBeUndefined();

    // 2. Later payload in same turn: quota arrives
    const payload2 = {
      conversation_id: 'conv-abc',
      version: '1.2.14',
      context_window: { total_input_tokens: 1200, context_window_size: 2000000 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.95, reset_time: '2026-10-01T04:00:00Z', reset_in_seconds: 14400 },
      },
      plan_tier: 'Google AI Pro',
    };

    const res2 = mergeQuotaRecord(res1.record, payload2, t2);
    expect(res2.shouldWrite).toBe(true);
    expect(res2.record.quota).toEqual(payload2.quota);
    expect(res2.record.quotaCapturedAtMs).toBe(t2);
    expect(res2.record.plan_tier).toBe('Google AI Pro');
    expect(res2.record.capturedAtMs).toBe(t2);

    // 3. New turn starts: payload without quota arrives.
    // Quota, plan_tier, and quotaCapturedAtMs MUST be kept across the gap!
    const payload3 = {
      conversation_id: 'conv-def',
      version: '1.2.14',
      context_window: { total_input_tokens: 1500, context_window_size: 2000000 },
    };

    const res3 = mergeQuotaRecord(res2.record, payload3, t3);
    expect(res3.shouldWrite).toBe(true);
    // Quota kept!
    expect(res3.record.quota).toEqual(payload2.quota);
    // quotaCapturedAtMs does NOT move to t3! It stays at t2!
    expect(res3.record.quotaCapturedAtMs).toBe(t2);
    // plan_tier kept!
    expect(res3.record.plan_tier).toBe('Google AI Pro');
    // capturedAtMs updated to t3
    expect(res3.record.capturedAtMs).toBe(t3);
    // conversation_id updated to new conversation
    expect(res3.record.conversation_id).toBe('conv-def');

    // 4. Quota arrives changed: quotaCapturedAtMs moves to t4
    const payload4 = {
      conversation_id: 'conv-def',
      version: '1.2.14',
      context_window: { total_input_tokens: 1800, context_window_size: 2000000 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.85, reset_time: '2026-10-01T04:00:00Z', reset_in_seconds: 14000 },
      },
      plan_tier: 'Google AI Pro',
    };

    const res4 = mergeQuotaRecord(res3.record, payload4, t4);
    expect(res4.shouldWrite).toBe(true);
    expect(res4.record.quota).toEqual(payload4.quota);
    // quotaCapturedAtMs now moves to t4
    expect(res4.record.quotaCapturedAtMs).toBe(t4);
    expect(res4.record.capturedAtMs).toBe(t4);
  });

  it('keeps previous quota and plan_tier when incoming has empty quota object {}', () => {
    const previous = {
      capturedAtMs: 1000,
      quotaCapturedAtMs: 1000,
      quota: { 'gemini-5h': { remaining_fraction: 0.9 } },
      plan_tier: 'Google AI Pro',
      version: '1.2.14',
    };

    const incoming = {
      quota: {},
      version: '1.2.14',
      conversation_id: 'conv-new',
    };

    const res = mergeQuotaRecord(previous, incoming, 2000);
    expect(res.record.quota).toEqual(previous.quota);
    expect(res.record.quotaCapturedAtMs).toBe(1000);
    expect(res.record.plan_tier).toBe('Google AI Pro');
    expect(res.record.conversation_id).toBe('conv-new');
  });

  it('payload with only forbidden fields writes nothing (shouldWrite: false)', () => {
    const previous = {
      capturedAtMs: 5000,
      quota: { 'gemini-5h': { remaining_fraction: 0.5 } },
    };

    const forbiddenOnly = {
      email: 'leak@example.com',
      cwd: 'C:\\Users\\Lontra\\Secret',
      session_id: 'sess-999',
      terminal_width: 80,
      product: 'antigravity',
      agent_state: 'idle',
      sandbox: false,
    };

    const res = mergeQuotaRecord(previous, forbiddenOnly, 6000);
    expect(res.shouldWrite).toBe(false);
    expect(res.record).toBe(previous);

    // Also with no previous record
    const resNoPrev = mergeQuotaRecord(null, forbiddenOnly, 6000);
    expect(resNoPrev.shouldWrite).toBe(false);
    expect(resNoPrev.record).toBeNull();
  });

  it('unchanged payload within 30 s does not write; after 30 s it does', () => {
    const basePayload = {
      conversation_id: 'conv-stable',
      version: '1.2.14',
      quota: { bucket: { remaining_fraction: 1 } },
      plan_tier: 'tier1',
    };

    const t0 = 10000;
    // Initial write
    const initial = mergeQuotaRecord(null, basePayload, t0);
    expect(initial.shouldWrite).toBe(true);

    let stored = initial.record;

    // Call 1: 300 ms later, identical payload
    const call1 = mergeQuotaRecord(stored, basePayload, t0 + 300);
    expect(call1.shouldWrite).toBe(false);

    // Call 2: 29 999 ms later, identical payload (under 30 s)
    const call2 = mergeQuotaRecord(stored, basePayload, t0 + 29999);
    expect(call2.shouldWrite).toBe(false);

    // Call 3: 30 000 ms later (at or above 30 s)
    const call3 = mergeQuotaRecord(stored, basePayload, t0 + 30000);
    expect(call3.shouldWrite).toBe(true);
    expect(call3.record.capturedAtMs).toBe(t0 + 30000);

    // Now update stored to call3
    stored = call3.record;

    // Call 4: 500 ms after call 3, unchanged -> does not write
    const call4 = mergeQuotaRecord(stored, basePayload, t0 + 30500);
    expect(call4.shouldWrite).toBe(false);

    // Call 5: 31 000 ms after call 3 -> does write
    const call5 = mergeQuotaRecord(stored, basePayload, t0 + 30000 + 31000);
    expect(call5.shouldWrite).toBe(true);
    expect(call5.record.capturedAtMs).toBe(t0 + 30000 + 31000);
  });

  it('quotaCapturedAtMs semantics: (a) same quota 10 s later does NOT write; (b) same quota 31 s later writes with both timestamps; (c) payload without quota leaves quotaCapturedAtMs untouched', () => {
    const t0 = 100000;
    const basePayload = {
      quota: { 'gemini-5h': { remaining_fraction: 0.9 } },
      plan_tier: 'Google AI Pro',
      version: '1.2.14',
    };

    // Initial write
    const initial = mergeQuotaRecord(null, basePayload, t0);
    expect(initial.shouldWrite).toBe(true);
    expect(initial.record.capturedAtMs).toBe(t0);
    expect(initial.record.quotaCapturedAtMs).toBe(t0);

    const stored = initial.record;

    // (a) same quota arriving 10 s later does NOT write
    const t10s = t0 + 10000;
    const call10s = mergeQuotaRecord(stored, basePayload, t10s);
    expect(call10s.shouldWrite).toBe(false);
    expect(call10s.record.capturedAtMs).toBe(t10s);
    expect(call10s.record.quotaCapturedAtMs).toBe(t10s);

    // (b) the same quota arriving 31 s later writes and both capturedAtMs and quotaCapturedAtMs equal that time
    const t31s = t0 + 31000;
    const call31s = mergeQuotaRecord(stored, basePayload, t31s);
    expect(call31s.shouldWrite).toBe(true);
    expect(call31s.record.capturedAtMs).toBe(t31s);
    expect(call31s.record.quotaCapturedAtMs).toBe(t31s);

    // (c) a payload without quota leaves quotaCapturedAtMs untouched
    const payloadWithoutQuota = {
      conversation_id: 'conv-new-turn',
      version: '1.2.14',
      context_window: { total_input_tokens: 1200 },
    };
    const tWithoutQuota = t0 + 15000;
    const callNoQuota = mergeQuotaRecord(stored, payloadWithoutQuota, tWithoutQuota);
    expect(callNoQuota.record.quotaCapturedAtMs).toBe(t0); // untouched from stored
    expect(callNoQuota.record.capturedAtMs).toBe(tWithoutQuota);
    expect(callNoQuota.record.quota).toEqual(stored.quota);
    expect(callNoQuota.record.plan_tier).toBe(stored.plan_tier);
  });

  it('recordsEqualIgnoringCapturedAt ignores both capturedAtMs and quotaCapturedAtMs', () => {
    const a = {
      capturedAtMs: 1000,
      quotaCapturedAtMs: 1000,
      quota: { bucket: 1 },
      version: '1.0',
    };
    const b = {
      capturedAtMs: 99999,
      quotaCapturedAtMs: 88888,
      quota: { bucket: 1 },
      version: '1.0',
    };
    expect(recordsEqualIgnoringCapturedAt(a, b)).toBe(true);

    const c = {
      ...b,
      quota: { bucket: 2 },
    };
    expect(recordsEqualIgnoringCapturedAt(a, c)).toBe(false);
  });
});

describe('quota-sink.js atomic file handling and realistic payload', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quota-file-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('atomically writes to <homeDir>/.wmux/quota/agy.json and leaves no tmp files', () => {
    const data = {
      capturedAtMs: Date.now(),
      quota: { remaining: 0.9 },
      plan_tier: 'free',
    };

    writeQuotaFile(data, tmpHome);

    const quotaDir = path.join(tmpHome, '.wmux', 'quota');
    const targetFile = path.join(quotaDir, 'agy.json');

    expect(fs.existsSync(targetFile)).toBe(true);
    const read = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    expect(read).toEqual(data);

    const files = fs.readdirSync(quotaDir);
    expect(files).toEqual(['agy.json']);
  });

  it('realistic payload with fake email and cwd: neither appears anywhere in written file', () => {
    const realisticPayload = {
      cwd: 'C:\\Users\\Lontra\\UltraSecretDirectory',
      session_id: 'session-uuid-12345678',
      conversation_id: 'conv-real-999',
      transcript_path: 'C:\\Users\\Lontra\\.gemini\\transcripts\\confidential.json',
      model: {
        id: 'gemini-2.5-pro',
        display_name: 'Gemini 2.5 Pro',
      },
      workspace: 'C:\\Users\\Lontra\\UltraSecretDirectory',
      version: '1.2.14',
      context_window: {
        total_input_tokens: 1500,
        total_output_tokens: 300,
        context_window_size: 2000000,
        used_percentage: 0.0009,
        remaining_percentage: 0.9991,
        current_usage: 1800,
      },
      exceeds_200k_tokens: false,
      product: 'antigravity',
      agent_state: 'idle',
      cycle_mode: 'turn',
      sandbox: false,
      terminal_width: 120,
      email: 'super-confidential-user@company.com',
      quota: {
        '3p-5h': {
          remaining_fraction: 1,
          reset_time: '2026-10-01T04:30:51Z',
          reset_in_seconds: 17997,
        },
        'gemini-5h': {
          remaining_fraction: 0.9249,
          reset_time: '2026-10-01T03:35:05Z',
          reset_in_seconds: 14651,
        },
        'gemini-weekly': {
          remaining_fraction: 0.0991,
          reset_time: '2026-10-02T12:50:07Z',
          reset_in_seconds: 134353,
        },
      },
      plan_tier: 'Google AI Pro',
    };

    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(realisticPayload),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');

    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');
    expect(fs.existsSync(targetFile)).toBe(true);

    const rawFileContent = fs.readFileSync(targetFile, 'utf8');

    // Assert that sensitive strings NEVER appear anywhere in the written file
    expect(rawFileContent).not.toContain('super-confidential-user@company.com');
    expect(rawFileContent).not.toContain('UltraSecretDirectory');
    expect(rawFileContent).not.toContain('confidential.json');
    expect(rawFileContent).not.toContain('session-uuid-12345678');
    expect(rawFileContent).not.toContain('"email"');
    expect(rawFileContent).not.toContain('"cwd"');
    expect(rawFileContent).not.toContain('"transcript_path"');
    expect(rawFileContent).not.toContain('"workspace"');
    expect(rawFileContent).not.toContain('"session_id"');
    expect(rawFileContent).not.toContain('"terminal_width"');
    expect(rawFileContent).not.toContain('"sandbox"');
    expect(rawFileContent).not.toContain('"product"');
    expect(rawFileContent).not.toContain('"agent_state"');
    expect(rawFileContent).not.toContain('"cycle_mode"');

    const parsed = JSON.parse(rawFileContent);
    expect(parsed.plan_tier).toBe('Google AI Pro');
    expect(parsed.version).toBe('1.2.14');
    expect(parsed.conversation_id).toBe('conv-real-999');
    expect(parsed.model).toEqual({ id: 'gemini-2.5-pro' });
    expect(parsed.quota['gemini-5h'].remaining_fraction).toBe(0.9249);
    expect(parsed.quotaCapturedAtMs).toBeTypeOf('number');
    expect(parsed.capturedAtMs).toBeTypeOf('number');
  });

  it('payload with only forbidden fields executed via process writes nothing', () => {
    const forbiddenPayload = {
      email: 'leak@example.com',
      cwd: 'C:\\Users\\Lontra',
      sandbox: true,
    };

    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(forbiddenPayload),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');
    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('unchanged payload within 30 s does not rewrite the file (mtime unchanged)', async () => {
    const payload = {
      version: '1.2.14',
      conversation_id: 'conv-mtime',
      quota: { 'gemini-5h': { remaining_fraction: 0.9 } },
      plan_tier: 'Google AI Pro',
    };

    // First write
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');
    expect(fs.existsSync(targetFile)).toBe(true);
    const mtime1 = fs.statSync(targetFile).mtimeMs;

    // Small delay to ensure that if a write occurred, mtime would change
    await new Promise((r) => setTimeout(r, 50));

    // Second write with identical payload (within 30 s)
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    const mtime2 = fs.statSync(targetFile).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('sequence of payloads [no quota, quota, no quota, quota-changed] on disk produces the right merged file', async () => {
    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');

    // 1. Initial payload of a turn: no quota
    const payload1 = {
      conversation_id: 'conv-disk-1',
      version: '1.2.14',
      context_window: { total_input_tokens: 500 },
      email: 'leak@example.com',
      cwd: 'C:\\leak',
    };
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload1),
      env: { ...process.env, WMUX_QUOTA_SINK_HOME: tmpHome },
      encoding: 'utf8',
    });
    expect(fs.existsSync(targetFile)).toBe(true);
    let record = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    expect(record.conversation_id).toBe('conv-disk-1');
    expect(record.quota).toBeUndefined();
    expect(record.quotaCapturedAtMs).toBeUndefined();

    // 2. Later payload in same turn: quota arrives
    await new Promise((r) => setTimeout(r, 20));
    const payload2 = {
      conversation_id: 'conv-disk-1',
      version: '1.2.14',
      context_window: { total_input_tokens: 600 },
      quota: { 'gemini-5h': { remaining_fraction: 0.95 } },
      plan_tier: 'Google AI Pro',
    };
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload2),
      env: { ...process.env, WMUX_QUOTA_SINK_HOME: tmpHome },
      encoding: 'utf8',
    });
    record = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    expect(record.quota['gemini-5h'].remaining_fraction).toBe(0.95);
    expect(record.plan_tier).toBe('Google AI Pro');
    const quotaCapturedAt1 = record.quotaCapturedAtMs;
    expect(quotaCapturedAt1).toBeTypeOf('number');

    // 3. Next turn starts: payload without quota arrives.
    // Quota kept across gap, quotaCapturedAtMs does not move.
    await new Promise((r) => setTimeout(r, 20));
    const payload3 = {
      conversation_id: 'conv-disk-2',
      version: '1.2.14',
      context_window: { total_input_tokens: 100 },
    };
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload3),
      env: { ...process.env, WMUX_QUOTA_SINK_HOME: tmpHome },
      encoding: 'utf8',
    });
    record = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    expect(record.conversation_id).toBe('conv-disk-2');
    expect(record.quota['gemini-5h'].remaining_fraction).toBe(0.95);
    expect(record.plan_tier).toBe('Google AI Pro');
    expect(record.quotaCapturedAtMs).toBe(quotaCapturedAt1);

    // 4. Quota changes: quotaCapturedAtMs moves
    await new Promise((r) => setTimeout(r, 20));
    const payload4 = {
      conversation_id: 'conv-disk-2',
      version: '1.2.14',
      context_window: { total_input_tokens: 200 },
      quota: { 'gemini-5h': { remaining_fraction: 0.85 } },
      plan_tier: 'Google AI Pro',
    };
    spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: JSON.stringify(payload4),
      env: { ...process.env, WMUX_QUOTA_SINK_HOME: tmpHome },
      encoding: 'utf8',
    });
    record = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    expect(record.quota['gemini-5h'].remaining_fraction).toBe(0.85);
    expect(record.quotaCapturedAtMs).toBeGreaterThan(quotaCapturedAt1);
  });
});

describe('quota-sink.js process execution and --chain-b64 chaining', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quota-proc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('chains to an original command passed via --chain-b64, printing stdout verbatim and forwarding stdin', () => {
    const payload = {
      quota: { percent: 99 },
    };

    const helperScript = path.join(tmpHome, 'chained-helper.js');
    fs.writeFileSync(
      helperScript,
      'const fs = require("fs"); const raw = fs.readFileSync(0, "utf8"); const parsed = JSON.parse(raw); process.stdout.write("chained-pct:" + parsed.quota.percent);',
      'utf8',
    );

    const origCmd = `node "${helperScript}"`;
    const chainB64 = Buffer.from(origCmd, 'utf8').toString('base64url');

    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy', '--chain-b64', chainB64], {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('chained-pct:99');

    // Verify agy.json was also written
    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');
    expect(fs.existsSync(targetFile)).toBe(true);
  });

  it('WMUX_AGY_ORIGINAL_STATUSLINE env var takes precedence over --chain-b64 CLI argument', () => {
    const helperEnv = path.join(tmpHome, 'env-helper.js');
    fs.writeFileSync(helperEnv, 'process.stdout.write("from-env");', 'utf8');

    const helperCli = path.join(tmpHome, 'cli-helper.js');
    fs.writeFileSync(helperCli, 'process.stdout.write("from-cli");', 'utf8');

    const envCmd = `node "${helperEnv}"`;
    const cliCmd = `node "${helperCli}"`;
    const cliB64 = Buffer.from(cliCmd, 'utf8').toString('base64url');

    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy', '--chain-b64', cliB64], {
      input: JSON.stringify({ version: '1.0' }),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
        WMUX_AGY_ORIGINAL_STATUSLINE: envCmd,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('from-env');
  });

  it('drops old quoted positional chain argument and produces empty stdout', () => {
    const helperScript = path.join(tmpHome, 'positional-helper.js');
    fs.writeFileSync(helperScript, 'process.stdout.write("should-not-run");', 'utf8');

    const oldPositionalCmd = `node "${helperScript}"`;

    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy', oldPositionalCmd], {
      input: JSON.stringify({ version: '1.0' }),
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe(''); // Positional command is dropped!
  });

  it('handles empty or malformed stdin gracefully without crashing or writing corrupt file', () => {
    const res = spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
      input: 'not-valid-json {[[',
      env: {
        ...process.env,
        WMUX_QUOTA_SINK_HOME: tmpHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const targetFile = path.join(tmpHome, '.wmux', 'quota', 'agy.json');
    expect(fs.existsSync(targetFile)).toBe(false);
  });
});

describe('resolveOriginalCommand helper', () => {
  it('resolves from WMUX_AGY_ORIGINAL_STATUSLINE env var first', () => {
    const b64 = Buffer.from('cli-cmd', 'utf8').toString('base64url');
    const cmd = resolveOriginalCommand(['node', 'quota-sink.js', 'agy', '--chain-b64', b64], {
      WMUX_AGY_ORIGINAL_STATUSLINE: 'env-cmd',
    });
    expect(cmd).toBe('env-cmd');
  });

  it('resolves from --chain-b64 CLI argument', () => {
    const orig = 'custom-cmd --arg="val with space"';
    const b64 = Buffer.from(orig, 'utf8').toString('base64url');
    const cmd = resolveOriginalCommand(['node', 'quota-sink.js', 'agy', '--chain-b64', b64], {});
    expect(cmd).toBe(orig);
  });

  it('resolves from --chain-b64=<value> syntax', () => {
    const orig = 'another-cmd --flag';
    const b64 = Buffer.from(orig, 'utf8').toString('base64url');
    const cmd = resolveOriginalCommand(['node', 'quota-sink.js', 'agy', `--chain-b64=${b64}`], {});
    expect(cmd).toBe(orig);
  });

  it('returns null for positional arguments (old mechanism dropped)', () => {
    const cmd = resolveOriginalCommand(['node', 'quota-sink.js', 'agy', 'my-command --flag'], {});
    expect(cmd).toBeNull();
  });

  it('returns null when no chain option is provided', () => {
    const cmd = resolveOriginalCommand(['node', 'quota-sink.js', 'agy'], {});
    expect(cmd).toBeNull();
  });
});

describe('quota-sink.js per-account snapshots', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quota-account-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const run = (payload: object) => spawnSync(process.execPath, [SINK_SCRIPT, 'agy'], {
    input: JSON.stringify(payload),
    env: { ...process.env, WMUX_QUOTA_SINK_HOME: tmpHome },
    encoding: 'utf8',
  });

  it('files each account under the sha256 key of its email and never writes the email', () => {
    const quota = (f: number) => ({ 'gemini-5h': { remaining_fraction: f, reset_time: '2026-10-02T15:00:00Z' } });
    expect(run({ email: 'Mom@Example.com', quota: quota(0.2), plan_tier: 'Google AI Pro' }).status).toBe(0);
    expect(run({ email: 'dad@example.com', quota: quota(0.9) }).status).toBe(0);

    const dir = path.join(tmpHome, '.wmux', 'quota', 'agy-accounts');
    const momFile = path.join(tmpHome, '.wmux', 'quota', quotaSink.accountQuotaFileName('mom@example.com'));
    const dadFile = path.join(tmpHome, '.wmux', 'quota', quotaSink.accountQuotaFileName('dad@example.com'));
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(dadFile), path.basename(momFile)].sort());
    expect(JSON.parse(fs.readFileSync(momFile, 'utf8')).quota['gemini-5h'].remaining_fraction).toBe(0.2);
    expect(JSON.parse(fs.readFileSync(dadFile, 'utf8')).quota['gemini-5h'].remaining_fraction).toBe(0.9);
    for (const f of [momFile, dadFile, path.join(tmpHome, '.wmux', 'quota', 'agy.json')]) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/example\.com/i);
    }
  });

  it('keeps an account quota across a payload that carries none', () => {
    run({ email: 'a@example.com', quota: { 'gemini-5h': { remaining_fraction: 0.4 } } });
    run({ email: 'a@example.com', version: '1.2.14' });
    const file = path.join(tmpHome, '.wmux', 'quota', quotaSink.accountQuotaFileName('a@example.com'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).quota['gemini-5h'].remaining_fraction).toBe(0.4);
  });

  it('writes no per-account file without an email', () => {
    run({ quota: { 'gemini-5h': { remaining_fraction: 0.4 } } });
    expect(fs.existsSync(path.join(tmpHome, '.wmux', 'quota', 'agy-accounts'))).toBe(false);
  });

  it('accountQuotaFileName rejects non-emails', () => {
    expect(quotaSink.accountQuotaFileName(undefined)).toBeNull();
    expect(quotaSink.accountQuotaFileName('nobody')).toBeNull();
  });
});
