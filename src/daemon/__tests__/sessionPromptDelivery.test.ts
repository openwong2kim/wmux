import { describe, expect, it, vi } from 'vitest';
import {
  deliverScheduledPrompt,
  type ScheduledPromptAgentState,
} from '../sessionPromptDelivery';

function state(overrides: Partial<ScheduledPromptAgentState> = {}): ScheduledPromptAgentState {
  return {
    slug: 'codex',
    status: 'idle',
    inputQuiet: true,
    inputRevision: 7,
    ...overrides,
  };
}

describe('deliverScheduledPrompt', () => {
  it('accepts a quiet idle agent and submits a bracketed multiline paste', async () => {
    let current = state();
    const writes: string[] = [];
    const result = await deliverScheduledPrompt('codex', 'line one\nline two', {
      getAgentState: () => current,
      write: (data) => {
        writes.push(data);
        current = { ...current, inputRevision: current.inputRevision + 1 };
        return true;
      },
      delay: async () => undefined,
    });

    expect(result).toBe('sent');
    expect(writes).toEqual([
      '\x1b[200~line one\nline two\x1b[201~',
      '\r\r',
    ]);
  });

  it('submits when paste echo temporarily promotes an idle pane to running', async () => {
    let current = state();
    const writes: string[] = [];
    const result = await deliverScheduledPrompt('codex', 'continue', {
      getAgentState: () => current,
      write: (data) => {
        writes.push(data);
        if (writes.length === 1) {
          current = state({ status: 'running', inputRevision: 8 });
        }
        return true;
      },
      delay: async () => undefined,
    });

    expect(result).toBe('sent');
    expect(writes).toEqual(['\x1b[200~continue\x1b[201~', '\r']);
  });

  it('waits through running, approval, error, and recent human input states', async () => {
    const cases: Array<Partial<ScheduledPromptAgentState>> = [
      { status: 'running' },
      { status: 'awaiting_input' },
      { status: 'error' },
      { status: 'waiting', inputQuiet: false },
    ];
    for (const overrides of cases) {
      const write = vi.fn(() => true);
      await expect(deliverScheduledPrompt('codex', 'continue', {
        getAgentState: () => state(overrides),
        write,
      })).resolves.toBe('busy');
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('does not turn a stale agent prompt into shell or other-agent input', async () => {
    for (const current of [null, state({ slug: 'claude' })]) {
      const write = vi.fn(() => true);
      await expect(deliverScheduledPrompt('codex', 'continue', {
        getAgentState: () => current,
        write,
      })).resolves.toBe('unavailable');
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('does not press Enter if identity, settled readiness, or input revision changes after paste', async () => {
    for (const changed of [
      state({ slug: 'claude', inputRevision: 8 }),
      state({ status: 'awaiting_input', inputRevision: 8 }),
      state({ inputRevision: 9 }),
    ]) {
      let current = state();
      const writes: string[] = [];
      await expect(deliverScheduledPrompt('codex', 'continue', {
        getAgentState: () => current,
        write: (data) => {
          writes.push(data);
          current = changed;
          return true;
        },
        delay: async () => undefined,
      })).resolves.toBe('error');
      expect(writes).toHaveLength(1);
    }
  });

  it('does not treat running after a settled ready state as paste echo', async () => {
    let current = state({ status: 'waiting' });
    const writes: string[] = [];
    await expect(deliverScheduledPrompt('codex', 'continue', {
      getAgentState: () => current,
      write: (data) => {
        writes.push(data);
        current = state({ status: 'running', inputRevision: 8 });
        return true;
      },
      delay: async () => undefined,
    })).resolves.toBe('error');
    expect(writes).toHaveLength(1);
  });

  it('cannot escape bracketed paste with an embedded end marker or raw controls', async () => {
    let current = state({ status: 'complete' });
    const writes: string[] = [];
    const prompt = `before\x1b[201~after\rline`;
    await expect(deliverScheduledPrompt('codex', prompt, {
      getAgentState: () => current,
      write: (data) => {
        writes.push(data);
        current = { ...current, inputRevision: current.inputRevision + 1 };
        return true;
      },
      delay: async () => undefined,
    })).resolves.toBe('sent');

    expect(writes[0]).toBe('\x1b[200~before␛[201~after\rline\x1b[201~');
    expect(writes[0].split('\x1b[201~')).toHaveLength(2);
    expect(writes[1]).toBe('\r\r');
  });
});
