// ─── Roles module — bot prompts and the factory's main-side halves ────────
//
// Registered as the `roles` factory module (../factoryHost.ts). It owns:
//   - each bot's system prompt: its job (the owner's words, else its
//     template's default job) and the shared powers, from the template
//     definitions (./coordinator.ts … ./custom.ts, rendered by ./common.ts),
//     given to the bot runtime as its `systemPrompt` port;
//   - the bot reads and the plan card (pipe/handlers/factoryRead.rpc.ts);
//   - the verify preset's gate (../verifyPreset.ts): a bot verify task that
//     reports is gated by main at its head, with the base branch's gate;
//   - the owner's answers to plan and proposal cards: a plan answer wakes the
//     bot that proposed it (../morningReport.ts routePlanAnswer), a gardener
//     proposal approval goes to a maintainer or the Coordinator (../gardener.ts);
//   - the gardener, which turns repeated corrections into a Coordinator wake.
// The morning report itself is `fireMorningReport` (../morningReport.ts),
// called by the morning schedule's wiring; `morningReportPorts()` gives it
// the live ports.

import path from 'node:path';
import type { BotProfile } from '../../../shared/bot';
import type { CardNotice, ThreadId } from '../../../shared/room';
import { registerFactoryRpcModule, type FactoryHostDeps } from '../factoryHost';
import { setBotRuntimePorts } from '../BotRuntime';
import { getBotDirectory } from '../botStore';
import { getWakeQueue } from '../wakeQueue';
import { getFactLog } from '../factLog';
import { getRoomWriter, resolveRoomPorts, runningWake, wakeOrdinals } from '../roomWriter';
import { readTrustMetrics } from '../trustMetrics';
import { installVerifyGate, originDefaultRef, worktreeFromMissions } from '../verifyPreset';
import { Gardener, getGardener, setGardener } from '../gardener';
import { routePlanAnswer, type MorningPorts } from '../morningReport';
import { onRoomCardResolved } from '../../pipe/handlers/room.rpc';
import { CI_ROLLUP_QUERY, mapCiRollup, registerFactoryReadHandlers, type FactoryReadDeps } from '../../pipe/handlers/factoryRead.rpc';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { getSharedTaskGateRunner } from '../../worktask/TaskGateRunner';
import { ghPrReviewService } from '../../github/GhPrReviewService';
import { ghIssueService } from '../../github/GhIssueService';
import { getPrVerdictStore } from '../../github/prVerdictStore';
import { detectRemote } from '../../github/PrProvider';
import { git } from '../../git/git';
import { renderBotPrompt } from './common';
import { templateDefinitionOf } from './templates';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';

export { TEMPLATE_DEFINITIONS, templateDefinitionOf } from './templates';

/** A bot's system prompt: its job and its powers and outputs, naming its
 *  workspace by the owner's name for it. */
export function rolePrompt(profile: BotProfile): string {
  const workspaceName = getWorkspaceMirror().getEntries()?.find((e) => e.id === profile.workspaceId)?.name ?? null;
  return renderBotPrompt(templateDefinitionOf(profile), profile, workspaceName);
}

// ── Default ports ──────────────────────────────────────────────────────────

const gitRun = async (args: string[], cwd: string): Promise<string> => {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
};

const repoKeyOf = async (repoPath: string): Promise<string | null> => (await detectRemote(repoPath))?.key ?? null;

async function trustOf(repoPath: string, since: number, now: number) {
  const ref = (await originDefaultRef(git, repoPath)) ?? 'origin/main';
  return readTrustMetrics(repoPath, { since, now, ref, git: gitRun });
}

/** A system card in a room thread (best effort), with its stable code
 *  when it has one (RoomCard.notice). */
function systemNote(workspaceId: string, threadId: ThreadId, title: string, body: string, notice?: CardNotice): void {
  getRoomWriter()?.append({ workspaceId, threadId, kind: 'fact', actor: { kind: 'system' }, title, body, ...(notice ? { notice } : {}) });
}

export function factoryReadDeps(): FactoryReadDeps {
  return {
    bots: getBotDirectory,
    repoKeyOf,
    readPr: (repoPath, key, n) => ghPrReviewService.laneFacts(repoPath, key, n),
    listIssues: async (repoPath, filter, key) => {
      const r = await ghIssueService.listIssues(repoPath, filter, key);
      return r.ok ? { ok: true, issues: r.issues } : { ok: false, message: r.message };
    },
    issueDetail: (repoPath, n, key) => ghIssueService.issueDetail(repoPath, n, '', key),
    ciRollup: async (repoPath, key) => {
      const [owner, repo] = key.split('/').slice(-2);
      const r = await ghPrReviewService.watchGraphql(repoPath, key, CI_ROLLUP_QUERY, { owner, repo });
      if (!r.ok) return { error: r.message };
      return mapCiRollup(r.value) ?? { error: 'the default branch could not be read' };
    },
    verdicts: (key, n) => getPrVerdictStore().list(key, n),
    trust: trustOf,
    rooms: getRoomWriter,
    postKey: (botId) => wakeOrdinals.next(runningWake(resolveRoomPorts(), botId), 'post'),
  };
}

/** The live ports of the morning report (for the morning schedule's wiring). */
export function morningReportPorts(wmuxDir: string): MorningPorts {
  return {
    factLog: getFactLog,
    bots: getBotDirectory,
    rooms: getRoomWriter,
    trust: trustOf,
    repoKeyOf,
    corrections: () => getGardener()?.groups() ?? [],
    factoryDir: path.join(wmuxDir, 'factory'),
  };
}

function enqueue(input: Parameters<NonNullable<ReturnType<typeof getWakeQueue>>['enqueue']>[0]): unknown {
  const q = getWakeQueue();
  if (!q) {
    console.info(`[factory] roles: wake queue not running; ${input.botId} was not woken`);
    return null;
  }
  return q.enqueue(input);
}

// ── Module ─────────────────────────────────────────────────────────────────

export function createRolesModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getDaemonClient'>) {
  const offs: Array<() => void> = [];
  return {
    start(): void {
      setBotRuntimePorts({ systemPrompt: rolePrompt });
      const ledger = getTaskLedger();
      offs.push(installVerifyGate({
        onTransition: (fn) => ledger.onTransition(fn),
        ledgerRow: (id) => ledger.get(id),
        openRows: () => ledger.list({ openOnly: true }),
        bot: (id) => getBotDirectory()?.get(id) ?? null,
        worktreeOf: (entry) => {
          const client = deps.getDaemonClient();
          return worktreeFromMissions(client ? (m, p) => client.rpc(m, p as Record<string, unknown> | undefined) : null, entry);
        },
        baseRef: (repoPath) => originDefaultRef(git, repoPath),
        runGate: async (input) => {
          const runner = getSharedTaskGateRunner();
          if (!runner) return { ok: false, status: 'refused', taskId: input.taskId, error: 'the task gate runner is not up yet' };
          return runner.run(input);
        },
        wake: enqueue,
        note: systemNote,
      }));
      const gardener = new Gardener({
        factLog: getFactLog,
        bots: getBotDirectory,
        wake: enqueue,
        note: systemNote,
        reopen: (workspaceId, cardId) => {
          getRoomWriter()?.setState(workspaceId, cardId, 'open');
        },
        factoryDir: path.join(deps.wmuxDir(), 'factory'),
      });
      setGardener(gardener);
      gardener.start();
      offs.push(() => {
        gardener.dispose();
        setGardener(null);
      });
      offs.push(onRoomCardResolved((ev) => {
        if (ev.card.kind === 'plan') routePlanAnswer(ev, { bots: getBotDirectory, wake: enqueue });
        else if (ev.card.kind === 'proposal') gardener.onCardResolved(ev);
      }));
    },
    dispose(): void {
      for (const off of offs.splice(0).reverse()) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
    },
  };
}

registerFactoryRpcModule('roles', (router, deps) => {
  registerFactoryReadHandlers(router, factoryReadDeps());
  return createRolesModule(deps);
});
