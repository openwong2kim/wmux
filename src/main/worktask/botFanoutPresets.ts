// ─── Bot fan-out presets — what a factory bot's worker is and produces ─────
//
// A factory bot starts workers only through the bot presets
// (shared/botSurface.ts SHARED_SURFACE.fanoutPresets). These are the
// built-in presets those names resolve to, for bot callers only: operator
// presets (Settings) never apply to a bot, and a bot's call never names an
// agent, a model, a permission mode or a checkout shape the preset does not
// allow. Each preset fixes:
//   - the worker prompt: who the worker is, what it can do in its worktree,
//     what it hands back (main puts it ahead of the bot's own prompt, so the
//     bot cannot leave it out);
//   - the worker permission mode: unattended (a bot's worker has nobody at
//     its pane to answer a prompt);
//   - the engine: the agent CLI each task runs on;
//   - the checkout: `verify` runs only on a detached checkout of one commit
//     (the PR head), every other preset branches a fresh wtask/ branch from
//     origin's default branch.
//
//   verify    the PR head, detached. The worker reads the change against its
//             base and reports findings in its ledger summary; it installs
//             dependencies and runs checks only when the base declares a gate
//             (main says which command, TaskGateRunner.baseGate) and the
//             change is not docs-only. Main then runs the repository gate on that exact
//             commit, with the gate chosen from the base branch, and records
//             it (main/factory/verifyGate.ts) — that record, not the worker's
//             word, is what a verdict rests on.
//   repro     reproduce an issue, write the failing test, attempt a minimal
//             fix, open a DRAFT pull request while working and mark it
//             ready (`gh pr ready`) once the test is pushed, so CI runs.
//   maintain  bring the verify-wmux feature map up to date with merged PRs,
//             run the affected recipes once, open a pull request.
//   default   a bot's plain task: implement, gate, open a pull request — or,
//             for a task that asks a question (research), report the
//             findings with their sources and open no pull request.
//   research  a question that needs no code: the worker runs in a scratch
//             folder under the bot's own data folder (no repository, no
//             worktree, no git, no push), searches and reads, and reports
//             its findings with their sources. The only preset a bot without
//             a repository can start; its report completes the task without
//             a gate (shared/ledger.ts isResearchDispatch).
//
// The review request each preset opens follows the bot repository's host the
// way the Git page picks its CLI (github/PrProvider.ts): a GitHub host gets
// `gh pr create`, every other host is GitLab and gets `glab mr create`, and a
// bot with no recorded repository host keeps the GitHub lines. A GitLab repro
// worker leaves its draft for the owner to mark ready (`glab mr update` is the
// owner's, shared/botWorkerGuard.ts).

import type { FanoutAgentChoice, FanoutPreset } from '../../shared/fanoutPreset';
import { fanoutPresetKey } from '../../shared/fanoutPreset';
import type { FanoutWorkerPermissionMode } from '../../shared/workerLaunch';
import { FANOUT_MAX_TASKS } from '../../shared/workTask';
import { normalizeRepoKey } from '../../shared/repoKey';
import { isGithubForgeHost } from '../github/PrProvider';
import { DOCS_ONLY_RULE } from '../../shared/docsChange';
import type { BaseGate } from './TaskGateRunner';

export type BotFanoutPresetName = 'verify' | 'repro' | 'maintain' | 'default' | 'research';

export const BOT_FANOUT_PRESET_NAMES: readonly BotFanoutPresetName[] = ['verify', 'repro', 'maintain', 'default', 'research'];

export interface BotPresetCheckout {
  sha: string;
  detached: boolean;
  fetchRef?: string;
}

/** Which CLI opens the worker's review request: gh for a pull request,
 *  glab for a GitLab merge request. */
export type BotReviewHost = 'github' | 'gitlab';

export interface BotPresetPromptContext {
  checkout?: BotPresetCheckout;
  /** Unset: github (a bot with no recorded repository host). */
  reviewHost?: BotReviewHost;
  /** The gate the repository declares on its base (verify). Unset: unknown. */
  gate?: BaseGate;
}

export interface BotFanoutPreset {
  name: BotFanoutPresetName;
  description: string;
  /** The worker's prompt, ahead of the bot's own. */
  workerPrompt: (ctx: BotPresetPromptContext) => string;
  /** Unattended: the worker's pane has nobody to answer a permission prompt. */
  permissionMode: FanoutWorkerPermissionMode;
  /** The agent CLI every task of this preset runs on. */
  agent: FanoutAgentChoice;
  /** `required`: a detached checkout of one commit; `none`: a fresh branch. */
  checkout: 'required' | 'none';
  /** false: no repository and no worktree — a scratch folder (research). */
  worktree: boolean;
  /** Most tasks one fan-out of this preset may start. */
  maxTasks: number;
}

const UNATTENDED: FanoutWorkerPermissionMode = 'bypassPermissions';
const CLAUDE: FanoutAgentChoice = { agent: 'claude' };

const SHA_RE = /^[0-9a-f]{40}$/;

/** The review request's words and commands for one host. */
interface ReviewRequestLines {
  noun: string;
  /** How a worker reads a merged request's title and changed files. */
  read: string;
  link: string;
  create: string;
  draft: string;
  ready: string;
}

const REVIEW_REQUEST: Readonly<Record<BotReviewHost, ReviewRequestLines>> = {
  github: {
    noun: 'pull request',
    read: 'the merged pull requests the task names (`gh pr view <n> --json files,title`)',
    link: 'the PR link',
    create: '`gh pr create --head <your branch>`',
    draft: '`gh pr create --draft --head <your branch>`',
    ready: 'mark the PR ready with `gh pr ready <number>`: CI skips drafts, so this is what starts it. When the issue does not reproduce, the PR stays a draft, if you opened one.',
  },
  gitlab: {
    noun: 'merge request',
    read: 'the merged merge requests the task names (`glab mr view <n> --output json` and `glab mr diff <n>`)',
    link: 'the merge request link',
    create: '`glab mr create --source-branch <your branch> --title "<title>" --description "<what and why>" --yes`',
    draft: '`glab mr create --draft --source-branch <your branch> --title "<title>" --description "<repro steps and the test>" --yes`',
    ready: 'the merge request stays a draft for the owner to mark ready: GitLab runs its pipeline on a draft too.',
  },
};

/** The bot repository's review host, from its repo key's host the way the Git
 *  page picks gh or glab; undefined when there is no key to read. */
export function botReviewHost(repoKey: string | undefined): BotReviewHost | undefined {
  const host = normalizeRepoKey(repoKey)?.split('/')[0];
  if (!host) return undefined;
  return isGithubForgeHost(host) ? 'github' : 'gitlab';
}

const review = (ctx: BotPresetPromptContext): ReviewRequestLines => REVIEW_REQUEST[ctx.reviewHost ?? 'github'];

/** What the verify worker installs and runs, from the gate its base declares. */
function verifyGateLines(gate: BaseGate | undefined): string[] {
  if (gate?.kind === 'none') {
    return [
      '- This repository declares no gate on its base (no wmux.json verify script, no npm lint or test script), so wmux will run nothing after you report. Install nothing and run no test suite: read the change and report what you found.',
    ];
  }
  const command = gate?.kind === 'declared' ? `\`${gate.command}\`` : 'the repository gate (wmux could not tell which one ahead of time)';
  return [
    `- After you report, wmux runs ${command} on this commit, so install the dependencies that gate needs (for a Node project, a real \`npm ci\`), whatever the change is. Run checks yourself for what a code change touches.`,
  ];
}

const VERIFY_PROMPT = (ctx: BotPresetPromptContext): string => [
  '# Verify worker',
  '',
  `You are a verify worker. Your worktree is commit ${ctx.checkout?.sha ?? '(the PR head)'} checked out detached: the exact head of a pull request a factory verifier bot is grading.`,
  '',
  'What you can do here:',
  '- Read the change against its base first: `git log` and `git diff --name-status` between the merge base with origin\'s default branch and HEAD, then the diff itself.',
  `- When ${DOCS_ONLY_RULE}, the change is docs-only: read it and run no test suite yourself.`,
  ...verifyGateLines(ctx.gate),
  '',
  'What you hand back:',
  '- Your findings go in the summary of your ledger row (status review_requested): what the change does, what you ran (if anything) and what it showed, anything that looks wrong, with file:line.',
  '- The tree stays at this commit exactly as checked out: once you report, wmux runs the repository gate on this commit, with the gate taken from the base branch, and records it as the evidence for the verdict.',
  '- If a gate needs dependencies that cannot be installed, or the change cannot be read, report input_required and say what is missing.',
].join('\n');

const REPRO_PROMPT = (ctx: BotPresetPromptContext): string => [
  '# Repro worker',
  '',
  'You are a repro worker. Your worktree is a fresh branch from origin\'s default branch, and the task below describes an issue.',
  '',
  'What you can do here:',
  '- Reproduce the issue with the smallest steps you can find.',
  '- Write a test that fails because of it.',
  '- Attempt the minimal fix that makes that test pass, and run the repository gate (typecheck, lint, tests).',
  `- Commit on your branch, push it with the \`task_push\` tool, and open a DRAFT ${review(ctx).noun} (${review(ctx).draft}) whose body has the repro steps and the test.`,
  `- Once the failing test (and the fix, if there is one) is committed and pushed, ${review(ctx).ready}`,
  '',
  `What you hand back (ledger summary, status review_requested): the repro steps, the failing test, the fix if there is one, and ${review(ctx).link}. When the issue does not reproduce, the summary starts with \`no-repro\` and lists what you tried.`,
].join('\n');

const MAINTAIN_PROMPT = (ctx: BotPresetPromptContext): string => [
  '# Maintain worker',
  '',
  'You are a maintain worker. Your worktree is a fresh branch from origin\'s default branch. You keep the verify-wmux feature map (`.claude/skills/verify-wmux/references/features/*.md`) true to the code.',
  '',
  'What you can do here:',
  `- Read ${review(ctx).read} and the renderer handles they touched.`,
  '- Update the matching feature entries, keeping each entry\'s four-section shape.',
  '- Run each affected verify-wmux recipe once when it can run here, and note the ones that cannot.',
  `- Commit, push with the \`task_push\` tool, and open a ${review(ctx).noun} (${review(ctx).create}) with what changed and why.`,
  '',
  `What you hand back (ledger summary, status review_requested): the entries you changed, the recipes you ran and their outcome, and ${review(ctx).link}; or \`no-drift\` when every entry already matched.`,
].join('\n');

const RESEARCH_PROMPT = (): string => [
  '# Research worker',
  '',
  'You are a research worker dispatched by a factory bot. Your current directory is an empty scratch folder: it is not a repository, and there is no branch, no commit, no push and no pull request for this task.',
  '',
  'What you can do here: search the web, read the sources, and keep notes or downloads in this folder if they help.',
  'When the task asks for files (images, documents, a rendered video, a spreadsheet), make them in this folder; you may install and run local tools in it to do so. Keep every file you hand back inside this folder.',
  '',
  'Completion criteria are fixed on the task at dispatch (you cannot change them). Check each one and record evidence.',
  '',
  'What you hand back (ledger_update status review_requested):',
  '- summary: your findings and what they mean for the question, or what the files you made are;',
  '- evidence: items that show how each criterion was met (kind inspection or artifact with status verified, or kind command with status passed), each finding with a source URL in location or summary. Each deliverable file you made is one artifact item (status verified) with its absolute path in location, and needs no source URL; notes, downloads and installed tools are not listed. Without evidence the task completes as Not verified.',
  'If the question needs a change to code, say so in the summary instead of making one.',
].join('\n');

const DEFAULT_PROMPT = (ctx: BotPresetPromptContext): string => [
  '# Task worker',
  '',
  'You are a task worker dispatched by a factory bot. Your worktree is a fresh branch from origin\'s default branch.',
  '',
  `What you can do here: implement the task below within the files it names, run the repository gate (typecheck, lint, tests), commit, push your branch with the \`task_push\` tool, and open a ${review(ctx).noun} (${review(ctx).create}).`,
  `When the task asks a question instead of a change (research, a comparison, a look at the web), answer it: search, read the sources, and report; such a task opens no ${review(ctx).noun}.`,
  '',
  `What you hand back (ledger summary, status review_requested): what landed, what you verified, and ${review(ctx).link} — or, for a question, your findings with a link to each source.`,
].join('\n');

export const BOT_FANOUT_PRESETS: Readonly<Record<BotFanoutPresetName, BotFanoutPreset>> = {
  verify: {
    name: 'verify',
    description: 'Grade one PR head on a detached checkout; wmux records the base-branch gate at that commit.',
    workerPrompt: VERIFY_PROMPT,
    permissionMode: UNATTENDED,
    agent: CLAUDE,
    checkout: 'required',
    worktree: true,
    maxTasks: 1,
  },
  repro: {
    name: 'repro',
    description: 'Reproduce an issue, write the failing test, attempt a minimal fix, open a PR and mark it ready for CI.',
    workerPrompt: REPRO_PROMPT,
    permissionMode: UNATTENDED,
    agent: CLAUDE,
    checkout: 'none',
    worktree: true,
    maxTasks: 1,
  },
  maintain: {
    name: 'maintain',
    description: 'Update the verify-wmux feature map for merged PRs, run the affected recipes once, open a PR.',
    workerPrompt: MAINTAIN_PROMPT,
    permissionMode: UNATTENDED,
    agent: CLAUDE,
    checkout: 'none',
    worktree: true,
    maxTasks: 1,
  },
  default: {
    name: 'default',
    description: 'A bot\'s task: implement, gate, open a PR (or answer a research question with sources).',
    workerPrompt: DEFAULT_PROMPT,
    permissionMode: UNATTENDED,
    agent: CLAUDE,
    checkout: 'none',
    worktree: true,
    maxTasks: FANOUT_MAX_TASKS,
  },
  research: {
    name: 'research',
    description: 'Answer a question or make files that need no code: search, read, report findings with sources, or make the files in a scratch folder and report their paths. No repository needed.',
    workerPrompt: RESEARCH_PROMPT,
    permissionMode: UNATTENDED,
    agent: CLAUDE,
    checkout: 'none',
    worktree: false,
    maxTasks: FANOUT_MAX_TASKS,
  },
};

/** The built-in preset a bot preset name resolves to, or null. */
export function botFanoutPreset(name: string): BotFanoutPreset | null {
  const key = fanoutPresetKey(name);
  return BOT_FANOUT_PRESET_NAMES.includes(key as BotFanoutPresetName) ? BOT_FANOUT_PRESETS[key as BotFanoutPresetName] : null;
}

/** The presets as fan-out's preset table reads them (one agent row per task
 *  the preset allows; a worktree for every preset but research). */
export function botFanoutPresetList(): FanoutPreset[] {
  return BOT_FANOUT_PRESET_NAMES.map((name) => {
    const p = BOT_FANOUT_PRESETS[name];
    return {
      name: p.name,
      description: p.description,
      items: Array.from({ length: p.maxTasks }, () => ({ ...p.agent })),
      worktree: p.worktree,
    };
  });
}

/**
 * Why a bot's checkout does not fit its preset, or null when it does. `verify`
 * needs a detached checkout of one full commit SHA (the head under test);
 * every other preset takes none.
 */
export function botPresetCheckoutRefusal(name: string, checkout: BotPresetCheckout | undefined): string | null {
  const preset = botFanoutPreset(name);
  if (!preset) return `unknown bot preset "${name.slice(0, 64)}"`;
  if (preset.checkout === 'none') return checkout ? `the ${preset.name} preset starts from a fresh branch; checkout is for verify` : null;
  if (!checkout) return 'the verify preset needs checkout {sha} — the PR head to grade, checked out detached';
  if (checkout.detached !== true) return 'the verify preset checks out the head detached';
  if (!SHA_RE.test(checkout.sha)) return 'the verify preset checks out one full 40-hex commit SHA, the PR head';
  return null;
}

/** The prompt a bot's worker receives: the preset's, then the bot's own. The
 *  bot repository's key picks the review request's CLI (botReviewHost). */
export function composeBotWorkerPrompt(name: string, botPrompt: string, checkout?: BotPresetCheckout, repoKey?: string, gate?: BaseGate): string {
  const preset = botFanoutPreset(name);
  if (!preset) return botPrompt;
  const reviewHost = botReviewHost(repoKey);
  const head = preset.workerPrompt({ ...(checkout ? { checkout } : {}), ...(reviewHost ? { reviewHost } : {}), ...(gate ? { gate } : {}) });
  const own = botPrompt.trim();
  return own ? `${head}\n\n## Your task\n\n${own}` : head;
}
