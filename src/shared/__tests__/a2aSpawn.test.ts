import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAWN_POLICY,
  SPAWN_CLOCK_SKEW_MS,
  SPAWN_TTL_MAX_MS,
  SPAWN_PENDING_PER_HOST_DEFAULT,
  SPAWN_REQUESTS_MAX,
  coerceSpawnPolicy,
  defaultSpawnPolicy,
  spawnPendingPerHost,
  normalizeSpawnSub,
  parseSpawnRequest,
  parseSpawnResult,
  spawnClockOk,
  spawnTargetsFor,
} from '../a2aSpawn';

const HOST = '11111111-1111-4111-8111-111111111111';
const ID = 'sp-0b7c2f6a-1d3e-4f5a-9b8c-7d6e5f4a3b2c';

const request = (over: Record<string, unknown> = {}) => ({
  v: 1, spawnId: ID, agent: 'claude', folder: { root: 'web', sub: 'apps/site' }, text: 'fix the build',
  expiresAt: '2026-10-24T00:00:00.000Z', from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' }, ...over,
});

describe('parseSpawnRequest', () => {
  it('takes exactly the request fields and nothing else', () => {
    expect(parseSpawnRequest(request())).toMatchObject({ spawnId: ID, agent: 'claude', folder: { root: 'web', sub: 'apps/site' } });
    for (const extra of ['env', 'args', 'command', 'cwd', 'permissionMode', 'model', 'images']) {
      expect(parseSpawnRequest(request({ [extra]: 'x' }))).toBeNull();
    }
    expect(parseSpawnRequest(request({ folder: { root: 'web', path: '/etc' } }))).toBeNull();
    expect(parseSpawnRequest(request({ agent: 'bash' }))).toBeNull();
    expect(parseSpawnRequest(request({ spawnId: 'not-a-spawn-id' }))).toBeNull();
    expect(parseSpawnRequest(request({ from: { kind: 'brain', workspaceId: 'ws-a' } }))).toBeNull();
    expect(parseSpawnRequest(request({ text: '   ' }))).toBeNull();
    expect(parseSpawnRequest(request({ text: 'x'.repeat(33 * 1024) }))).toBeNull();
  });
});

describe('normalizeSpawnSub', () => {
  it('keeps a plain relative path and refuses anything that could leave the root', () => {
    expect(normalizeSpawnSub(undefined)).toBe('');
    expect(normalizeSpawnSub('./apps//site/')).toBe('apps/site');
    for (const bad of ['../x', 'a/../../b', '/etc', 'C:/Windows', 'c:x', 'a\\b', '\\\\srv\\share', 'a\u0000b', 'a\nb', 'x'.repeat(513)]) {
      expect(normalizeSpawnSub(bad)).toBeNull();
    }
  });
});

describe('spawnClockOk (B\'s clock)', () => {
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();
  it('refuses a request from the future, one living over 72 h, and an expired one', () => {
    expect(spawnClockOk(at(now - 1000), at(now + 3600_000), now)).toBe(true);
    expect(spawnClockOk(at(now + SPAWN_CLOCK_SKEW_MS + 1000), at(now + 3600_000), now)).toBe(false);
    expect(spawnClockOk(at(now), at(now + SPAWN_TTL_MAX_MS + 1000), now)).toBe(false);
    // Sent long ago with a far expiry: over 72 h from its own send time.
    expect(spawnClockOk(at(now - 48 * 3600_000), at(now + 30 * 3600_000), now)).toBe(false);
    expect(spawnClockOk(at(now - 7200_000), at(now - 1000), now)).toBe(false);
  });
});

describe('parseSpawnResult', () => {
  it('carries a code, and an endpoint only with started', () => {
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'not-allowed' })).toEqual({ v: 1, spawnId: ID, code: 'not-allowed' });
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'not-allowed', message: '/home/x' })).toBeNull();
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'started' })).toBeNull();
    const linkId = '0b5e2a4c-9d1f-4e3a-8b7c-6d5e4f3a2b1c';
    const started = { v: 1, spawnId: ID, code: 'started', endpoint: { kind: 'pane', workspaceId: 'w', paneId: 'p' }, linkVersion: 1 };
    // `started` names the link B minted: a uuid, required, and only with started.
    expect(parseSpawnResult(started)).toBeNull();
    expect(parseSpawnResult({ ...started, linkId: 'not-a-uuid' })).toBeNull();
    expect(parseSpawnResult({ ...started, linkId })).toEqual({ ...started, linkId });
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'failed', linkId })).toBeNull();
  });
});

describe('the policy', () => {
  it('keeps a rule\'s folder below its root, normalized, and refuses one that is not', () => {
    const base = { ...defaultSpawnPolicy(), roots: [{ id: 'web', label: 'Web', path: '/r' }] };
    const rule = { hostId: '11111111-1111-4111-8111-111111111111', rootId: 'web', agent: 'claude' };
    expect(coerceSpawnPolicy({ ...base, rules: [{ ...rule, sub: 'apps/site' }] })?.rules).toEqual([{ ...rule, sub: 'apps/site' }]);
    expect(coerceSpawnPolicy({ ...base, rules: [rule] })?.rules).toEqual([rule]);
    expect(coerceSpawnPolicy({ ...base, rules: [{ ...rule, sub: '../out' }] })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, rules: [{ ...rule, sub: 'apps//site' }] })).toBeNull();
  });

  it('loads a policy stored before limits existed unchanged, with no limits', () => {
    const stored = {
      v: 1, enabled: true, approval: 'allow-list', followUps: 'direct', permissionMode: 'auto',
      hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: '/r' }], agents: ['claude'],
      rules: [{ hostId: HOST, rootId: 'web', agent: 'claude', sub: 'apps' }], version: 7,
    };
    const loaded = coerceSpawnPolicy(JSON.parse(JSON.stringify(stored)));
    expect(loaded).toEqual(stored);
    expect(loaded).not.toHaveProperty('limits');
    expect(spawnPendingPerHost(loaded!)).toBe(SPAWN_PENDING_PER_HOST_DEFAULT);
  });

  it('takes each limit as an optional positive integer, pending up to the store size; a malformed one is not a policy, an unknown one is left out', () => {
    const base = defaultSpawnPolicy();
    const all = { livePerPc: 2, liveTotal: 4, startsPerHour: 3, startsPerDay: 10, pendingPerPc: SPAWN_REQUESTS_MAX, maxPromptKiB: 32, maxWaitHours: 72 };
    expect(coerceSpawnPolicy({ ...base, limits: all })?.limits).toEqual(all);
    expect(coerceSpawnPolicy({ ...base, limits: { startsPerDay: 1 } })?.limits).toEqual({ startsPerDay: 1 });
    // An empty set is no limits at all.
    expect(coerceSpawnPolicy({ ...base, limits: {} })).not.toHaveProperty('limits');
    for (const bad of [{ livePerPc: 0 }, { liveTotal: -1 }, { startsPerHour: 1.5 }, { startsPerDay: '3' }, { pendingPerPc: SPAWN_REQUESTS_MAX + 1 }, { maxPromptKiB: 33 }, { maxWaitHours: 73 }, { maxWaitHours: 0 }, null, []]) {
      expect(coerceSpawnPolicy({ ...base, limits: bad }), JSON.stringify(bad)).toBeNull();
    }
    // A later version's limit: the policy still loads, without it.
    expect(coerceSpawnPolicy({ ...base, limits: { startsPerWeek: 5, livePerPc: 2 } })?.limits).toEqual({ livePerPc: 2 });
    expect(spawnPendingPerHost({ limits: { pendingPerPc: 5 } })).toBe(5);
  });

  it('is off by default with nobody allowed, and runs agents in auto mode', () => {
    expect(DEFAULT_SPAWN_POLICY).toMatchObject({ enabled: false, approval: 'ask', followUps: 'ask', permissionMode: 'auto', hosts: {}, roots: [], agents: [] });
    expect(coerceSpawnPolicy(defaultSpawnPolicy())).toEqual(defaultSpawnPolicy());
  });

  it('drops an agent another PC may not start, and its rules, keeping the rest', () => {
    const hostId = '11111111-1111-4111-8111-111111111111';
    const base = { ...defaultSpawnPolicy(), enabled: true, hosts: { [hostId]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: '/r' }] };
    const claude = { hostId, rootId: 'web', agent: 'claude' };
    const policy = coerceSpawnPolicy({ ...base, agents: ['gemini', 'claude', 'qwen'], rules: [{ hostId, rootId: 'web', agent: 'gemini' }, claude] });
    expect(policy).toMatchObject({ enabled: true, hosts: { [hostId]: { allowed: true } }, roots: [{ id: 'web' }], agents: ['claude'], rules: [claude] });
  });

  it('refuses a policy with anything unknown rather than dropping it', () => {
    const base = { ...defaultSpawnPolicy(), enabled: true };
    expect(coerceSpawnPolicy({ ...base, agents: ['claude', 'rm'] })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, permissionMode: 'yolo' })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, hosts: { 'not-a-host': { allowed: true } } })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, roots: [{ id: 'a', label: 'A', path: '/x' }, { id: 'a', label: 'B', path: '/y' }] })).toBeNull();
  });

  it('tells an allowed PC root ids, labels and agents, never paths', () => {
    const policy = { ...defaultSpawnPolicy(), enabled: true, hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: '/Users/me/web' }], agents: ['claude' as const], version: 4 };
    const targets = spawnTargetsFor(policy, HOST);
    expect(targets).toEqual({ v: 1, version: 4, roots: [{ id: 'web', label: 'Web' }], agents: ['claude'] });
    expect(JSON.stringify(targets)).not.toContain('/Users');
    expect(spawnTargetsFor({ ...policy, enabled: false }, HOST)).toBeNull();
    expect(spawnTargetsFor(policy, '22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});
