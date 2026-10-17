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
//   verify    the PR head, detached. The worker installs dependencies, reads
//             the change against its base and reports findings in its ledger
//             summary. Main then runs the repository gate on that exact
//             commit, with the gate chosen from the base branch, and records
//             it (main/factory/verifyGate.ts) — that record, not the worker's
//             word, is what a verdict rests on.
//   repro     reproduce an issue, write the failing test, attempt a minimal
//             fix, open a DRAFT pull request.
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

import type { FanoutAgentChoice, FanoutPreset } from '../../shared/fanoutPreset';
import { fanoutPresetKey } from '../../shared/fanoutPreset';
import type { FanoutWorkerPermissionMode } from '../../shared/workerLaunch';
import { FANOUT_MAX_TASKS } from '../../shared/workTask';

export type BotFanoutPresetName = 'verify' | 'repro' | 'maintain' | 'default' | 'research';

export const BOT_FANOUT_PRESET_NAMES: readonly BotFanoutPresetName[] = ['verify', 'repro', 'maintain', 'default', 'research'];

export interface BotPresetCheckout {
  sha: string;
  detached: boolean;
  fetchRef?: string;
}

export interface BotFanoutPreset {
  name: BotFanoutPresetName;
  description: string;
  /** The worker's prompt, ahead of the bot's own. */
  workerPrompt: (ctx: { checkout?: BotPresetCheckout }) => string;
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

const VERIFY_PROMPT = (ctx: { checkout?: BotPresetCheckout }): string => [
  '# Verify worker',
  '',
  `You are a verify worker. Your worktree is commit ${ctx.checkout?.sha ?? '(the PR head)'} checked out detached: the exact head of a pull request a factory verifier bot is grading.`,
  '',
  'What you can do here:',
  '- Install the dependencies the repository gate needs (for a Node project, a real `npm ci`).',
  '- Read the change against its base: `git log` and `git diff` between the merge base with origin\'s default branch and HEAD.',
  '- Run checks to understand the change (typecheck, lint, tests for what it touches).',
  '',
  'What you hand back:',
  '- Your findings go in the summary of your ledger row (status review_requested): what the change does, what you ran and what it showed, anything that looks wrong, with file:line.',
  '- The tree stays at this commit exactly as checked out, with dependencies installed: once you report, wmux runs the repository gate on this commit, with the gate taken from the base branch, and records it as the evidence for the verdict.',
  '- If dependencies cannot be installed or the change cannot be read, report input_required and say what is missing.',
].join('\n');

const REPRO_PROMPT = (): string => [
  '# Repro worker',
  '',
  'You are a repro worker. Your worktree is a fresh branch from origin\'s default branch, and the task below describes an issue.',
  '',
  'What you can do here:',
  '- Reproduce the issue with the smallest steps you can find.',
  '- Write a test that fails because of it.',
  '- Attempt the minimal fix that makes that test pass, and run the repository gate (typecheck, lint, tests).',
  '- Commit on your branch, push it with the `task_push` tool, and open a DRAFT pull request (`gh pr create --draft --head <your branch>`) whose body has the repro steps and the test.',
  '',
  'What you hand back (ledger summary, status review_requested): the repro steps, the failing test, the fix if there is one, and the draft PR link. When the issue does not reproduce, the summary starts with `no-repro` and lists what you tried.',
].join('\n');

const MAINTAIN_PROMPT = (): string => [
  '# Maintain worker',
  '',
  'You are a maintain worker. Your worktree is a fresh branch from origin\'s default branch. You keep the verify-wmux feature map (`.claude/skills/verify-wmux/references/features/*.md`) true to the code.',
  '',
  'What you can do here:',
  '- Read the merged pull requests the task names (`gh pr view <n> --json files,title`) and the renderer handles they touched.',
  '- Update the matching feature entries, keeping each entry\'s four-section shape.',
  '- Run each affected verify-wmux recipe once when it can run here, and note the ones that cannot.',
  '- Commit, push with the `task_push` tool, and open a pull request (`gh pr create --head <your branch>`) with what changed and why.',
  '',
  'What you hand back (ledger summary, status review_requested): the entries you changed, the recipes you ran and their outcome, and the PR link; or `no-drift` when every entry already matched.',
].join('\n');

const RESEARCH_PROMPT = (): string => [
  '# Research worker',
  '',
  'You are a research worker dispatched by a factory bot. Your current directory is an empty scratch folder: it is not a repository, and there is no branch, no commit, no push and no pull request for this task.',
  '',
  'What you can do here: search the web, read the sources, and keep notes or downloads in this folder if they help.',
  '',
  'What you hand back (ledger summary, status review_requested): your findings, each with a link to its source, and what they mean for the question. That report completes the task. If the question needs a change to code, say so in the summary instead of making one.',
].join('\n');

const DEFAULT_PROMPT = (): string => [
  '# Task worker',
  '',
  'You are a task worker dispatched by a factory bot. Your worktree is a fresh branch from origin\'s default branch.',
  '',
  'What you can do here: implement the task below within the files it names, run the repository gate (typecheck, lint, tests), commit, push your branch with the `task_push` tool, and open a pull request (`gh pr create --head <your branch>`).',
  'When the task asks a question instead of a change (research, a comparison, a look at the web), answer it: search, read the sources, and report; such a task opens no pull request.',
  '',
  'What you hand back (ledger summary, status review_requested): what landed, what you verified, and the PR link — or, for a question, your findings with a link to each source.',
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
    description: 'Reproduce an issue, write the failing test, attempt a minimal fix, open a draft PR.',
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
    description: 'Answer a question that needs no code: search, read, report findings with sources. No repository needed.',
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

/** The prompt a bot's worker receives: the preset's, then the bot's own. */
export function composeBotWorkerPrompt(name: string, botPrompt: string, checkout?: BotPresetCheckout): string {
  const preset = botFanoutPreset(name);
  if (!preset) return botPrompt;
  const head = preset.workerPrompt({ ...(checkout ? { checkout } : {}) });
  const own = botPrompt.trim();
  return own ? `${head}\n\n## Your task\n\n${own}` : head;
}
