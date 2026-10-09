import assert from 'node:assert/strict';
import { CommanderSessionManager } from '../../../src/main/deck/CommanderSessionManager';
import { JevFleetFastPath, JEV_ENDPOINT, JEV_MODEL } from '../../../src/main/deck/jevFleetFastPath';
import type { BrainAdapter, BrainEvent } from '../../../src/main/deck/BrainAdapter';
import type { JevConfigurePatch } from '../../../src/shared/jev';

export const DUMMY_KEY = 'dummy-jev-e2e-key';
const SCENARIOS = ['valid', 'error', 'timeout', 'malformed', 'stale'] as const;
type Scenario = typeof SCENARIOS[number];

/** Production router and turn manager; all credentials, board rows and model
 * responses are synthetic. This fixture cannot contact a provider. */
export function createJevHarness() {
  let scenario: Scenario = 'valid';
  let events: BrainEvent[] = [];
  const counts = { providerRequests: 0, normalBrainSends: 0, boardReads: 0, configurationWrites: 0 };
  const adapter: BrainAdapter = {
    sessionId: 'synthetic-normal-session',
    start() { /* No real adapter or subprocess. */ },
    async *send() {
      counts.normalBrainSends++;
      yield { type: 'text-delta', text: 'Synthetic normal Moa fallback.' };
      yield { type: 'turn-end', sessionId: 'synthetic-normal-session' };
    },
    interrupt() { /* No real adapter or subprocess. */ },
    dispose() { /* No real adapter or subprocess. */ },
  };
  const jev = new JevFleetFastPath({
    timeoutMs: 80,
    fetch: async (url, init) => {
      assert.equal(url, JEV_ENDPOINT);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${DUMMY_KEY}`);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body.state), ['query']);
      assert.equal(body.model, JEV_MODEL);
      assert(!JSON.stringify(body).includes('Synthetic board row'));
      assert(!JSON.stringify(body).includes(DUMMY_KEY));
      counts.providerRequests++;
      if (scenario === 'error') throw new Error('Synthetic transport failure');
      if (scenario === 'timeout') return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error('Synthetic aborted transport'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
      if (scenario === 'malformed') return new Response('{malformed', { status: 200 });
      return new Response(JSON.stringify({
        model: JEV_MODEL,
        answers: { intent: { type: 'choice', choice: 'status', confidence: 0.99,
          probabilities: { needs_you: 0.01, finished: 0.01, status: 0.97, fallback: 0.01 } } },
        usage: { input_tokens: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const manager = new CommanderSessionManager({ adapter, sink: (event) => { events.push(event); } });
  const readBoard = async () => {
    counts.boardReads++;
    return {
      scope: 'fleet', generatedAt: Date.now() - (scenario === 'stale' ? 20_000 : 0),
      needsYou: [{ title: 'Synthetic board row', workspaceName: 'Test workspace', reason: 'input' }],
      finished: [], running: [], idle: { count: 0 },
    };
  };
  return {
    status: () => jev.status(),
    configure: (patch: JevConfigurePatch) => {
      // This harness accepts its dummy key only, never a real credential.
      assert(patch.apiKey === undefined || patch.apiKey === DUMMY_KEY, 'Only the built-in dummy key is accepted');
      counts.configurationWrites++;
      return jev.configure(patch);
    },
    scenario: (next: string) => {
      assert(SCENARIOS.includes(next as Scenario), 'Unknown synthetic scenario');
      scenario = next as Scenario;
      return { scenario };
    },
    send: async (text: string) => {
      events = [];
      const result = await manager.send(text, {}, jev.canAttempt(text)
        ? (signal) => jev.answer(text, readBoard, signal) : undefined);
      return { result, events, counts: { ...counts }, route: result.localAnswer ? 'local' : 'normal' };
    },
    counts: () => ({ ...counts }),
    dispose: () => { jev.dispose(); manager.dispose(); },
  };
}
