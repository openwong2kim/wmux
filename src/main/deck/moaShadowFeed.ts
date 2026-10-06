// ─── Moa shadow judge — the feed (records only, executes nothing) ───────────
//
// On every approvals change (the daemon's `approvals.changed` nudge fires on
// create, resolve, expire and supersede), main re-lists the registry and:
//   1. judges each new `awaiting_input` question from an agent pane — once per
//      record, a moment after it appears so the prompt is on the pane's screen;
//   2. closes out judged records that ended, with the owner's choice when it is
//      known (answered in wmux: `selectedChoiceKey` / the decision; answered at
//      the terminal: the label Claude reported, mapped back to its key).
//
// Skipped, never judged: brain ptys (Moa's own and every other orchestrator's),
// native-decision records (the phone chat bridge's and other agents' own
// servers — not a question typed into a pane), and anything that is not an
// `awaiting_input`. Permission prompts are out of phase 1's scope.
//
// MASTER SWITCH: Settings › Moa › "Shadow judge (records only)", default off.
// Off means no list, no packet, no model call.

import type { PolicyBook } from './deckPolicy';
import {
  SHADOW_DAILY_CAP_DEFAULT,
  buildDecisionPacket,
  buildJudgePrompt,
  extractPrNumbers,
  precheckAlwaysEscalate,
  shadowPacketHash,
  validateJudgeReply,
  type JudgeDecision,
  type JudgeRunResult,
  type ShadowAsker,
  type ShadowPrFacts,
} from './moaShadowJudge';
import { calledModel, shadowKey, type MoaShadowLedger, type ShadowDecisionRow } from './moaShadowLedger';

/** How long a new record sits before it is judged: the hook that creates it
 *  fires before the prompt is drawn (approvalStore.ts). */
export const SHADOW_SETTLE_MS = 1_000;

/** The fields of a daemon approval record (daemon.approvals.list) read here. */
export interface ShadowApprovalRecord {
  id?: unknown;
  sessionId?: unknown;
  workspaceId?: unknown;
  agent?: unknown;
  kind?: unknown;
  state?: unknown;
  question?: unknown;
  options?: unknown;
  choices?: unknown;
  questionShape?: unknown;
  channel?: unknown;
  attribution?: unknown;
  createdAt?: unknown;
  resolvedAt?: unknown;
  resolvedBy?: unknown;
  decision?: unknown;
  selectedChoiceKey?: unknown;
  localAnswer?: unknown;
}

export interface MoaShadowFeedPorts {
  isEnabled: () => boolean;
  ledger: MoaShadowLedger;
  /** The registry's lists, or null when the daemon is away. */
  listApprovals: () => Promise<{ pending?: ShadowApprovalRecord[]; recentlyResolved?: ShadowApprovalRecord[] } | null>;
  loadBook: () => (PolicyBook & { text: string }) | null;
  isBrainPty: (ptyId: string) => boolean;
  /** What main knows about a pane: its workspace's name and its cwd. */
  describePane: (ptyId: string, workspaceId: string | undefined) => { workspaceName?: string; cwd?: string };
  /** The pane's last screen lines, oldest first ([] when unreadable). */
  readScreen: (ptyId: string) => Promise<string[]>;
  /** PR facts for numbers named in the question or screen, in the pane's repo. */
  readPrs: (cwd: string | undefined, numbers: number[]) => Promise<ShadowPrFacts[]>;
  /** One model call. */
  judge: (prompt: string) => Promise<JudgeRunResult>;
  dailyCap?: number;
  settleMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  log?: (line: string) => void;
}

export interface MoaShadowFeed {
  /** The registry changed (or the switch turned on): re-list and act. */
  onApprovalsChanged: () => Promise<void>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function choicesOf(r: ShadowApprovalRecord): Array<{ key: string; label: string }> {
  if (!Array.isArray(r.choices)) return [];
  const out: Array<{ key: string; label: string }> = [];
  for (const c of r.choices as Array<{ key?: unknown; label?: unknown }>) {
    if (c && typeof c.key === 'string' && typeof c.label === 'string') out.push({ key: c.key, label: c.label });
  }
  return out;
}

/**
 * The owner's choice key for an ended record, and the outcome name. A choice
 * the judge could not have named (a deny, a typed "Other") is `deny` / null.
 */
export function ownerChoiceOf(r: ShadowApprovalRecord): { outcome: string; ownerChoiceKey: string | null } {
  const choices = choicesOf(r);
  if (r.state === 'resolved') {
    if (typeof r.selectedChoiceKey === 'string') return { outcome: 'resolved', ownerChoiceKey: r.selectedChoiceKey };
    if (r.decision === 'deny') return { outcome: 'resolved', ownerChoiceKey: 'deny' };
    // An approve with no key presses the first option.
    if (r.decision === 'approve') return { outcome: 'resolved', ownerChoiceKey: choices[0]?.key ?? null };
    return { outcome: 'resolved', ownerChoiceKey: null };
  }
  if (r.state === 'expired' && typeof r.localAnswer === 'string') {
    const said = r.localAnswer.trim().toLowerCase();
    const hit = choices.find((c) => c.label.trim().toLowerCase() === said);
    return { outcome: 'answered-in-terminal', ownerChoiceKey: hit?.key ?? null };
  }
  return { outcome: typeof r.state === 'string' ? r.state : 'unknown', ownerChoiceKey: null };
}

export function createMoaShadowFeed(ports: MoaShadowFeedPorts): MoaShadowFeed {
  const now = ports.now ?? Date.now;
  const log = ports.log ?? ((l: string) => console.log(l));
  const settleMs = ports.settleMs ?? SHADOW_SETTLE_MS;
  const cap = ports.dailyCap ?? SHADOW_DAILY_CAP_DEFAULT;
  const schedule = ports.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); });
  const ledger = ports.ledger;
  let running: Promise<void> | null = null;
  let again = false;
  let timerArmed = false;

  const closeOut = async (pending: ShadowApprovalRecord[], ended: ShadowApprovalRecord[]): Promise<void> => {
    const open = ledger.openKeys();
    if (open.length === 0) return;
    const live = new Set(pending.map((r) => (typeof r.sessionId === 'string' && typeof r.id === 'string' ? shadowKey(r.sessionId, r.id) : '')));
    const byKey = new Map<string, ShadowApprovalRecord>();
    for (const r of ended) {
      if (typeof r.sessionId === 'string' && typeof r.id === 'string') byKey.set(shadowKey(r.sessionId, r.id), r);
    }
    for (const key of open) {
      if (live.has(key)) continue;
      const r = byKey.get(key);
      // Ended and already out of the registry's short history: nothing to compare.
      const { outcome, ownerChoiceKey } = r ? ownerChoiceOf(r) : { outcome: 'lost', ownerChoiceKey: null };
      const at = r && typeof r.resolvedAt === 'number' ? r.resolvedAt : now();
      const row = await ledger.noteOutcome(key, outcome, ownerChoiceKey, at);
      if (row) log(`[moa-shadow] ${key} ended ${outcome} owner=${ownerChoiceKey ?? '-'} agree=${String(row.agree)}`);
    }
  };

  const decide = async (r: ShadowApprovalRecord, asker: ShadowAsker, question: string, choices: Array<{ key: string; label: string }>): Promise<Omit<ShadowDecisionRow, 'kind' | 'mode' | 'key' | 'askedAt' | 'askerPtyId' | 'question' | 'options' | 'packetHash'>> => {
    const none = { tokens: { input: 0, output: 0 }, ms: 0 };
    const esc = (reasonCode: string, why: string, extra: Partial<typeof none> = {}) => ({
      verdict: 'escalate' as const, choiceKey: null, ruleId: null, reasonCode, why, ...none, ...extra,
    });
    if (typeof r.questionShape === 'string' || (r.questionShape && typeof r.questionShape === 'object')) {
      return esc('multi-question', 'one choice cannot answer this prompt; the model was not asked');
    }
    if (choices.length === 0) return esc('no-choices', 'the question offers no choices to name; the model was not asked');
    const book = ports.loadBook();
    if (!book || book.rules.size === 0) return esc('no-policy-book', 'the policy book has no [R-...] rules; the model was not asked');
    const category = precheckAlwaysEscalate(question, choices.map((c) => c.label), book.alwaysEscalate);
    if (category) return esc(`always-escalate-${category}`, `pre-check matched "${category}"; the model was not asked`);
    if (ledger.stats().callsToday >= cap) return esc('daily-cap', `the daily cap of ${cap} judge calls is reached; the model was not asked`);

    const pane = ports.describePane(asker.ptyId, asker.workspaceId);
    const fullAsker: ShadowAsker = { ...asker, ...pane };
    const screenLines = await ports.readScreen(asker.ptyId).catch(() => [] as string[]);
    const numbers = extractPrNumbers([question, ...choices.map((c) => c.label), ...screenLines].join('\n'));
    const prs = numbers.length > 0 ? await ports.readPrs(fullAsker.cwd, numbers).catch(() => [] as ShadowPrFacts[]) : [];
    const packet = buildDecisionPacket({ recordId: String(r.id), question, choices, asker: fullAsker, screenLines, prs });
    const result = await ports.judge(buildJudgePrompt(book.text, packet));
    if (result.reply === null) {
      return esc('judge-failed', `the judge call failed: ${result.error ?? 'unknown'}`, { tokens: result.tokens, ms: result.ms });
    }
    const verdict: JudgeDecision = validateJudgeReply(result.reply, {
      rules: book.rules,
      choiceKeys: choices.map((c) => c.key),
      alwaysEscalate: category,
    });
    return {
      verdict: verdict.verdict,
      choiceKey: verdict.choiceKey ?? null,
      ruleId: verdict.ruleId ?? null,
      reasonCode: verdict.reasonCode,
      why: verdict.why,
      tokens: result.tokens,
      ms: result.ms,
    };
  };

  const judgeNew = async (pending: ShadowApprovalRecord[]): Promise<void> => {
    let wait = Infinity;
    for (const r of pending) {
      if (!ports.isEnabled()) return;
      const id = str(r.id);
      const ptyId = str(r.sessionId);
      if (!id || !ptyId || r.state !== 'pending' || r.kind !== 'awaiting_input') continue;
      if (r.channel === 'native-rpc' || ports.isBrainPty(ptyId)) continue;
      const question = str(r.question) ?? '';
      const choices = choicesOf(r);
      const asker: ShadowAsker = {
        ptyId,
        ...(str(r.workspaceId) ? { workspaceId: r.workspaceId as string } : {}),
        agent: str(r.agent) ?? 'unknown',
        ...(str(r.attribution) ? { attribution: r.attribution as string } : {}),
      };
      const key = shadowKey(ptyId, id);
      const packetHash = shadowPacketHash({ question, choices, asker });
      const prior = ledger.get(key);
      if (prior && prior.packetHash === packetHash) continue;
      const age = now() - (typeof r.createdAt === 'number' ? r.createdAt : 0);
      if (!prior && age < settleMs) {
        wait = Math.min(wait, settleMs - age);
        continue;
      }
      const askedAt = now();
      // A reused id is recorded by the ledger without asking the model.
      const decision = prior
        ? { verdict: 'escalate' as const, choiceKey: null, ruleId: null, reasonCode: 'id-reused', why: '', tokens: { input: 0, output: 0 }, ms: 0 }
        : await decide(r, asker, question, choices);
      try {
        const { row } = await ledger.record({
          key,
          askedAt,
          askerPtyId: ptyId,
          question,
          options: choices.map((c) => c.label),
          packetHash,
          ...decision,
        });
        log(`[moa-shadow] ${key} ${row.verdict}${row.ruleId ? ` ${row.ruleId}` : ''} (${row.reasonCode})${calledModel(row) ? ` ${row.tokens.input}+${row.tokens.output} tok ${row.ms}ms` : ''}`);
      } catch (err) {
        log(`[moa-shadow] could not record ${key}: ${String(err)}`);
      }
    }
    if (wait !== Infinity && !timerArmed) {
      timerArmed = true;
      schedule(() => {
        timerArmed = false;
        void run();
      }, Math.max(50, wait));
    }
  };

  const pass = async (): Promise<void> => {
    if (!ports.isEnabled()) return;
    const listed = await ports.listApprovals().catch(() => null);
    if (!listed || !ports.isEnabled()) return;
    const pending = Array.isArray(listed.pending) ? listed.pending : [];
    const ended = Array.isArray(listed.recentlyResolved) ? listed.recentlyResolved : [];
    await judgeNew(pending);
    await closeOut(pending, ended);
  };

  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (err) {
          log(`[moa-shadow] pass failed: ${String(err)}`);
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return { onApprovalsChanged: run };
}
