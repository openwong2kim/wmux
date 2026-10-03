import { describe, expect, it, vi } from 'vitest';
import { newChatSession } from '../../../../shared/chatv2/session';
import { handOffToTerminal, handedOffRefusal, resumeCommand, type ChatV2HandoffDeps, type ProcessProbe, type ResumeShell } from '../handoff';
import type { ChatV2StoredRecord } from '../types';

const PROVIDER_ID = '0199f1c2-0000-4000-8000-000000000001';

const record = (over: Partial<ChatV2StoredRecord> = {}): ChatV2StoredRecord => ({
  version: 1, paneId: 'p1', chatSessionId: 'c1', agent: 'claude', mode: 'default', model: '', state: 'active',
  providerSessionId: PROVIDER_ID, seq: 4, session: newChatSession({ id: 'c1', harness: 'claude', cwd: '/w/repo' }),
  bodies: {}, sends: [], process: { pid: 4242, startTime: 'T0', marker: PROVIDER_ID }, savedAt: 1,
  ...over,
});

/** A fake world: `probe` is what signal 0 says about the driver pid, `alive` whether it is still the driver. */
function world(state: { probe: ProcessProbe; alive: boolean } = { probe: 'gone', alive: false }) {
  const steps: string[] = [];
  const written: string[] = [];
  let revision: number | null = 7;
  const deps = {
    paneFree: vi.fn(async () => { steps.push('paneFree'); return true; }),
    promptRevision: vi.fn((): number | null => revision),
    shellKind: vi.fn((): ResumeShell | null => 'posix'),
    probe: vi.fn((): ProcessProbe => state.probe),
    processIdentity: vi.fn(async () => (state.alive ? { startTime: 'T0', commandLine: `claude -p --resume ${PROVIDER_ID}` } : null)),
    persist: vi.fn(async (r: ChatV2StoredRecord) => { steps.push(`persist:${r.state}`); }),
    writeToPane: vi.fn((_id: string, data: string) => { steps.push('type'); written.push(data); return true; }),
  } satisfies ChatV2HandoffDeps;
  return { deps, steps, written, setRevision: (r: number | null) => { revision = r; } };
}

const stoppingDriver = (state: { probe: ProcessProbe; alive: boolean }, steps: string[]) => ({
  pid: 4242,
  stop: vi.fn(async () => { steps.push('stop'); state.probe = 'gone'; state.alive = false; }),
});

describe('chat → terminal handoff', () => {
  it('stops the driver, proves it exited, writes the tombstone, then types the resume command', async () => {
    const state = { probe: 'exists' as ProcessProbe, alive: true };
    const { deps, steps, written } = world(state);
    const result = await handOffToTerminal(deps, { record: record(), driver: stoppingDriver(state, steps) });
    expect(result).toMatchObject({ ok: true, record: { state: 'handed-off' } });
    expect(result.ok && result.record.process).toBeUndefined();
    expect(steps).toEqual(['stop', 'paneFree', 'persist:handed-off', 'paneFree', 'type']);
    expect(written).toEqual([`cd -- '/w/repo' && claude --resume ${PROVIDER_ID}\r`]);
  });

  it('resumes with the same model and permission mode, quoted for the shell', () => {
    const r = record({ mode: 'bypass', model: 'claude-opus-5-5[1m]', session: newChatSession({ id: 'c1', harness: 'claude', cwd: "/w/it's here" }) });
    expect(resumeCommand(r)).toBe(`cd -- '/w/it'\\''s here' && claude --resume ${PROVIDER_ID} '--model=claude-opus-5-5[1m]' --dangerously-skip-permissions\r`);
    expect(resumeCommand(record({ providerSessionId: `${PROVIDER_ID}; rm x` }))).toBeNull();
    // PowerShell (5.1 has no `&&`): the agent runs only if the directory change worked.
    const win = record({ mode: 'bypass', model: 'opus', session: newChatSession({ id: 'c1', harness: 'claude', cwd: "C:\\Users\\me\\it's ‘here’" }) });
    expect(resumeCommand(win, 'pwsh')).toBe(
      `if (Set-Location -LiteralPath 'C:\\Users\\me\\it''s ‘‘here’’' -PassThru -ErrorAction SilentlyContinue) `
      + `{ claude --resume ${PROVIDER_ID} '--model=opus' --dangerously-skip-permissions }\r`);
    expect(resumeCommand(record({ session: newChatSession({ id: 'c1', harness: 'claude', cwd: '/w\nrm x' }) }))).toBeNull();
  });

  it('refuses while the driver is still alive, or when its state cannot be read', async () => {
    for (const state of [
      { probe: 'exists' as ProcessProbe, alive: true },
      { probe: 'exists' as ProcessProbe, alive: false }, // exists, identity unreadable
      { probe: 'unknown' as ProcessProbe, alive: false },
    ]) {
      const { deps } = world(state);
      const result = await handOffToTerminal(deps, { record: record(), driver: { pid: 4242, stop: vi.fn(async () => undefined) } });
      expect(result).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
      expect(deps.persist).not.toHaveBeenCalled();
      expect(deps.writeToPane).not.toHaveBeenCalled();
    }
  });

  it('reads a reused pid (another start time, no conversation id) as exited', async () => {
    const { deps } = world({ probe: 'exists', alive: false });
    deps.processIdentity.mockImplementation(async () => ({ startTime: 'T9', commandLine: '/bin/zsh' }));
    expect((await handOffToTerminal(deps, { record: record(), driver: null })).ok).toBe(true);
  });

  it('refuses before stopping anything in a shell the command is not written for (cmd.exe, WSL)', async () => {
    const { deps } = world();
    deps.shellKind.mockImplementation(() => null);
    const driver = { pid: 4242, stop: vi.fn(async () => undefined) };
    expect(await handOffToTerminal(deps, { record: record(), driver })).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(driver.stop).not.toHaveBeenCalled();
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('types the PowerShell form into a PowerShell pane', async () => {
    const { deps, written } = world();
    deps.shellKind.mockImplementation(() => 'pwsh');
    expect((await handOffToTerminal(deps, { record: record(), driver: null })).ok).toBe(true);
    expect(written).toEqual([`if (Set-Location -LiteralPath '/w/repo' -PassThru -ErrorAction SilentlyContinue) { claude --resume ${PROVIDER_ID} }\r`]);
  });

  it('refuses before stopping anything when the id is not a UUID', async () => {
    const { deps } = world();
    const driver = { pid: 4242, stop: vi.fn(async () => undefined) };
    const bad = await handOffToTerminal(deps, { record: record({ providerSessionId: `${PROVIDER_ID}; rm x` }), driver });
    expect(bad).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(driver.stop).not.toHaveBeenCalled();
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('checks the shell after the driver exited, and leaves no tombstone when it is busy or not at an empty prompt', async () => {
    const busy = world();
    busy.deps.paneFree.mockImplementation(async () => { busy.steps.push('paneFree'); return false; });
    const state = { probe: 'exists' as ProcessProbe, alive: true };
    expect(await handOffToTerminal(busy.deps, { record: record(), driver: stoppingDriver(state, busy.steps) }))
      .toMatchObject({ ok: false, error: { message: 'The terminal is busy.' } });
    expect(busy.steps).toEqual(['stop', 'paneFree']);
    const typing = world();
    typing.setRevision(null);
    expect(await handOffToTerminal(typing.deps, { record: record(), driver: null }))
      .toMatchObject({ ok: false, error: { message: 'The terminal prompt is not empty.' } });
    for (const w of [busy, typing]) {
      expect(w.deps.persist).not.toHaveBeenCalled();
      expect(w.deps.writeToPane).not.toHaveBeenCalled();
    }
  });

  it('types nothing when the tombstone cannot be saved', async () => {
    const { deps } = world();
    deps.persist.mockImplementation(async () => { throw new Error('disk full'); });
    expect(await handOffToTerminal(deps, { record: record(), driver: null })).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(deps.writeToPane).not.toHaveBeenCalled();
  });

  it('rolls the tombstone back when the shell changed before typing, and reports what is on disk', async () => {
    const w = world();
    w.deps.persist.mockImplementation(async (r: ChatV2StoredRecord) => { w.steps.push(`persist:${r.state}`); w.setRevision(8); });
    const result = await handOffToTerminal(w.deps, { record: record(), driver: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'handoff-refused' }, record: { state: 'active' } });
    expect(w.steps).toEqual(['paneFree', 'persist:handed-off', 'paneFree', 'persist:active']);
    expect(w.deps.writeToPane).not.toHaveBeenCalled();

    const failed = world();
    failed.deps.writeToPane.mockImplementation(() => false);
    failed.deps.persist.mockImplementation(async (r: ChatV2StoredRecord) => { if (r.state === 'active') throw new Error('disk full'); });
    expect(await handOffToTerminal(failed.deps, { record: record(), driver: null }))
      .toMatchObject({ ok: false, record: { state: 'handed-off' } });
  });

  it('refuses a second handoff of the same pane while one is in flight', async () => {
    const { deps } = world();
    let release!: () => void;
    const driver = { pid: 4242, stop: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })) };
    const first = handOffToTerminal(deps, { record: record(), driver });
    expect(await handOffToTerminal(deps, { record: record(), driver: null }))
      .toMatchObject({ ok: false, error: { message: 'This chat is already moving to the terminal.' } });
    release();
    expect((await first).ok).toBe(true);
    expect(deps.writeToPane).toHaveBeenCalledTimes(1);
  });

  it('the tombstone blocks every later send and a second handoff', async () => {
    const { deps } = world();
    const result = await handOffToTerminal(deps, { record: record(), driver: null });
    if (!result.ok) throw new Error('handoff failed');
    expect(handedOffRefusal(record())).toBeNull();
    expect(handedOffRefusal(result.record)).toMatchObject({ ok: false, error: { code: 'handed-off' } });
    expect(await handOffToTerminal(deps, { record: result.record, driver: null })).toMatchObject({ ok: false, error: { code: 'handed-off' } });
    expect(deps.writeToPane).toHaveBeenCalledTimes(1);
  });
});
