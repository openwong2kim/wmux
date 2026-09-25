import { describe, expect, it } from 'vitest';
import { deliverScheduledPrompt, type ScheduledPromptAgentState } from '../sessionPromptDelivery';

function harness(authorize: (call: number) => boolean) {
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
  });
  return { run, log };
}

describe('deliverScheduledPrompt re-authorization hooks', () => {
  it('re-authorizes right before the paste and again as the last await before Enter', async () => {
    const h = harness(() => true);
    expect(await h.run()).toBe('sent');
    expect(h.log).toEqual(['state', 'alive', 'auth:first-write', 'on:paste', 'write:"\\u001b[200~hi\\u001b[201~"', 'delay',
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
});
