// In-process factory loop, gh faked: a trusted pr.opened wakes the Verifier
// (real fact log → trigger engine → wake queue → bot runtime on a stub
// engine), whose turn records a PASS with evidence (real verdict store →
// verdict.recorded fact → room card); ci.green then lets the merge lane host
// evaluate the head: with lane auto-merge off a ready card lands in the PR
// thread; with it on and every predicate passing the executor merges once.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../deck/BrainAdapter';
import type { Fact } from '../../../shared/facts';
import type { LedgerEntry } from '../../../shared/ledger';
import type { PrLaneFacts, PrWriteResult } from '../../../shared/prReview';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../../../shared/factorySettings';
import { createFactLog, type FactLog } from '../factLog';
import { BotStore, botsFilePath } from '../botStore';
import { WakeQueue, wakeQueuePath } from '../wakeQueue';
import { BotRuntime, BotSessionStore, botSessionsPath, __resetBotRuntimePortsForTesting, setBotRuntimePorts } from '../BotRuntime';
import { TriggerEngine } from '../triggerEngine';
import { RoomWriter, writeFactCards } from '../roomWriter';
import { HandoffRouter, HANDOFFS_FILENAME, deckDecisionPort, summarizeHandoff, setHandoffRouter } from '../handoffRouter';
import { startFactIngest } from '../factIngest';
import { resolveFactsFrom, routedFactLog, threadTail } from '../factoryWiring';
import { MergeLaneHost } from '../mergeLaneHost';
import { MoaEffectStore } from '../../deck/moaEffectStore';
import { MoaMergeExecutor } from '../../deck/moaMergeExecutor';
import { PrVerdictStore, onPrVerdictRecorded } from '../../github/prVerdictStore';
import { __resetBotHooksForTesting } from '../botHooks';

const KEY = 'github.com/o/r';
const HEAD = 'd'.repeat(40);
const BRANCH = 'wtask/fix-login-ab12cd34';
const VERIFY_TASK = 'wtask-verify-1';

const LANE_FACTS: PrLaneFacts = {
  number: 3, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: BRANCH, baseRefName: 'main',
  author: 'alice', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
  mergeStateStatus: 'CLEAN',
};

/** The ledger rows main wrote: the lead's task on the PR branch and the
 *  verifier's detached verify task with its system gate at the head. */
function ledgerRows(verifierId: string): LedgerEntry[] {
  return [
    {
      schemaVersion: 1, id: 'wtask-lead-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-1', title: 'fix login', status: 'review_requested',
      rev: 3, updatedAt: 1, updatedBy: { kind: 'worker', workspaceId: 'ws-task' }, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000l', tainted: false }, preset: 'default' },
    },
    {
      schemaVersion: 1, id: VERIFY_TASK, taskWorkspaceId: 'ws-v', ownerWorkspaceId: 'ws-1', title: 'verify #3', status: 'review_requested',
      rev: 2, updatedAt: 1, updatedBy: { kind: 'worker', workspaceId: 'ws-v' },
      dispatch: { origin: { kind: 'bot', botId: verifierId }, preset: 'verify', checkout: { sha: HEAD, detached: true } },
      gate: { exitCode: 0, tail: 'ok', at: 1, command: 'npm test', recordedBy: 'system', headSha: HEAD },
    },
  ];
}

/** The stub engine: each turn records the verifier's PASS at the head. */
class VerifierAdapter implements BrainAdapter {
  sessionId: string | null = null;
  prompts: string[] = [];
  constructor(private readonly onTurn: () => Promise<void>) {}
  start(_opts: BrainStartOptions): void { /* no process */ }
  async *send(text: string): AsyncIterable<BrainEvent> {
    this.prompts.push(text);
    await this.onTurn();
    this.sessionId = 'sess-v';
    yield { type: 'turn-end', sessionId: 'sess-v' };
  }
  interrupt(): void { /* nothing running */ }
  dispose(): void { /* nothing to free */ }
}

let dir = '';
let clock = Date.now();
const offs: Array<() => void> = [];
const flushers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-int-'));
  clock = Date.now();
  __resetBotHooksForTesting();
  __resetBotRuntimePortsForTesting();
});
afterEach(async () => {
  for (const off of offs.splice(0)) off();
  await Promise.all(flushers.splice(0).map((f) => f().catch(() => undefined)));
  setHandoffRouter(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe('factory loop: trusted PR → verifier → verdict → CI → merge lane', () => {
  it('posts a ready card with auto-merge off, and merges exactly once with it on', async () => {
    const factoryDir = path.join(dir, 'factory');
    const settings: FactorySettings = { ...DEFAULT_FACTORY_SETTINGS, enabled: true, trustedAuthors: ['alice'] };

    // Fact log, bots, wake queue, rooms, handoffs.
    const log: FactLog = createFactLog(factoryDir, { log: () => undefined });
    log.start();
    offs.push(() => log.dispose());
    const store = new BotStore(botsFilePath(dir), { now: () => clock });
    flushers.push(() => store.flush());
    const created = store.create({ workspaceId: 'ws-1', role: 'verifier', repo: { repoKey: 'o/r', repoPath: '/repo' } });
    if (!created.ok) throw new Error(created.message);
    const verifier = created.bot;
    let runtime: BotRuntime | null = null;
    const queue = new WakeQueue(wakeQueuePath(dir), { now: () => clock, isBotEnabled: (id) => store.get(id)?.enabled === true, onChange: () => runtime?.kick() });
    flushers.push(() => queue.flush());
    const writer = new RoomWriter({ dir: path.join(factoryDir, 'rooms'), now: () => clock });
    offs.push(log.subscribe((f) => void writeFactCards(writer, f, store)));
    const router = new HandoffRouter({
      file: path.join(factoryDir, HANDOFFS_FILENAME),
      decisions: deckDecisionPort(dir),
      ports: () => ({ factLog: log, wakes: queue, bots: store }),
      rooms: () => writer,
      log: () => undefined,
    });
    await router.start();
    setHandoffRouter(router);
    offs.push(() => router.dispose());
    setBotRuntimePorts({
      resolveFacts: (ids) => resolveFactsFrom(log, ids),
      resolveHandoff: summarizeHandoff,
      readThreadTail: (ws, thread, n) => threadTail(writer, ws, thread, n),
    });

    // Triggers through the wiring's cursor view.
    const engine = new TriggerEngine({
      factLog: routedFactLog(log, { load: () => null, mark: () => undefined }),
      wakes: queue,
      bots: store,
      trust: { trustedAuthors: () => settings.trustedAuthors, ownerLogin: () => 'owner' },
    });
    engine.start();
    offs.push(() => engine.dispose());

    // The verdict store and its fact ingest.
    const verdicts = new PrVerdictStore(dir);
    const ingest = startFactIngest(log, { onVerdictRecorded: onPrVerdictRecorded });
    offs.push(() => ingest.dispose());

    // The bot runtime on the stub engine.
    const adapters: VerifierAdapter[] = [];
    runtime = new BotRuntime({
      store,
      queue,
      sessions: new BotSessionStore(botSessionsPath(dir)),
      settings: () => settings,
      engines: () => {
        const a = new VerifierAdapter(() => verdicts.record({
          version: 2, repoKey: KEY, prNumber: 3, headSha: HEAD, verdict: 'pass',
          principal: { workspaceId: 'ws-1', botId: verifier.id, agent: 'claude' },
          evidence: { taskId: VERIFY_TASK, gateHeadSha: HEAD }, summary: 'gate green at head', at: clock,
        }));
        adapters.push(a);
        return { ok: true, adapter: a };
      },
      wmuxDir: dir,
      now: () => clock,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    offs.push(() => runtime?.dispose());

    // The merge lane host and its executor over a real outbox; gh is faked.
    const effects = new MoaEffectStore(dir);
    const ledger = ledgerRows(verifier.id);
    const merge = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
    let host: MergeLaneHost | null = null;
    const executor = new MoaMergeExecutor({
      effects,
      facts: { readFresh: async () => LANE_FACTS },
      merge,
      laneContext: async () => { throw new Error('lane rows only'); },
      authorize: () => 'not-a-lane-effect',
      lane: { inputs: () => host?.inputs() ?? null, laneContext: (e, f) => (host as MergeLaneHost).effectContext(e, f) },
      identity: (e) => (host as MergeLaneHost).identity(e),
      emit: (e) => host?.onEffect(e),
    });
    host = new MergeLaneHost({
      settings: () => settings,
      bots: () => store,
      ciGreen: (repoKey, pr, sha) => log.readWhere(0, (f) => f.kind === 'ci.green' && f.repoKey === repoKey && f.ref?.pr === pr && f.ref?.headSha === sha, 1).facts.length > 0,
      verdicts: async (keys, pr) => (await Promise.all(keys.map((k) => verdicts.list(k, pr)))).flat(),
      laneFacts: async () => LANE_FACTS,
      botTasksOnBranch: async (_repo, branch) => (branch === BRANCH ? ledger.filter((r) => r.dispatch?.preset === 'default') : []),
      ledgerRow: (id) => ledger.find((r) => r.id === id) ?? null,
      authorWorkspaces: async () => ['ws-task'],
      ownerLogin: async () => 'owner',
      currentLogin: async () => 'owner',
      effects,
      run: (id) => executor.run(id),
      appendFact: (d) => log.append(d),
      rooms: () => writer,
      now: () => clock,
      log: () => undefined,
    });
    const evaluations: Array<Promise<unknown>> = [];
    offs.push(log.subscribe((f: Fact) => {
      const p = host?.onFact(f);
      if (p) evaluations.push(p);
    }));

    // 1. A trusted author opens a PR (as the repo watch writes it).
    const opened = log.append({ kind: 'pr.opened', at: clock, repoKey: KEY, ref: { pr: 3, headSha: HEAD }, actor: { kind: 'github', id: 'alice' }, payload: { author: 'alice', title: 'Fix login' } });
    expect(opened).not.toBeNull();
    const wakes = queue.list({ states: ['queued'] });
    expect(wakes).toMatchObject([{ botId: verifier.id, threadId: `pr:${KEY}#3`, reason: { kind: 'facts', factIds: [opened?.id] } }]);

    // 2. The batch window passes; the Verifier's turn records its PASS.
    clock += 21_000;
    runtime.kick();
    await vi.waitFor(() => expect(log.readWhere(0, (f) => f.kind === 'verdict.recorded', 5).facts).toHaveLength(1), { timeout: 10_000 });
    await settle();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].prompts[0]).toContain('pr.opened');
    const verdictFact = log.readWhere(0, (f) => f.kind === 'verdict.recorded', 5).facts;
    expect(verdictFact).toMatchObject([{ repoKey: KEY, ref: { pr: 3, headSha: HEAD, botId: verifier.id, taskId: VERIFY_TASK } }]);
    await Promise.all(evaluations.splice(0));
    // CI has not reported: nothing enqueued, no lane card.
    expect(effects.list()).toEqual([]);
    expect(writer.read('ws-1', { threadId: `pr:${KEY}#3` }).cards.map((c) => c.title)).toEqual([expect.stringContaining('Verdict pass for #3')]);

    // 3. CI goes green at the head: every predicate passes; auto-merge is off.
    log.append({ kind: 'ci.green', at: clock, repoKey: KEY, ref: { pr: 3, headSha: HEAD }, actor: { kind: 'github', id: 'alice' }, payload: { author: 'alice' } });
    await Promise.all(evaluations.splice(0));
    const ready = writer.read('ws-1', { threadId: `pr:${KEY}#3` }).cards.find((c) => c.kind === 'status');
    expect(ready?.title).toContain('Ready to merge #3');
    expect(effects.list()).toEqual([]);
    expect(merge).not.toHaveBeenCalled();

    // 4. The owner turns lane auto-merge on; the next fact on the head merges it, once.
    settings.laneAutoMerge = true;
    log.append({ kind: 'pr.labelled', at: clock, repoKey: KEY, ref: { pr: 3, headSha: HEAD, label: 'ship' }, actor: { kind: 'github', id: 'alice' }, payload: { author: 'alice' } });
    await Promise.all(evaluations.splice(0));
    await executor.idle();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(effects.list()).toMatchObject([{ id: `lane:${KEY}#3:${HEAD}`, approvedBy: 'lane', status: 'done' }]);
    expect(log.readWhere(0, (f) => f.kind === 'merge.done', 5).facts).toMatchObject([{ repoKey: KEY, ref: { pr: 3, headSha: HEAD } }]);
    expect(await host.evaluate(KEY, 3, HEAD)).toBe('settled');
    expect(merge).toHaveBeenCalledTimes(1);
    expect(writer.read('ws-1', { threadId: `pr:${KEY}#3` }).cards.some((c) => c.title.startsWith('Merged #3'))).toBe(true);
  });
});
