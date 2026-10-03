import { describe, expect, it, vi } from 'vitest';
import { newChatSession } from '../../../../shared/chatv2/session';
import { handOffToTerminal, handedOffRefusal, type ChatV2HandoffDeps } from '../handoff';
import type { ChatV2StoredRecord } from '../types';

const PROVIDER_ID = '0199f1c2-0000-4000-8000-000000000001';

const record = (over: Partial<ChatV2StoredRecord> = {}): ChatV2StoredRecord => ({
  version: 1, paneId: 'p1', chatSessionId: 'c1', agent: 'claude', mode: 'default', model: '', state: 'active',
  providerSessionId: PROVIDER_ID, seq: 4, session: newChatSession({ id: 'c1', harness: 'claude', cwd: '/w' }),
  bodies: {}, sends: [], process: { pid: 4242, startTime: 'T0', marker: PROVIDER_ID }, savedAt: 1,
  ...over,
});

/** A fake world: `alive` is what the process table says about the driver pid. */
function world(alive: () => boolean) {
  const steps: string[] = [];
  const deps: ChatV2HandoffDeps & { written: string[] } = {
    written: [],
    paneFree: vi.fn(async () => true),
    processIdentity: vi.fn(async () => (alive() ? { startTime: 'T0', commandLine: `claude -p --resume ${PROVIDER_ID}` } : null)),
    persist: vi.fn(async (r: ChatV2StoredRecord) => { steps.push(`persist:${r.state}`); }),
    writeToPane: vi.fn((_id: string, data: string) => { steps.push('type'); deps.written.push(data); return true; }),
  };
  return { deps, steps };
}

describe('chat → terminal handoff', () => {
  it('stops the driver, proves it exited, writes the tombstone, then types the resume command', async () => {
    let running = true;
    const { deps, steps } = world(() => running);
    const driver = { pid: 4242, stop: vi.fn(async () => { steps.push('stop'); running = false; }) };
    const result = await handOffToTerminal(deps, { record: record(), driver });
    expect(result).toMatchObject({ ok: true, record: { state: 'handed-off' } });
    expect(result.ok && result.record.process).toBeUndefined();
    expect(steps).toEqual(['stop', 'persist:handed-off', 'type']);
    expect(deps.written).toEqual([`claude --resume ${PROVIDER_ID}\r`]);
  });

  it('refuses while the driver is still alive: no tombstone, nothing typed', async () => {
    const { deps } = world(() => true);
    const driver = { pid: 4242, stop: vi.fn(async () => undefined) };
    const result = await handOffToTerminal(deps, { record: record(), driver });
    expect(result).toEqual({ ok: false, error: { code: 'handoff-refused', message: 'The chat agent is still running.' } });
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('reads a reused pid (another start time, no conversation id) as exited', async () => {
    const { deps } = world(() => true);
    deps.processIdentity = vi.fn(async () => ({ startTime: 'T9', commandLine: '/bin/zsh' }));
    const result = await handOffToTerminal(deps, { record: record(), driver: null });
    expect(result.ok).toBe(true);
  });

  it('refuses before stopping anything when the id is not a UUID or the shell is busy', async () => {
    const { deps } = world(() => false);
    const driver = { pid: 4242, stop: vi.fn(async () => undefined) };
    const bad = await handOffToTerminal(deps, { record: record({ providerSessionId: `${PROVIDER_ID}; rm x` }), driver });
    expect(bad).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    deps.paneFree = vi.fn(async () => false);
    expect(await handOffToTerminal(deps, { record: record(), driver })).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(driver.stop).not.toHaveBeenCalled();
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('types nothing when the tombstone cannot be saved', async () => {
    const { deps } = world(() => false);
    deps.persist = vi.fn(async () => { throw new Error('disk full'); });
    expect(await handOffToTerminal(deps, { record: record(), driver: null })).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('the tombstone blocks every later send and a second handoff', async () => {
    const { deps } = world(() => false);
    const result = await handOffToTerminal(deps, { record: record(), driver: null });
    if (!result.ok) throw new Error('handoff failed');
    expect(handedOffRefusal(record())).toBeNull();
    expect(handedOffRefusal(result.record)).toMatchObject({ ok: false, error: { code: 'handed-off' } });
    expect(await handOffToTerminal(deps, { record: result.record, driver: null })).toMatchObject({ ok: false, error: { code: 'handed-off' } });
    expect(deps.writeToPane).toHaveBeenCalledTimes(1);
  });
});
