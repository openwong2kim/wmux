// pr_read / issue_read / ci_read / verdict_read / pr_verdict /
// trust_metrics_read / plan_propose / bot_list / bot_park — the role tools
// (shared/botSurface.ts BOT_TOOL_RPC), registered with registerToolModule
// (src/mcp/toolModules.ts). A role sees only the ones on its surface. Every
// call carries the bot's token; main scopes it on the bot's binding (the
// repository is its workspace's, Moa may name another workspace), so no tool
// sends who the bot is or which repository to read.

import { z } from 'zod';
import { BOT_RPC } from '../shared/bot';
import { FACTORY_READ_RPC, PLAN_RPC } from '../shared/botSurface';
import { PR_VERDICT_RPC, PR_VERDICT_SUMMARY_MAX } from '../shared/prVerdict';
import { ROOM_LIMITS } from '../shared/room';
import { registerToolModule } from './toolModules';

/** pr_verdict reads the PR from its host before recording. */
const PR_VERDICT_TIMEOUT_MS = 30_000;
/** Trust metrics read the git log of the repository. */
const TRUST_TIMEOUT_MS = 30_000;

const PR_NUMBER = z.number().int().positive();
const WORKSPACE = z.string().min(1).max(80).optional().describe('HQ bot: the workspace whose repository to read (default your own).');

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

registerToolModule({
  name: 'factory-role-tools',
  tools: ['pr_read', 'issue_read', 'ci_read', 'verdict_read', 'pr_verdict', 'trust_metrics_read', 'plan_propose', 'bot_list', 'bot_park'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>, timeoutMs?: number) => ({
      ...(await deps.callRpc(method, compact(params), timeoutMs)),
    });

    host.tool(
      'pr_read',
      'Read one pull request of your workspace\'s repository, fresh from its host (on GitLab a merge request: pr_number is its iid, checks are its head pipeline\'s jobs): state, head SHA and branch, base, author, labels, changed files (first 100) and checks with which are required.',
      { pr_number: PR_NUMBER, workspace_id: WORKSPACE },
      async ({ pr_number, workspace_id }) => call(FACTORY_READ_RPC.prRead, { prNumber: pr_number, workspaceId: workspace_id }),
    );

    host.tool(
      'issue_read',
      'Read one issue of your workspace\'s repository (body and recent comments, cut to size), or without issue_number the open issues (first 30), optionally with one label.',
      {
        issue_number: PR_NUMBER.optional(),
        label: z.string().min(1).max(100).optional(),
        workspace_id: WORKSPACE,
      },
      async ({ issue_number, label, workspace_id }) => call(FACTORY_READ_RPC.issueRead, { issueNumber: issue_number, label, workspaceId: workspace_id }),
    );

    host.tool(
      'ci_read',
      'Read the checks on the head of a repository\'s default branch: the rollup state and which checks fail on main.',
      { workspace_id: WORKSPACE },
      async ({ workspace_id }) => call(FACTORY_READ_RPC.ciRead, { workspaceId: workspace_id }),
    );

    host.tool(
      'verdict_read',
      'Read the verdicts recorded on one pull request (newest 20): head SHA, pass or fail, who recorded it, its evidence task.',
      { pr_number: PR_NUMBER, workspace_id: WORKSPACE },
      async ({ pr_number, workspace_id }) => call(FACTORY_READ_RPC.verdictRead, { prNumber: pr_number, workspaceId: workspace_id }),
    );

    host.tool(
      'pr_verdict',
      'Record your verdict on one PR head. evidence.task_id is the verify task (preset "verify", detached at head_sha) whose gate wmux recorded at that SHA: '
        + 'a pass needs that gate green; a fail may rest on a red one. wmux re-reads the PR head and checks the task the way the merge lane will; '
        + 'a refusal names the reason (head-mismatch, evidence-mismatch, gate-skipped, gate-failed, ...).',
      {
        pr_number: PR_NUMBER,
        head_sha: z.string().regex(/^[0-9a-f]{40}$/).describe('The full head SHA you verified.'),
        verdict: z.enum(['pass', 'fail']),
        summary: z.string().min(1).max(PR_VERDICT_SUMMARY_MAX).describe('What the gate and the reading showed.'),
        evidence: z.object({ task_id: z.string().min(1).max(200) }).strict(),
      },
      async ({ pr_number, head_sha, verdict, summary, evidence }) =>
        call(PR_VERDICT_RPC, { prNumber: pr_number, headSha: head_sha, verdict, summary, evidence: { taskId: evidence.task_id } }, PR_VERDICT_TIMEOUT_MS),
    );

    host.tool(
      'trust_metrics_read',
      'Read the trust metrics of a repository\'s main line over the last since_days (default 30): merged PRs, revert rate, 7-day survival, median time to revert, and the reverted PRs. Only git revert is seen.',
      {
        since_days: z.number().int().min(1).max(90).optional(),
        workspace_id: WORKSPACE,
      },
      async ({ since_days, workspace_id }) => call(FACTORY_READ_RPC.trustMetricsRead, { sinceDays: since_days, workspaceId: workspace_id }, TRUST_TIMEOUT_MS),
    );

    host.tool(
      'plan_propose',
      'Post the day\'s plan as one plan card in your room, for the owner to approve once. Items run in order; each names the workspace whose lead takes it (it needs an enabled lead), a title, a size and why. '
        + 'An approval or an edit wakes you in the plan\'s thread with the owner\'s answer. A decline wakes no one: the plan card closes with the owner\'s answer in its thread (room_read) and is recorded as a plan-declined correction, which the next morning report counts among the correction patterns.',
      {
        title: z.string().min(1).max(ROOM_LIMITS.TITLE_MAX),
        items: z.array(z.object({
          workspace_id: z.string().min(1).max(80),
          title: z.string().min(1).max(ROOM_LIMITS.TITLE_MAX),
          size: z.enum(['S', 'M', 'L']),
          why: z.string().min(1).max(300),
        }).strict()).min(1).max(10),
        body: z.string().max(4000).optional().describe('Notes under the items.'),
      },
      async ({ title, items, body }) =>
        call(PLAN_RPC.propose, { title, body, items: items.map((i) => ({ workspaceId: i.workspace_id, title: i.title, size: i.size, why: i.why })) }),
    );

    host.tool(
      'bot_list',
      'List the factory\'s bots (optionally of one workspace): role, workspace, whether enabled or parked, presence, queue depth and budget left.',
      { workspace_id: z.string().min(1).max(80).optional() },
      async ({ workspace_id }) => call(BOT_RPC.list, { workspaceId: workspace_id }),
    );

    host.tool(
      'bot_park',
      'Park one bot: its queued wakes wait until the owner resumes it. Post a status card saying why.',
      { bot_id: z.string().regex(/^bot-[0-9a-f]{8}$/) },
      async ({ bot_id }) => call(BOT_RPC.park, { botId: bot_id }),
    );
  },
});
