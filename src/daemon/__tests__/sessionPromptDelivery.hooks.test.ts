import { describe, expect, it } from 'vitest';
import { deliverScheduledPrompt, type ScheduledPromptAgentState } from '../sessionPromptDelivery';

function harness(authorize: (call: number) => boolean, leadingPastes?: string[]) {
  let current: ScheduledPromptAgentState = { slug: 'claude', incarnationId: 'i', status: 'complete', inputQuiet: true, inputRevision: 0 };
  const log: string[] = [];
  let calls = 0;
  const run = () => deliverScheduledPrompt('claude', 'i', 'hi', {
    getAgentState: () => { log.push('state'); return current; },
    isAgentProcessAlive: async () => { log.push('alive'); return true; },
    write: (data) => { log.push(`write:${JSON.stringify(data)}`); current = { ...current, inputRevision: current.inputRevision + 1 }; return true; },
    delay: async () => { log.push('delay'); },
    authorized: async (stage) => { log.push(`auth:${stage}`); return authorize(++calls); },
    onWrite: (stage) => { log.push(`on:${stage}`); },
    ...(leadingPastes ? { leadingPastes } : {}),
  });
  return { run, log };
}

describe('deliverScheduledPrompt re-authorization hooks', () => {
  it('re-authorizes right before the paste and again as the last await before Enter', async () => {
    const h = harness(() => true);
    expect(await h.run()).toBe('sent');
    expect(h.log).toEqual(['state', 'alive', 'auth:first-write', 'write:"\\u001b[200~hi\\u001b[201~"', 'on:paste', 'delay',
      'alive', 'auth:submit', 'state', 'on:submit', 'write:"\\r"']);
  });

  it('writes nothing when refused before the paste', async () => {
    const h = harness(() => false);
    expect(await h.run()).toBe('error');
    expect(h.log.some(entry => entry.startsWith('write') || entry.startsWith('on:'))).toBe(false);
  });

  it('never presses Enter when refused after the paste', async () => {
    const h = harness(call => call === 1);
    expect(await h.run()).toBe('error');
    expect(h.log.filter(entry => entry.startsWith('write'))).toEqual(['write:"\\u001b[200~hi\\u001b[201~"']);
    expect(h.log).not.toContain('on:submit');
  });

  it('fences the first leading paste and Enter after the pastes', async () => {
    const ok = harness(() => true, ['/tmp/a.png']);
    expect(await ok.run()).toBe('sent');
    expect(ok.log).toEqual(['state', 'alive', 'auth:first-write', 'write:"\\u001b[200~/tmp/a.png\\u001b[201~"', 'on:paste', 'delay',
      'state', 'write:"\\u001b[200~ hi\\u001b[201~"', 'on:paste', 'delay', 'alive', 'auth:submit', 'state', 'on:submit', 'write:"\\r"']);

    // Revoked before the first write: not even the image path reaches the PTY.
    const early = harness(() => false, ['/tmp/a.png']);
    expect(await early.run()).toBe('error');
    expect(early.log.some(entry => entry.startsWith('write') || entry.startsWith('on:'))).toBe(false);

    // Revoked before Enter: both pastes are in the composer, Enter never is.
    const late = harness(call => call === 1, ['/tmp/a.png']);
    expect(await late.run()).toBe('error');
    expect(late.log.filter(entry => entry.startsWith('write'))).toEqual([
      'write:"\\u001b[200~/tmp/a.png\\u001b[201~"', 'write:"\\u001b[200~ hi\\u001b[201~"']);
    expect(late.log).not.toContain('on:submit');
  });

  it('reports a paste only once its write succeeded, or threw (it may have reached the PTY)', async () => {
    const run = (write: (data: string) => boolean) => {
      const log: string[] = [];
      const state: ScheduledPromptAgentState = { slug: 'claude', incarnationId: 'i', status: 'complete', inputQuiet: true, inputRevision: 0 };
      const result = deliverScheduledPrompt('claude', 'i', 'hi', {
        getAgentState: () => state, isAgentProcessAlive: async () => true, write, delay: async () => undefined,
        onWrite: (stage) => { log.push(`on:${stage}`); },
      });
      return { result, log };
    };
    const refused = run(() => false);
    expect(await refused.result).toBe('unavailable');
    expect(refused.log).toEqual([]);
    const threw = run(() => { throw new Error('EPIPE'); });
    expect(await threw.result).toBe('error');
    expect(threw.log).toEqual(['on:paste']);
  });
});
