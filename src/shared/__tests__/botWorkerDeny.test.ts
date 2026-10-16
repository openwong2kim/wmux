// What a bot worker's deny rules cover, read the way Claude Code reads a
// `Bash(<pattern>)` rule: the whole command matches the pattern, `*` standing
// for any run of characters. (The rules' behaviour inside claude itself was
// measured for the merge rules; see main/agents/botWorkerMergeGuard.ts.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BOT_WORKER_DENY, BOT_WORKER_MERGE_DENY, BOT_WORKER_PUBLIC_DENY, BOT_WORKER_PUSH_DENY, buildBotWorkerSettings, botWorkerDefaultBranchesPath,
  botWorkerSessionsPath, isDenyableBranchName, namesClaude, readBotWorkerDefaultBranches, readBotWorkerSessions, recordBotWorkerDefaultBranch, writeBotWorkerSettings,
} from '../botWorkerGuard';
import { wslClaudeHooks } from '../wslIntegration';

function denied(command: string, rules: readonly string[] = BOT_WORKER_DENY): boolean {
  return rules.some((rule) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const re = new RegExp(`^${m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(command);
  });
}

describe('bot worker deny rules', () => {
  it('the settings document carries every rule, merge rules first', () => {
    expect(buildBotWorkerSettings()).toEqual({ permissions: { deny: [...BOT_WORKER_DENY] }, disableAllHooks: false, hooks: wslClaudeHooks() });
    expect(BOT_WORKER_DENY.slice(0, BOT_WORKER_MERGE_DENY.length)).toEqual([...BOT_WORKER_MERGE_DENY]);
    expect(BOT_WORKER_DENY).toEqual(expect.arrayContaining([...BOT_WORKER_PUSH_DENY, ...BOT_WORKER_PUBLIC_DENY]));
  });

  it('a WSL worker\'s settings keep wmux\'s hooks, which its own --settings would otherwise replace (#2261)', () => {
    const hooks = buildBotWorkerSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    // The turn end (idle reclaim) and the session id (resume) come from these.
    for (const event of ['SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']) {
      expect(hooks[event]?.[0]?.hooks[0]?.command, event).toBe(`/bin/sh "$WMUX_WSL_HOOK" ${event}`);
    }
    // No Windows path: Linux claude runs them through the WSL hook script.
    expect(JSON.stringify(hooks)).not.toMatch(/[A-Za-z]:[\\/]|\.mjs|node /);
  });

  it('the rule set is pinned: any change to a rule is a deliberate change to this test', () => {
    expect(BOT_WORKER_DENY.length).toBe(289);
    expect(createHash('sha256').update(JSON.stringify(BOT_WORKER_DENY)).digest('hex'))
      .toBe('682d41805516beb078960a404862ae7b8169cad228c892718eefe1ad8469f091');
  });

  it('no rule holds a `:*` that does not end it (Claude Code reads such a rule with a notice)', () => {
    expect(BOT_WORKER_DENY.filter((r) => r.includes(':*') && !r.endsWith(':*)'))).toEqual([]);
  });

  it('no rule ends in `:*` after another `*`, which Claude Code would match literally', () => {
    expect(BOT_WORKER_DENY.filter((r) => /\*.*:\*\)$/.test(r))).toEqual([]);
  });

  it.each([
    'gh pr merge 3 --squash',
    'gh api -X PUT repos/o/r/pulls/3/merge',
    'git push --force origin wtask/a',
    'git push origin wtask/a --force-with-lease',
    'git push -f origin wtask/a',
    'git push origin wtask/a -f',
    'git push -fu origin wtask/a',
    'git -C /w push --force',
    'git push origin +wtask/a',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin wtask/a:main',
    'git push origin HEAD:refs/heads/master',
    'git push origin master --tags',
    'gh issue create --title x --body y',
    'gh issue close 4',
    'gh issue comment 4 --body hi',
    'gh pr comment 3 --body hi',
    'gh pr review 3 --approve',
    'gh pr close 3',
    'gh release create v1.0.0',
    'gh api -X POST repos/o/r/issues',
    'gh api --method PATCH repos/o/r/issues/4',
    'gh api -XDELETE repos/o/r/git/refs/heads/x',
    'gh api -X post repos/o/r/issues',
    'gh api repos/o/r/issues -f title=x',
    'gh api graphql -F query=@q.graphql',
    'gh api repos/o/r/issues --raw-field title=x',
    'gh api repos/o/r/issues --input body.json',
    'git push --mirror origin',
    'git push origin --all',
    'git push -uf origin wtask/a',
    'git push -vuf origin wtask/a',
    'git push origin --delete wtask/a',
    'git push origin :wtask/a',
    'gh issue delete 4',
    'gh issue reopen 4',
    'gh issue edit 4 --title x',
    'gh pr edit 3 --title x',
    'gh release delete v1',
    'gh repo delete o/r --yes',
    'gh secret set TOKEN',
    'git push',
    'git push origin',
    'git push -u origin',
    'git push --set-upstream origin',
    'git push origin HEAD',
    'git push -u origin HEAD',
    'git config remote.origin.push refs/heads/*:refs/heads/develop',
    'git config remote.origin.pushurl git@example.com:o/other.git',
    'git config remote.origin.url git@example.com:o/other.git',
    'git remote set-url --push origin git@example.com:o/other.git',
    'git remote set-url origin git@example.com:o/other.git',
    'git -C /w remote set-url origin git@example.com:o/other.git',
    'git config url.git@example.com:o/other.git.pushInsteadOf git@github.com:o/r.git',
    'git remote add other git@example.com:o/other.git',
    'git remote rename origin old',
    'git remote remove origin',
    'git -C /w remote rm origin',
    'git send-pack git@example.com:o/other.git HEAD:refs/heads/x',
    'git http-push https://example.com/o/r.git x',
    'git config alias.p push',
    'git config --local alias.p "!git push"',
    'git -c alias.p=push p origin wtask/a',
    // Every push is main's (task.push): the worker's own, in any form.
    'git push origin wtask/fix-main-menu',
    'git push -u origin wtask/a',
    'git push origin HEAD:wtask/a',
    'git -C /w push origin wtask/a',
    'git --git-dir=/w/.git push origin wtask/a',
    'git -c push.default=upstream push origin',
    'git -c remote.origin.push=HEAD:develop push origin wtask/a',
    // gh's global options before the group, between the group and the verb, or both.
    'gh -R o/r pr merge 3 --squash',
    'gh --repo o/r pr merge 3',
    'gh --repo=o/r pr merge 3',
    'gh pr -R o/r merge 3 --squash',
    'gh pr --repo=o/r merge',
    'gh -R o/r pr --repo o/r merge 3',
    'gh -R o/r issue close 4',
    'gh issue -R o/r comment 4 --body hi',
    'gh --repo o/r release create v1',
    'gh -R o/r secret set TOKEN',
    'gh --hostname example.com api -X PUT repos/o/r/pulls/3/merge',
    'gh --hostname example.com api repos/o/r/issues -f title=x',
    'gh alias set pm "pr merge"',
    'gh alias import aliases.yml',
  ])('refuses %s', (cmd) => {
    expect(denied(cmd)).toBe(true);
  });

  it.each([
    'gh pr create --title x --body y',
    'gh pr view 3 --json headRefOid',
    'gh pr checks 3',
    'gh issue view 4',
    'gh api repos/o/r/pulls/3',
    'gh api repos/o/r/issues --jq .[].title',
    'gh release view v1.0.0',
    'gh release list',
    'gh release download v1.0.0',
    'gh api repos/o/r/contents/POST.md',
    'git config user.name bot',
    'git branch -a',
    'git stash',
    'git stash push',
    'git commit -m "push the fix"',
    'git log --grep push',
    'git config push.default upstream',
    'git remote get-url origin',
    'git remote -v',
    'gh -R o/r pr view 3 --json mergeable',
    'gh pr -R o/r view 3 --json mergeable,mergeStateStatus',
    'gh -R o/r pr checks 3',
    'gh -R o/r pr create --title x --body y',
    'gh -R o/r issue view 4',
    'gh issue -R o/r list',
    'gh alias list',
  ])('lets %s through', (cmd) => {
    expect(denied(cmd)).toBe(false);
  });
});

describe('which lines start claude', () => {
  it('sees every claude launcher, a glued one included, and not a longer word', () => {
    for (const yes of ['claude', '/opt/bin/claude --resume x', 'true;claude', 'a&&claude -p x', '(claude)', 'x|claude.exe']) expect(namesClaude(yes), yes).toBe(true);
    for (const no of ['codex', 'git log --grep claudex', 'echo claudeish']) expect(namesClaude(no), no).toBe(false);
  });
});

describe('the bot worker sessions record', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sessions-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps the optional codex launch fields of a version-1 record, and ignores malformed ones without dropping the record', () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(botWorkerSessionsPath(dir), JSON.stringify({ version: 1, sessions: {
      a: { workspaceId: 'ws-a', at: 1, agent: 'codex', cwd: '/w/a', repoKey: 'acme/app' },
      b: { workspaceId: 'ws-b', at: 2, agent: 7, cwd: { no: 1 } },
      c: { workspaceId: 'ws-c', at: 3 },
    } }));
    const read = readBotWorkerSessions(dir) as { sessions: Map<string, unknown> };
    expect(read.sessions.get('a')).toEqual({ workspaceId: 'ws-a', at: 1, agent: 'codex', cwd: '/w/a', repoKey: 'acme/app' });
    expect(read.sessions.get('b')).toEqual({ workspaceId: 'ws-b', at: 2 });
    expect(read.sessions.get('c')).toEqual({ workspaceId: 'ws-c', at: 3 });
  });
});

describe('a repository\'s own default branch', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-default-branch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('only a plain ref name can be recorded', () => {
    for (const ok of ['develop', 'trunk', 'release/2.x', 'v1.0', '_trunk', 'dévelop', '개발', 'x'.repeat(255)]) expect(isDenyableBranchName(ok)).toBe(true);
    for (const bad of ['', '*', 'dev*', 'a b', 'x)', '-f', '.x', 'a..b', 'a/', 'a.lock', 'a@{1}', 'a:b', 'a~1', 'a$b', 'x'.repeat(256), 42]) expect(isDenyableBranchName(bad)).toBe(false);
  });

  it('main records it once (for its own push); the worker settings never depend on it; an unreadable file means main/master only', () => {
    expect(recordBotWorkerDefaultBranch(dir, 'develop')).toBe(true);
    expect(recordBotWorkerDefaultBranch(dir, 'develop')).toBe(true);
    expect(recordBotWorkerDefaultBranch(dir, 'main')).toBe(true);
    expect(recordBotWorkerDefaultBranch(dir, 'dev*')).toBe(false);
    expect(readBotWorkerDefaultBranches(dir)).toEqual(['develop']);
    const settings = JSON.parse(fs.readFileSync(writeBotWorkerSettings(dir), 'utf8'));
    expect(settings).toEqual(buildBotWorkerSettings());
    fs.writeFileSync(botWorkerDefaultBranchesPath(dir), '{nope');
    expect(readBotWorkerDefaultBranches(dir)).toEqual([]);
  });
});
