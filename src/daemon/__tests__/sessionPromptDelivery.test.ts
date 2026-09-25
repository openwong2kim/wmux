import { describe, expect, it, vi } from 'vitest';
import {
  deliverScheduledPrompt,
  type ScheduledPromptAgentState,
} from '../sessionPromptDelivery';

function state(overrides: Partial<ScheduledPromptAgentState> = {}): ScheduledPromptAgentState {
  return {
    slug: 'codex',
    incarnationId: 'incarnation-1',
    status: 'idle',
    inputQuiet: true,
    inputRevision: 7,
    ...overrides,
  };
}

const alwaysAlive = async () => true;

describe('deliverScheduledPrompt', () => {
  it('accepts a quiet idle agent and submits a bracketed multiline paste', async () => {
    let current = state();
    const writes: string[] = [];
    const result = await deliverScheduledPrompt('codex', 'incarnation-1', 'line one\nline two', {
      getAgentState: () => current,
      isAgentProcessAlive: alwaysAlive,
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
    const result = await deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: alwaysAlive,
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
      const isAgentProcessAlive = vi.fn(alwaysAlive);
      await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
        getAgentState: () => state(overrides),
        isAgentProcessAlive,
        write,
      })).resolves.toBe('busy');
      expect(write).not.toHaveBeenCalled();
      // Busy is decided before the liveness probe — no point confirming a
      // process is alive when the agent isn't ready for input anyway.
      expect(isAgentProcessAlive).not.toHaveBeenCalled();
    }
  });

  it('does not turn a stale agent prompt into shell or other-agent input', async () => {
    for (const current of [null, state({ slug: 'claude' })]) {
      const write = vi.fn(() => true);
      const isAgentProcessAlive = vi.fn(alwaysAlive);
      await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
        getAgentState: () => current,
        isAgentProcessAlive,
        write,
      })).resolves.toBe('unavailable');
      expect(write).not.toHaveBeenCalled();
      expect(isAgentProcessAlive).not.toHaveBeenCalled();
    }
  });

  it('permanently rejects a replacement session before writing', async () => {
    const write = vi.fn(() => true);
    const isAgentProcessAlive = vi.fn(alwaysAlive);
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => state({ incarnationId: 'incarnation-2' }),
      isAgentProcessAlive,
      write,
    })).resolves.toBe('session_changed');
    expect(write).not.toHaveBeenCalled();
    expect(isAgentProcessAlive).not.toHaveBeenCalled();
  });

  it('refuses delivery when the fresh liveness probe reports the process dead', async () => {
    const write = vi.fn(() => true);
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => state(),
      isAgentProcessAlive: async () => false,
      write,
    })).resolves.toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses delivery when the liveness probe throws', async () => {
    const write = vi.fn(() => true);
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => state(),
      isAgentProcessAlive: async () => {
        throw new Error('process table enumeration failed');
      },
      write,
    })).resolves.toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not press Enter when the agent process exits after the paste', async () => {
    let current = state();
    let alive = true;
    const writes: string[] = [];
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: async () => alive,
      write: (data) => {
        writes.push(data);
        current = { ...current, inputRevision: current.inputRevision + 1 };
        alive = false;
        return true;
      },
      delay: async () => undefined,
    })).resolves.toBe('error');
    expect(writes).toEqual(['\x1b[200~continue\x1b[201~']);
  });

  it('does not press Enter when a keystroke lands during the pre-Enter liveness probe', async () => {
    let current = state();
    let probes = 0;
    const writes: string[] = [];
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: async () => {
        probes += 1;
        // A human types while the second (slow) probe runs.
        if (probes === 2) current = { ...current, inputRevision: current.inputRevision + 1 };
        return true;
      },
      write: (data) => {
        writes.push(data);
        current = { ...current, inputRevision: current.inputRevision + 1 };
        return true;
      },
      delay: async () => undefined,
    })).resolves.toBe('error');
    expect(writes).toEqual(['\x1b[200~continue\x1b[201~']);
  });

  it('checks liveness after the readiness gate, before the paste, and again before Enter', async () => {
    const order: string[] = [];
    let current = state();
    const write = vi.fn(() => {
      order.push('write');
      current = { ...current, inputRevision: current.inputRevision + 1 };
      return true;
    });
    const result = await deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: async () => {
        order.push('liveness');
        return true;
      },
      write,
      delay: async () => undefined,
    });
    expect(result).toBe('sent');
    expect(order).toEqual(['liveness', 'write', 'liveness', 'write']);
  });

  it('does not press Enter if identity, settled readiness, or input revision changes after paste', async () => {
    for (const changed of [
      state({ slug: 'claude', inputRevision: 8 }),
      state({ status: 'awaiting_input', inputRevision: 8 }),
      state({ inputRevision: 9 }),
    ]) {
      let current = state();
      const writes: string[] = [];
      await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
        getAgentState: () => current,
        isAgentProcessAlive: alwaysAlive,
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

  it('does not press Enter if the session incarnation changes after paste', async () => {
    let current = state();
    const writes: string[] = [];
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: alwaysAlive,
      write: (data) => {
        writes.push(data);
        current = state({ incarnationId: 'incarnation-2', inputRevision: 8 });
        return true;
      },
      delay: async () => undefined,
    })).resolves.toBe('error');
    expect(writes).toHaveLength(1);
  });

  it('does not treat running after a settled ready state as paste echo', async () => {
    let current = state({ status: 'waiting' });
    const writes: string[] = [];
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', 'continue', {
      getAgentState: () => current,
      isAgentProcessAlive: alwaysAlive,
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
    await expect(deliverScheduledPrompt('codex', 'incarnation-1', prompt, {
      getAgentState: () => current,
      isAgentProcessAlive: alwaysAlive,
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
  it('refuses a running agent unless the chat caller opts in', async () => {
    const running = () => {
      let current = state({ slug: 'claude', status: 'running' });
      const writes: string[] = [];
      const deps = { getAgentState: () => current, isAgentProcessAlive: alwaysAlive, delay: async () => undefined,
        write: (data: string) => { writes.push(data); current = { ...current, inputRevision: current.inputRevision + 1 }; return true; } };
      return { deps, writes };
    };
    const scheduled = running();
    expect(await deliverScheduledPrompt('claude', 'incarnation-1', 'next', scheduled.deps)).toBe('busy');
    expect(scheduled.writes).toEqual([]);
    const chat = running();
    expect(await deliverScheduledPrompt('claude', 'incarnation-1', 'next', { ...chat.deps, acceptRunning: true })).toBe('sent');
    expect(chat.writes).toEqual(['\x1b[200~next\x1b[201~', '\r']);
  });
});
