// ─── Moa shadow judge — the app's wiring (main/index.ts, deck.handler.ts) ───
//
// Real ports for moaShadowFeed: the daemon's approval list and pane text, the
// workspace mirror, the GitHub PR reader, and the owner's claude binary run
// with the brain's env scrub in a dedicated cwd under the wmux data dir.

import { getWmuxDir } from '../../daemon/config';
import { isBrainPtyId } from '../../shared/constants';
import type { DaemonClient } from '../DaemonClient';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { detectRemote } from '../github/PrProvider';
import { ghPrReviewService } from '../github/GhPrReviewService';
import { resolveClaudeExecutable } from './ClaudeSdkAdapter';
import { scrubBrainSpawnEnv } from './ClaudePtyBrainAdapter';
import { loadPolicyBook } from './deckPolicy';
import { getMoaConfig } from './deckHqStore';
import { SHADOW_SCREEN_LINES, prepareJudgeDir, runJudge, type JudgeRunResult, type ShadowPrFacts } from './moaShadowJudge';
import { MoaShadowLedger, calledModel, type ShadowStats } from './moaShadowLedger';
import type { MoaJudgeResult } from '../../shared/moaDecision';
import { createMoaShadowFeed, type MoaShadowFeed } from './moaShadowFeed';

/** A GitHub read that has not answered by then is left out of the packet. */
const PR_READ_DEADLINE_MS = 5_000;
const SCREEN_READ_TIMEOUT_MS = 3_000;

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** Rows from `daemon.readSessionText`, wrapped rows joined, ending at the cursor. */
export function screenLinesFromRows(rows: Array<{ text?: unknown; wrapped?: unknown }>, rowsBelowCursor = 0): string[] {
  const upToCursor = rowsBelowCursor > 0 ? rows.slice(0, Math.max(0, rows.length - rowsBelowCursor)) : rows;
  const lines: string[] = [];
  for (const row of upToCursor) {
    const text = typeof row.text === 'string' ? row.text.replace(/\s+$/, '') : '';
    if (row.wrapped === true && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-SHADOW_SCREEN_LINES);
}

/** The cwd wmux knows for a pane (the fleet mirror, else its workspace's). */
export function paneCwdOf(ptyId: string, workspaceId: string | undefined): string | undefined {
  const mirror = getWorkspaceMirror();
  const entry = workspaceId ? mirror.getEntries()?.find((e) => e.id === workspaceId) : undefined;
  const pane = workspaceId ? mirror.getFleetSnapshot(workspaceId)?.panes.find((p) => p.ptyId === ptyId) : undefined;
  return pane?.cwd ?? entry?.metadata?.cwd ?? undefined;
}

/** The pane's OWN cwd, with no workspace fallback ('' when wmux knows none):
 *  moa_ask resolves a merge's repo from it, so it must be the asker's. */
export function paneOwnCwdOf(ptyId: string, workspaceId: string): string {
  return getWorkspaceMirror().getFleetSnapshot(workspaceId)?.panes.find((p) => p.ptyId === ptyId)?.cwd ?? '';
}

/** A pane's last screen lines through the daemon ([] when unreadable). */
export async function readPaneScreen(getDaemonClient: () => DaemonClient | null, ptyId: string): Promise<string[]> {
  const dc = getDaemonClient();
  if (!dc?.isConnected) return [];
  const res = (await dc.rpc('daemon.readSessionText', { id: ptyId, scrollback: 0 }, { timeoutMs: SCREEN_READ_TIMEOUT_MS })) as {
    mode?: string;
    rows?: Array<{ text?: unknown; wrapped?: unknown }>;
    rowsBelowCursor?: number;
  };
  return res?.mode === 'rows' && Array.isArray(res.rows) ? screenLinesFromRows(res.rows, res.rowsBelowCursor ?? 0) : [];
}

/** One judge call: the owner's claude, the brain's env scrub, a fresh empty
 *  dir per call (shared by the shadow feed and moa_ask). */
export async function runMoaJudge(prompt: string): Promise<JudgeRunResult> {
  const executable = resolveClaudeExecutable();
  // A JS entrypoint needs a node to run it; the judge does not guess one.
  if (!executable || executable.endsWith('.js')) {
    return { reply: null, error: 'no claude executable', refused: true, tokens: { input: 0, output: 0 }, ms: 0 };
  }
  // A fresh empty dir per call, never under the wmux data dir.
  const prepared = prepareJudgeDir();
  if ('error' in prepared) {
    return { reply: null, error: `unsafe judge dir: ${prepared.error}`, refused: true, tokens: { input: 0, output: 0 }, ms: 0 };
  }
  try {
    return await runJudge(prompt, { executable, cwd: prepared.dir, env: scrubBrainSpawnEnv(process.env) });
  } finally {
    prepared.cleanup();
  }
}

/**
 * What the shadow judge recorded for a question with this packet hash, while
 * its record is still open (moaQuestionHash equals shadowPacketHash), so
 * moa_ask does not judge the same question twice. Null when the shadow judge
 * is off: its ledger is not even opened then.
 */
export function findShadowJudgment(packetHash: string): MoaJudgeResult | null {
  if (!isShadowJudgeEnabled()) return null;
  const l = getLedger();
  for (const key of l.openKeys()) {
    const row = l.get(key);
    if (!row || row.packetHash !== packetHash || !calledModel(row)) continue;
    return {
      verdict: row.verdict,
      ...(row.choiceKey ? { choiceKey: row.choiceKey } : {}),
      ...(row.ruleId ? { ruleId: row.ruleId } : {}),
      reasonCode: row.reasonCode,
      why: row.why,
      // Already paid for by the shadow judge: not a call of moa_ask's.
      tokens: { input: 0, output: 0 },
      ms: 0,
    };
  }
  return null;
}

let ledger: MoaShadowLedger | null = null;
let feed: MoaShadowFeed | null = null;

export function isShadowJudgeEnabled(): boolean {
  const config = getMoaConfig();
  return config.enabled && config.shadowJudge === true;
}

function getLedger(): MoaShadowLedger {
  if (!ledger) ledger = new MoaShadowLedger(getWmuxDir());
  return ledger;
}

/** Build the app's feed. Call once; later calls return the same feed. */
export function startMoaShadow(getDaemonClient: () => DaemonClient | null): MoaShadowFeed {
  if (feed) return feed;
  feed = createMoaShadowFeed({
    isEnabled: isShadowJudgeEnabled,
    ledger: getLedger(),
    listApprovals: async () => {
      const dc = getDaemonClient();
      if (!dc?.isConnected) return null;
      return (await dc.rpc('daemon.approvals.list', {})) as Awaited<ReturnType<Parameters<typeof createMoaShadowFeed>[0]['listApprovals']>>;
    },
    loadBook: () => loadPolicyBook(),
    isBrainPty: isBrainPtyId,
    describePane: (ptyId, workspaceId) => {
      const entry = workspaceId ? getWorkspaceMirror().getEntries()?.find((e) => e.id === workspaceId) : undefined;
      const cwd = paneCwdOf(ptyId, workspaceId);
      return {
        ...(entry?.name ? { workspaceName: entry.name } : {}),
        ...(cwd ? { cwd } : {}),
      };
    },
    readScreen: (ptyId) => readPaneScreen(getDaemonClient, ptyId),
    readPrs: async (cwd, numbers) => {
      if (!cwd) return [];
      const remote = await withDeadline(detectRemote(cwd), PR_READ_DEADLINE_MS, null);
      if (!remote?.key) return [];
      const key = remote.key;
      const reads = numbers.map(async (n): Promise<ShadowPrFacts | null> => {
        const r = await withDeadline(ghPrReviewService.checks(cwd, key, n), PR_READ_DEADLINE_MS, null);
        if (!r || !r.ok) return null;
        const { head, checks } = r.value;
        return {
          number: head.number,
          state: head.state,
          isDraft: head.isDraft,
          headSha: head.headRefOid,
          mergeStateStatus: head.mergeStateStatus,
          labels: head.labels ?? [],
          checks: checks.map((c) => ({ name: c.name, bucket: c.bucket })),
        };
      });
      return (await Promise.all(reads)).filter((p): p is ShadowPrFacts => p !== null);
    },
    judge: runMoaJudge,
  });
  return feed;
}

/** Re-list now (the switch turned on). No-op before main wires the feed. */
export function runMoaShadow(): void {
  void feed?.onApprovalsChanged();
}

/** The Settings readout. */
export function getMoaShadowStats(): ShadowStats {
  return getLedger().stats();
}
