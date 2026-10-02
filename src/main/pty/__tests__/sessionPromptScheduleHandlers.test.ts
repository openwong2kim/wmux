import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionPromptScheduleHandlers } from '../sessionPromptScheduleHandlers';
import {
  getSessionPromptSchedulesPath,
  loadSessionPromptSchedules,
  saveSessionPromptSchedules,
  SESSION_PROMPT_SCHEDULE_LIMITS,
  type SessionPromptSchedule,
} from '../sessionPromptScheduleStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-session-handlers-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function schedule(id: string, ptyId = 'pty-1'): SessionPromptSchedule {
  return {
    id,
    ptyId,
    agentSlug: 'codex',
    sessionIncarnationId: 'incarnation-1',
    prompt: 'continue',
    nextRunAt: Date.now() + 60_000,
    enabled: true,
    createdAt: Date.now(),
  };
}

function handlers(
  available = true,
  slug: 'codex' | 'claude' | null = 'codex',
  agentVerified = true,
) {
  return createSessionPromptScheduleHandlers({
    available,
    getAgentState: async () => slug ? { slug, incarnationId: 'incarnation-1', agentVerified } : null,
    dir,
  });
}

describe('session prompt schedule IPC handlers', () => {
  it('persists a valid request against the canonically detected agent', async () => {
    const result = await handlers().create({
      ptyId: 'pty-1',
      agentSlug: 'codex',
      prompt: 'continue',
      nextRunAt: Date.now() + 60_000,
      intervalMinutes: 60,
    });
    expect(result).toMatchObject({
      ok: true,
      schedule: {
        ptyId: 'pty-1',
        agentSlug: 'codex',
        sessionIncarnationId: 'incarnation-1',
      },
    });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ ptyId: 'pty-1', intervalMinutes: 60 }),
    ]);
  });

  it('fails closed in local mode and when the requested agent does not match', async () => {
    const request = {
      ptyId: 'pty-1',
      agentSlug: 'codex',
      prompt: 'continue',
      nextRunAt: Date.now() + 60_000,
    };
    await expect(handlers(false).create(request)).resolves.toEqual({
      ok: false,
      code: 'daemon_required',
    });
    await expect(handlers(true, 'claude').create(request)).resolves.toEqual({
      ok: false,
      code: 'agent_unavailable',
    });
    expect(loadSessionPromptSchedules(dir)).toEqual([]);
  });

  it('rejects malformed payloads without throwing or leaking the global list', async () => {
    for (const raw of [null, [], 'bad', 7]) {
      await expect(handlers().list(raw)).resolves.toEqual({ schedules: [], available: true });
      await expect(handlers().create(raw)).resolves.toEqual({
        ok: false,
        code: 'invalid_agent',
      });
    }
  });

  it('scopes list, update, and delete to both ptyId and schedule id', async () => {
    await saveSessionPromptSchedules([schedule('same', 'pty-1'), schedule('same', 'pty-2')], dir);
    await expect(handlers().list({ ptyId: 'pty-1' })).resolves.toEqual({
      schedules: [expect.objectContaining({ ptyId: 'pty-1' })],
      available: true,
    });
    await expect(handlers().list({ includeAll: true })).resolves.toEqual({
      schedules: [
        expect.objectContaining({ ptyId: 'pty-1' }),
        expect.objectContaining({ ptyId: 'pty-2' }),
      ],
      available: true,
    });

    await expect(handlers().update({ ptyId: 'pty-x', id: 'same', enabled: false }))
      .resolves.toEqual({ ok: false, code: 'not_found' });
    await expect(handlers().update({ ptyId: 'pty-2', id: 'same', enabled: false }))
      .resolves.toEqual({ ok: true });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ ptyId: 'pty-1', enabled: true }),
      expect.objectContaining({ ptyId: 'pty-2', enabled: false }),
    ]);
    await handlers().remove({ ptyId: 'pty-1', id: 'same' });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ ptyId: 'pty-2', enabled: false }),
    ]);
  });

  it('does not resume a row whose session incarnation can no longer be proven', async () => {
    const changed = schedule('changed');
    changed.enabled = false;
    changed.lastResult = 'session_changed';
    await saveSessionPromptSchedules([changed], dir);

    await expect(handlers().update({
      ptyId: 'pty-1',
      id: 'changed',
      enabled: true,
    })).resolves.toEqual({ ok: false, code: 'session_changed' });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ id: 'changed', enabled: false, lastResult: 'session_changed' }),
    ]);
  });

  it('persists the terminal migration when a legacy row is resumed', async () => {
    const legacy = schedule('legacy');
    delete legacy.sessionIncarnationId;
    legacy.deliveryClaim = { token: 'claim', occurrenceAt: 1, startedAt: 1 };
    await saveSessionPromptSchedules([legacy], dir);

    await expect(handlers().update({
      ptyId: 'pty-1',
      id: 'legacy',
      enabled: true,
    })).resolves.toEqual({ ok: false, code: 'session_changed' });
    const persisted = JSON.parse(
      fs.readFileSync(getSessionPromptSchedulesPath(dir), 'utf8'),
    ) as SessionPromptSchedule[];
    expect(persisted).toEqual([
      expect.objectContaining({
        id: 'legacy',
        enabled: false,
        lastResult: 'session_changed',
      }),
    ]);
    expect(persisted[0]).not.toHaveProperty('deliveryClaim');
  });

  it.each([
    { slug: 'codex' as const, incarnationId: 'incarnation-2' },
    { slug: 'claude' as const, incarnationId: 'incarnation-1' },
  ])('marks a paused row terminal when its live binding changes to %j', async (state) => {
    const paused = schedule('paused');
    paused.enabled = false;
    await saveSessionPromptSchedules([paused], dir);
    const ipc = createSessionPromptScheduleHandlers({
      available: true,
      getAgentState: async () => ({ ...state, agentVerified: true }),
      dir,
    });

    await expect(ipc.update({
      ptyId: 'pty-1',
      id: 'paused',
      enabled: true,
    })).resolves.toEqual({ ok: false, code: 'session_changed' });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ id: 'paused', enabled: false, lastResult: 'session_changed' }),
    ]);
  });

  it('resumes a paused row only when the live session binding still matches', async () => {
    const paused = schedule('paused');
    paused.enabled = false;
    await saveSessionPromptSchedules([paused], dir);

    await expect(handlers().update({
      ptyId: 'pty-1',
      id: 'paused',
      enabled: true,
    })).resolves.toEqual({ ok: true });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ id: 'paused', enabled: true }),
    ]);
  });

  it('refuses to schedule a live-but-unverified pane (#1307)', async () => {
    const request = {
      ptyId: 'pty-1',
      agentSlug: 'codex',
      prompt: 'continue',
      nextRunAt: Date.now() + 60_000,
    };
    await expect(handlers(true, 'codex', false).create(request)).resolves.toEqual({
      ok: false,
      code: 'agent_unavailable',
    });
    expect(loadSessionPromptSchedules(dir)).toEqual([]);
  });

  it('resumes a live-but-unverified pane whose slug and incarnation still match — the #1307 regression guard', async () => {
    const paused = schedule('paused');
    paused.enabled = false;
    await saveSessionPromptSchedules([paused], dir);

    await expect(handlers(true, 'codex', false).update({
      ptyId: 'pty-1',
      id: 'paused',
      enabled: true,
    })).resolves.toEqual({ ok: true });
    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({ id: 'paused', enabled: true }),
    ]);
  });

  it.each(['missing', 'rejected'] as const)(
    'preserves a paused schedule through a %s lookup and revalidates on retry',
    async (failure) => {
      const paused = { ...schedule('paused'), enabled: false, lastResult: 'busy' as const };
      await saveSessionPromptSchedules([paused], dir);
      const getAgentState = vi.fn(async () => ({
        slug: 'codex' as const, incarnationId: 'incarnation-1', agentVerified: true,
      }) as { slug: 'codex'; incarnationId: string; agentVerified: boolean } | null);
      if (failure === 'missing') getAgentState.mockResolvedValueOnce(null);
      else getAgentState.mockRejectedValueOnce(new Error('daemon disconnected'));
      const ipc = createSessionPromptScheduleHandlers({ available: true, getAgentState, dir });
      const request = { ptyId: 'pty-1', id: 'paused', enabled: true };

      await expect(ipc.update(request)).resolves.toEqual({ ok: false, code: 'agent_unavailable' });
      // Inspect disk, not just the loader: a sanitizer must not mask data loss.
      expect(JSON.parse(fs.readFileSync(getSessionPromptSchedulesPath(dir), 'utf8')))
        .toEqual([paused]);

      await expect(ipc.update(request)).resolves.toEqual({ ok: true });
      expect(getAgentState).toHaveBeenCalledTimes(2);
      expect(loadSessionPromptSchedules(dir)).toEqual([{ ...paused, enabled: true }]);
    },
  );

  it('still refuses a replacement session after an unavailable lookup', async () => {
    await saveSessionPromptSchedules([{ ...schedule('paused'), enabled: false }], dir);
    const getAgentState = vi.fn(async () => ({
      slug: 'codex' as const, incarnationId: 'incarnation-2', agentVerified: true,
    }) as { slug: 'codex'; incarnationId: string; agentVerified: boolean } | null)
      .mockResolvedValueOnce(null);
    const ipc = createSessionPromptScheduleHandlers({ available: true, getAgentState, dir });
    const request = { ptyId: 'pty-1', id: 'paused', enabled: true };

    await expect(ipc.update(request)).resolves.toEqual({ ok: false, code: 'agent_unavailable' });
    await expect(ipc.update(request)).resolves.toEqual({ ok: false, code: 'session_changed' });
    const persisted = JSON.parse(fs.readFileSync(getSessionPromptSchedulesPath(dir), 'utf8'));
    expect(persisted).toEqual([
      expect.objectContaining({ enabled: false, lastResult: 'session_changed' }),
    ]);
    expect(persisted[0]).not.toHaveProperty('deliveryClaim');
  });

  it('refuses resume in local mode without invalidating the binding or querying the daemon', async () => {
    const paused = { ...schedule('paused'), enabled: false };
    await saveSessionPromptSchedules([paused], dir);
    const getAgentState = vi.fn(async () => ({
      slug: 'codex' as const, incarnationId: 'incarnation-1', agentVerified: true,
    }));
    const ipc = createSessionPromptScheduleHandlers({ available: false, getAgentState, dir });

    await expect(ipc.update({ ptyId: 'pty-1', id: 'paused', enabled: true }))
      .resolves.toEqual({ ok: false, code: 'daemon_required' });
    expect(getAgentState).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(getSessionPromptSchedulesPath(dir), 'utf8'))).toEqual([paused]);
  });

  it('pauses an already-enabled row on unavailable validation without discarding its delivery claim', async () => {
    const active = {
      ...schedule('active'),
      deliveryClaim: { token: 'in-flight', occurrenceAt: Date.now(), startedAt: Date.now() },
    };
    await saveSessionPromptSchedules([active], dir);

    await expect(handlers(true, null).update({ ptyId: 'pty-1', id: 'active', enabled: true }))
      .resolves.toEqual({ ok: false, code: 'agent_unavailable' });
    expect(JSON.parse(fs.readFileSync(getSessionPromptSchedulesPath(dir), 'utf8')))
      .toEqual([{ ...active, enabled: false }]);
  });

  it('allows pause and delete without querying an unavailable daemon', async () => {
    await saveSessionPromptSchedules([schedule('active')], dir);
    const getAgentState = vi.fn(async () => { throw new Error('daemon disconnected'); });
    const ipc = createSessionPromptScheduleHandlers({ available: false, getAgentState, dir });

    await expect(ipc.update({ ptyId: 'pty-1', id: 'active', enabled: false }))
      .resolves.toEqual({ ok: true });
    expect(loadSessionPromptSchedules(dir)[0].enabled).toBe(false);
    await expect(ipc.remove({ ptyId: 'pty-1', id: 'active' })).resolves.toEqual({ ok: true });
    expect(getAgentState).not.toHaveBeenCalled();
    expect(loadSessionPromptSchedules(dir)).toEqual([]);
  });

  it('enforces the global schedule cap inside the serialized mutation', async () => {
    await saveSessionPromptSchedules(
      Array.from(
        { length: SESSION_PROMPT_SCHEDULE_LIMITS.MAX_SCHEDULES },
        (_, index) => schedule(`schedule-${index}`),
      ),
      dir,
    );
    await expect(handlers().create({
      ptyId: 'pty-1',
      agentSlug: 'codex',
      prompt: 'one more',
      nextRunAt: Date.now() + 60_000,
    })).resolves.toEqual({ ok: false, code: 'limit' });
  });
});
