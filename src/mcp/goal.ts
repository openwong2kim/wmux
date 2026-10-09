// moa_propose_goal / moa_goal — COMMANDER-ONLY (registered through the
// commander-only lane in src/mcp/index.ts, never in full/core).
//
// Moa, the HQ brain, proposes a goal contract the operator approves ONCE with
// a card (shared/moaGoal.ts holds the contract, src/main/deck/moaGoalContract.ts
// the store). The tools forward the commander token and the fields, and pass
// the result through untouched: main decides everything else.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RpcMethod } from '../shared/rpc';

type ToolResult = { content: { type: 'text'; text: string }[] };

export interface MoaGoalToolDeps {
  callRpc: (method: RpcMethod, params: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
  /** WMUX_COMMANDER_TOKEN; undefined outside a brain, and the RPC fails closed. */
  getCommanderToken: () => string | undefined;
}

export const MOA_PROPOSE_GOAL_SHAPE = {
  goal: z.string().describe('The goal in one or two plain sentences (≤400 characters), as the operator asked for it.'),
  repo: z.string().optional().describe('Absolute path inside the git repository the work happens in. Fan-out runs there.'),
  workspace_ids: z.array(z.string()).max(4).optional().describe('Existing workspaces (ids from workspace_list) whose agents may receive hand-offs without a card.'),
  level: z.union([z.literal(2), z.literal(3)]).optional().describe('2 (default): delegate inside the goal. 3 is reserved for merging and acts like 2 for now.'),
  max_tasks: z.number().int().optional().describe('Fan-out tasks the goal may create in total (1-16, default 4).'),
  max_hours: z.number().int().optional().describe('Hours until the goal expires (1-24, default 4).'),
  max_turns: z.number().int().optional().describe('Your automatic turns while it is active (1-200, default 40).'),
  human_only: z.array(z.string()).max(8).optional().describe('Extra decisions the operator keeps (short phrases). Push/PR/merge, releases, secrets, deletes and approvals are always theirs.'),
};

const PROPOSE_DESCRIPTION =
  'HQ (Moa) only. Propose a GOAL CONTRACT for a piece of work the operator asked for: the goal, its repository and/or workspaces, a budget, and decisions the operator keeps. '
  + 'Main shows the operator ONE card; nothing changes until they click Approve. Once approved (and Moa is at level 2+ in Settings), inside the goal you may fan out in its repository, answer and instruct the tasks it creates, and hand work to its workspaces without a card. '
  + 'Push, PRs, merges, releases, secrets, deletes and approvals always stay the operator\'s. After proposing, END YOUR TURN; you are woken with the answer. '
  + 'Errors: level_too_low (ask the operator to raise the level, or work as before), goal_open (one goal at a time), busy (a card is already waiting), repo_not_git, card_too_long.';

const GOAL_DESCRIPTION =
  'HQ (Moa) only. Your goal contract: action "status" (default) shows it — what it grants right now, the budget used, the task workspaces it owns. '
  + 'action "complete" with a summary of what was done and how you verified it ends it; "cancel" ends it early. Ending only takes powers away.';

export function registerMoaGoalTools(register: McpServer['tool'], deps: MoaGoalToolDeps): void {
  register(
    'moa_propose_goal',
    PROPOSE_DESCRIPTION,
    MOA_PROPOSE_GOAL_SHAPE,
    async ({ goal, repo, workspace_ids, level, max_tasks, max_hours, max_turns, human_only }) => {
      const params: Record<string, unknown> = { token: deps.getCommanderToken(), goal };
      if (repo) params.repo = repo;
      if (workspace_ids) params.workspaceIds = workspace_ids;
      if (level !== undefined) params.level = level;
      const budget: Record<string, unknown> = {};
      if (max_tasks !== undefined) budget.maxTasks = max_tasks;
      if (max_hours !== undefined) budget.maxHours = max_hours;
      if (max_turns !== undefined) budget.maxTurns = max_turns;
      if (Object.keys(budget).length > 0) params.budget = budget;
      if (human_only) params.humanOnly = human_only;
      return deps.callRpc('deck.proposeGoal', params);
    },
  );
  register(
    'moa_goal',
    GOAL_DESCRIPTION,
    {
      action: z.enum(['status', 'complete', 'cancel']).optional().describe('status (default), complete or cancel.'),
      summary: z.string().optional().describe('For complete: what was done and how you verified it. For cancel: why.'),
    },
    async ({ action, summary }) => {
      const params: Record<string, unknown> = { token: deps.getCommanderToken(), action: action ?? 'status' };
      if (summary) params.summary = summary;
      return deps.callRpc('deck.goal', params);
    },
  );
}
