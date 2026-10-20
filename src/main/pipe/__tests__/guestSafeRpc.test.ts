// Every bot tool is classified for a wake not known clean of a guest's words:
// guest-safe (RpcRouter lets it through, shared/botSurface.ts GUEST_SAFE_RPC)
// or clean-only (refused there). A tool added to BOT_TOOL_RPC without a place
// in one of the two lists fails here. Each guest-safe read names how it keeps
// guest-sourced text from a reader that should not see it, or why it returns
// nothing a guest-sourced wake can have written.

import { describe, expect, it } from 'vitest';
import { BOT_BASE_RPC, BOT_TOOL_RPC, GUEST_SAFE_RPC, SHARED_SURFACE, type BotToolName } from '../../../shared/botSurface';
import { factVisibleToBot } from '../../factory/wakeTaint';
import { botApprovalView } from '../../factory/approvals';
import { RoomWriter } from '../../factory/roomWriter';

type GuestSafe =
  /** A write whose record carries the wake's provenance (origin guest,
   *  Handoff.guestSourced). */
  | { kind: 'stamped-write' }
  /** A read filtered by provenance: the predicate it goes through. */
  | { kind: 'filtered-read'; by: unknown }
  /** A read scoped in a wake not known clean to what the guest conversation
   *  holds, of what only a clean wake or the owner writes. */
  | { kind: 'scoped-read'; why: string };

const GUEST_SAFE_TOOLS: Partial<Record<BotToolName, GuestSafe>> = {
  room_post: { kind: 'stamped-write' },
  handoff_send: { kind: 'stamped-write' },
  ask_person: { kind: 'stamped-write' },
  question_close: { kind: 'stamped-write' },
  room_read: { kind: 'filtered-read', by: RoomWriter.prototype.read },
  fact_poll: { kind: 'filtered-read', by: factVisibleToBot },
  approval_list: { kind: 'filtered-read', by: botApprovalView },
  bot_list: { kind: 'scoped-read', why: 'the bots of the wake\'s own conversation only (bot.rpc listScope); profiles are the owner\'s, jobs set only in a clean wake' },
};

const CLEAN_ONLY_TOOLS: readonly BotToolName[] = [
  // Repository, CI, verdict, trust, terminal and pane reads.
  'pr_read', 'issue_read', 'ci_read', 'verdict_read', 'trust_metrics_read', 'terminal_read', 'workspace_list', 'pane_list',
  'fleet_triage', 'wmux_events_poll', 'a2a_task_query',
  // Work, and anything saved for later.
  'fanout_start', 'ledger_update', 'worker_resume', 'worker_message', 'stop_my_work', 'bot_park',
  'pr_verdict', 'plan_propose', 'job_set', 'routine_set', 'routine_pause',
  'workflow_create', 'workflow_advance', 'approval_request', 'skill_propose',
  // The bot's own saved work and skills: a guest's reply does not need them.
  'routine_list', 'workflow_read', 'skill_read',
  // Searching the room's history: a guest's reply does not need it.
  'room_search',
  'secret_request', 'secret_list', 'login_request',
];

describe('GUEST_SAFE_RPC', () => {
  it('every bot tool is either guest-safe or clean-only, never both', () => {
    for (const tool of Object.keys(BOT_TOOL_RPC) as BotToolName[]) {
      const safe = tool in GUEST_SAFE_TOOLS;
      const clean = CLEAN_ONLY_TOOLS.includes(tool);
      expect(safe !== clean, `${tool}: guest-safe ${safe}, clean-only ${clean}`).toBe(true);
    }
    for (const tool of [...Object.keys(GUEST_SAFE_TOOLS), ...CLEAN_ONLY_TOOLS]) expect(tool in BOT_TOOL_RPC, tool).toBe(true);
  });

  it('holds exactly the base calls and the methods of the guest-safe tools', () => {
    const expected = new Set<string>([...BOT_BASE_RPC]);
    for (const tool of Object.keys(GUEST_SAFE_TOOLS) as BotToolName[]) for (const m of BOT_TOOL_RPC[tool]) expected.add(m);
    expect([...GUEST_SAFE_RPC].sort()).toEqual([...expected].sort());
    for (const tool of CLEAN_ONLY_TOOLS) for (const m of BOT_TOOL_RPC[tool]) expect(GUEST_SAFE_RPC.has(m), `${tool} → ${m}`).toBe(false);
    // Nothing off the bot surface is listed.
    for (const m of GUEST_SAFE_RPC) expect(SHARED_SURFACE.rpc.has(m), m).toBe(true);
  });

  it('each guest-safe read says how it keeps guest-sourced text in its place', () => {
    for (const [tool, c] of Object.entries(GUEST_SAFE_TOOLS)) {
      if (c.kind === 'filtered-read') expect(typeof c.by, tool).toBe('function');
      if (c.kind === 'scoped-read') expect(c.why.length, tool).toBeGreaterThan(0);
    }
  });
});
