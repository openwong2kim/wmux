// The built-in bot presets: each role preset exists, runs unattended on a
// worktree (research: a scratch folder), and only verify takes a checkout —
// a detached one of one commit.
import { describe, expect, it } from 'vitest';
import { ROLE_SURFACES } from '../../../shared/botSurface';
import { BOT_ROLES } from '../../../shared/bot';
import {
  BOT_FANOUT_PRESETS,
  BOT_FANOUT_PRESET_NAMES,
  botFanoutPreset,
  botFanoutPresetList,
  botPresetCheckoutRefusal,
  botReviewHost,
  composeBotWorkerPrompt,
} from '../botFanoutPresets';

const SHA = 'a'.repeat(40);

describe('bot fan-out presets', () => {
  it('every preset a role surface names exists, and every built-in belongs to a role', () => {
    const named = new Set(BOT_ROLES.flatMap((r) => [...ROLE_SURFACES[r].fanoutPresets]));
    for (const name of named) expect(botFanoutPreset(name)).not.toBeNull();
    expect([...named].sort()).toEqual([...BOT_FANOUT_PRESET_NAMES].sort());
  });

  it('runs unattended, on claude, on a worktree for every preset but research', () => {
    for (const p of botFanoutPresetList()) {
      expect(p.worktree).toBe(p.name !== 'research');
      expect(p.items.length).toBe(BOT_FANOUT_PRESETS[p.name as keyof typeof BOT_FANOUT_PRESETS].maxTasks);
      expect(p.items.every((i) => i.agent === 'claude')).toBe(true);
    }
    for (const name of BOT_FANOUT_PRESET_NAMES) expect(BOT_FANOUT_PRESETS[name].permissionMode).toBe('bypassPermissions');
    expect(BOT_FANOUT_PRESETS.verify.maxTasks).toBe(1);
  });

  it('the research worker, with no worktree, also makes files in its scratch folder and reports their absolute paths, with no push', () => {
    expect(BOT_FANOUT_PRESETS.research.worktree).toBe(false);
    const prompt = composeBotWorkerPrompt('research', 'Make 2 PNG cards.');
    expect(prompt).toContain('When the task asks for files');
    expect(prompt).toContain('Keep every file you hand back inside this folder');
    expect(prompt).toContain('Each deliverable file you made is one artifact item (status verified) with its absolute path in location, and needs no source URL');
    expect(prompt).toContain('notes, downloads and installed tools are not listed');
    expect(prompt).toContain('no push and no pull request');
  });

  it('verify refuses a missing, non-detached or non-commit checkout', () => {
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: true })).toBeNull();
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: true, fetchRef: 'pull/3/head' })).toBeNull();
    expect(botPresetCheckoutRefusal('verify', undefined)).toMatch(/needs checkout/);
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: false })).toMatch(/detached/);
    for (const sha of ['HEAD', 'main', 'a'.repeat(39), 'A'.repeat(40), `${SHA}0`]) {
      expect(botPresetCheckoutRefusal('verify', { sha, detached: true })).toMatch(/40-hex/);
    }
  });

  it('the other presets refuse any checkout; an unknown preset is refused', () => {
    for (const name of ['repro', 'maintain', 'default', 'research']) {
      expect(botPresetCheckoutRefusal(name, undefined)).toBeNull();
      expect(botPresetCheckoutRefusal(name, { sha: SHA, detached: true })).toMatch(/checkout is for verify/);
    }
    expect(botPresetCheckoutRefusal('Image', undefined)).toMatch(/unknown bot preset/);
  });

  it('the worker prompt goes first, the bot\'s own after it; verify names the head', () => {
    const p = composeBotWorkerPrompt('verify', 'look at the IPC change', { sha: SHA, detached: true });
    expect(p.startsWith('# Verify worker')).toBe(true);
    expect(p).toContain(SHA);
    expect(p.endsWith('## Your task\n\nlook at the IPC change')).toBe(true);
    expect(composeBotWorkerPrompt('repro', '')).toMatch(/^# Repro worker[\s\S]*DRAFT pull request[\s\S]*`gh pr ready <number>`/);
    expect(composeBotWorkerPrompt('nope', 'x')).toBe('x');
  });

  it('worker prompts state powers and outputs, without prohibitions', () => {
    for (const name of BOT_FANOUT_PRESET_NAMES) {
      for (const reviewHost of ['github', 'gitlab'] as const) {
        const text = BOT_FANOUT_PRESETS[name].workerPrompt({ checkout: { sha: SHA, detached: true }, reviewHost });
        expect(text).toMatch(/What you hand back/);
        expect(text.split('\n').filter((l) => /\b(never|don't|do not|must not)\b/i.test(l))).toEqual([]);
      }
    }
  });

  it('the review request follows the repository host the way the Git page picks gh or glab', () => {
    expect(botReviewHost('github.com/o/r')).toBe('github');
    expect(botReviewHost('o/r')).toBe('github');
    expect(botReviewHost('gitlab.com/g/p')).toBe('gitlab');
    expect(botReviewHost('git.corp.example/g/sub/p')).toBe('gitlab');
    expect(botReviewHost(undefined)).toBeUndefined();
    expect(botReviewHost('not a key')).toBeUndefined();

    const github = composeBotWorkerPrompt('default', 'fix it', undefined, 'github.com/o/r');
    expect(github).toContain('open a pull request (`gh pr create --head <your branch>`).');
    expect(github).toContain('and the PR link');
    expect(github).not.toMatch(/glab|merge request/);
    for (const key of ['gitlab.com/g/p', 'git.corp.example/g/sub/p']) {
      const gitlab = composeBotWorkerPrompt('default', 'fix it', undefined, key);
      expect(gitlab).toContain('open a merge request (`glab mr create --source-branch <your branch> --title "<title>" --description "<what and why>" --yes`).');
      expect(gitlab).toContain('and the merge request link');
      expect(gitlab).not.toMatch(/gh pr|pull request/);
    }
    const repro = composeBotWorkerPrompt('repro', '', undefined, 'gitlab.com/g/p');
    expect(repro).toContain('open a DRAFT merge request (`glab mr create --draft --source-branch <your branch> --title "<title>" --description "<repro steps and the test>" --yes`)');
    expect(repro).toContain('the merge request stays a draft for the owner to mark ready');
    expect(repro).not.toMatch(/glab mr update/);
    const maintain = composeBotWorkerPrompt('maintain', '', undefined, 'gitlab.com/g/p');
    expect(maintain).toContain('open a merge request (`glab mr create --source-branch <your branch> --title "<title>" --description "<what and why>" --yes`)');
    expect(maintain).toContain('`glab mr view <n> --output json` and `glab mr diff <n>`');
    expect(maintain).not.toMatch(/gh pr/);
    // A GitHub SSH host alias, GitHub Enterprise Cloud and GHES keep gh.
    for (const key of ['github-work/o/r', 'octocorp.ghe.com/o/r', 'github.acme.com/o/r']) {
      expect(botReviewHost(key), key).toBe('github');
    }
    // No host to read: the GitHub lines, as before the host was read.
    for (const name of ['repro', 'maintain', 'default']) {
      expect(composeBotWorkerPrompt(name, 'x')).toBe(composeBotWorkerPrompt(name, 'x', undefined, 'github.com/o/r'));
    }
    expect(composeBotWorkerPrompt('repro', '')).toContain('open a DRAFT pull request (`gh pr create --draft --head <your branch>`)');
  });
});

describe('the verify worker is told what the base gate is', () => {
  const prompt = (gate?: Parameters<typeof composeBotWorkerPrompt>[4]) => composeBotWorkerPrompt('verify', '', { sha: SHA, detached: true }, 'github.com/o/r', gate);

  it('no gate on the base: read and report, no install', () => {
    const p = prompt({ kind: 'none' });
    expect(p).toMatch(/declares no gate on its base[\s\S]*Install nothing and run no test suite/);
    expect(p).not.toMatch(/npm ci/);
  });

  it('a declared gate is named, with the install it needs', () => {
    const p = prompt({ kind: 'declared', command: 'npm run lint + npm test' });
    expect(p).toContain('wmux runs `npm run lint + npm test` on this commit');
    expect(p).toMatch(/npm ci/);
  });

  it('wherever a gate runs after the report, the worker installs what it needs, docs-only or not', () => {
    // main sends a worker only for a head its gate grades: a gate that finds
    // no node_modules is skipped (deps_missing) and nothing can pass.
    for (const p of [prompt(), prompt({ kind: 'declared', command: 'npm test' })]) {
      expect(p).toMatch(/install the dependencies that gate needs \(for a Node project, a real `npm ci`\), whatever the change is/);
      expect(p).toMatch(/the change is docs-only: read it and run no test suite yourself/);
    }
    expect(prompt()).toContain('wmux could not tell which one ahead of time');
  });
});
