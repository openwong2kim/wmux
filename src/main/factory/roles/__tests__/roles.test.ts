// Each bot's prompt is its job and its powers: it carries the owner's job
// text (else its template's default job), describes every tool on the shared
// surface once, names no tool outside it, and carries no list of
// prohibitions (what a bot cannot do is out of its reach structurally).
import { describe, expect, it } from 'vitest';
import { BOT_ROLES, BOT_TEMPLATES, DEFAULT_BOT_BUDGETS, TEMPLATE_LEGACY_ROLE, type BotProfile, type BotRole, type BotTemplate } from '../../../../shared/bot';
import { BOT_TOOL_RPC, SHARED_SURFACE } from '../../../../shared/botSurface';
import { TEMPLATE_DEFINITIONS, rolePrompt, templateDefinitionOf } from '../index';
import { NO_CHANGES_SETTLE, renderBotPrompt } from '../common';
import { BOT_FANOUT_PRESETS } from '../../../worktask/botFanoutPresets';

function profile(template: BotTemplate, over: Partial<BotProfile> = {}): BotProfile {
  const role: BotRole = TEMPLATE_LEGACY_ROLE[template];
  return {
    version: 1, id: 'bot-0a1b2c3d', workspaceId: 'ws-1', role, template, name: `My ${template}`, engine: { kind: 'claude-sdk' },
    triggers: [], budget: { ...DEFAULT_BOT_BUDGETS[role] }, repo: { repoKey: 'github.com/acme/app', repoPath: '/repo' },
    enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

/** Tool names a prompt could mention: every bot tool, and the wmux tools that
 *  sit on no bot surface. */
const OTHER_WMUX_TOOLS = [
  'terminal_send', 'terminal_send_key', 'pane_close', 'pane_split', 'surface_close', 'surface_new', 'send_message', 'channel_post',
  'browser_open', 'browser_click', 'computer', 'task_gate_run', 'task_adopt', 'moa_ask', 'deck_ask_decision', 'repl_run',
];
const KNOWN_TOOLS = [...Object.keys(BOT_TOOL_RPC), ...OTHER_WMUX_TOOLS];

function mentionedTools(text: string): Set<string> {
  const out = new Set<string>();
  for (const name of KNOWN_TOOLS) if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) out.add(name);
  return out;
}

const rolePromptOf = (t: BotTemplate): string => renderBotPrompt(templateDefinitionOf(profile(t)), profile(t));

const PROHIBITION = /\b(never|don't|do not|must not|not allowed|forbidden|prohibited)\b/i;

describe('bot prompts (job, powers and outputs)', () => {
  it('every template has its definition', () => {
    for (const t of BOT_TEMPLATES) expect(TEMPLATE_DEFINITIONS[t].template).toBe(t);
  });

  for (const template of BOT_TEMPLATES) {
    describe(template, () => {
      const prompt = rolePrompt(profile(template));

      it('names only tools on the shared surface', () => {
        const outside = [...mentionedTools(prompt)].filter((t) => !SHARED_SURFACE.tools.has(t));
        expect(outside).toEqual([]);
      });

      it('describes every tool on the surface, once, with what it is for', () => {
        for (const tool of SHARED_SURFACE.tools) {
          const lines = prompt.split('\n').filter((l) => l.startsWith(`- ${tool}: `));
          expect({ tool, n: lines.length }).toEqual({ tool, n: 1 });
          expect(lines[0].length).toBeGreaterThan(`- ${tool}: `.length + 10);
        }
      });

      it('carries no prohibitions', () => {
        const lines = prompt.split('\n').filter((l) => PROHIBITION.test(l));
        expect(lines).toEqual([]);
      });

      it('states who the bot is, its job, its outputs, the team and thread rules and how a wake ends', () => {
        expect(prompt).toContain(`You are My ${template}, a bot of wmux workspace ws-1. Your repository is github.com/acme/app.`);
        expect(prompt).toContain(`Your job:\n${TEMPLATE_DEFINITIONS[template].defaultJob}`);
        expect(prompt).toContain('What you produce:');
        expect(prompt).toContain('Working with the owner and the other bots:');
        expect(prompt).toContain('land in the wake\'s thread; wmux pins it');
        expect(prompt).toContain('Finishing a wake:');
        expect(prompt).toMatch(/Waiting is ending the turn/);
        expect(prompt).toMatch(/intro \(you were just added\)/);
        expect(prompt).toMatch(/record it with job_set/);
        expect(prompt).toMatch(/stop_my_work/);
      });

      it('names only bot presets', () => {
        for (const m of prompt.matchAll(/preset "([a-z]+)"/g)) expect(Object.keys(BOT_FANOUT_PRESETS)).toContain(m[1]);
      });
    });
  }

  it('the owner\'s job text replaces the template\'s default, verbatim', () => {
    const job = 'Find the root cause of every open issue and fix it.\nReport hourly.';
    const prompt = rolePrompt(profile('custom', { job }));
    expect(prompt).toContain(`Your job:\n${job}\n`);
    expect(prompt).not.toContain(TEMPLATE_DEFINITIONS.custom.defaultJob);
  });

  it('a profile from before templates is prompted by its role\'s template; a legacy maintainer keeps its job', () => {
    for (const role of BOT_ROLES) {
      const p = { ...profile('custom'), role, template: undefined };
      expect(rolePrompt(p)).toContain('Your job:');
    }
    expect(templateDefinitionOf({ role: 'moa' })).toBe(TEMPLATE_DEFINITIONS.coordinator);
    expect(templateDefinitionOf({ role: 'verifier' })).toBe(TEMPLATE_DEFINITIONS.reviewer);
    expect(rolePrompt({ ...profile('custom'), role: 'maintainer' })).toMatch(/verify-wmux feature map/);
    expect(rolePrompt({ ...profile('custom'), role: 'maintainer', job: 'Something else.' })).toContain('Your job:\nSomething else.');
  });

  it('a bot whose tasks the task gate checks is told to settle a no_changes task from its report, completed or failed', () => {
    const ledgerLine = (prompt: string): string => prompt.split('\n').find((l) => l.startsWith('- ledger_update: ')) ?? '';
    // The reviewer's verify tasks have their own gate and are never skipped for no_changes.
    for (const template of BOT_TEMPLATES.filter((t) => t !== 'reviewer')) {
      expect({ template, says: ledgerLine(rolePrompt(profile(template))).includes(NO_CHANGES_SETTLE) }).toEqual({ template, says: true });
    }
    expect(ledgerLine(rolePrompt({ ...profile('custom'), role: 'maintainer' }))).toContain(NO_CHANGES_SETTLE);
    expect(NO_CHANGES_SETTLE).toMatch(/skipped "no_changes"/);
    expect(NO_CHANGES_SETTLE).toMatch(/completed when the report shows the job done, failed when it shows the job failed/);
  });

  it('any bot with a repository has the Read / Grep / Glob power line, a Coordinator included; a bot without one does not', () => {
    const line = (p: BotProfile) => rolePrompt(p).split('\n').filter((l) => l.startsWith('- Read, Grep, Glob: '));
    for (const template of BOT_TEMPLATES) {
      expect(line(profile(template))).toHaveLength(1);
      expect(line(profile(template))[0]).toContain('your repository at /repo');
      expect(rolePrompt(profile(template))).toContain('Your powers are your wmux tools and reading your repository;');
      expect(line(profile(template, { repo: undefined }))).toEqual([]);
      expect(line(profile(template, { engine: { kind: 'acp', command: 'hermes', args: [] } }))).toEqual([]);
    }
    expect(line(profile('developer'))[0]).toMatch(/to answer questions and to decide; changes, commands, tests and gates are a worker's \(fan-out\)\./);
    // What a bot does itself and what a worker is for, as powers.
    expect(rolePrompt(profile('developer'))).toContain('you answer questions, read code (Read, Grep, Glob) and read PR, issue and CI status (pr_read, issue_read, ci_read) yourself, in the turn. A worker (fanout_start) is for what those cannot do: changing code, or running commands, tests and builds');
    expect(rolePrompt(profile('developer', { repo: undefined }))).toContain('A worker (fanout_start) is for what those cannot do: reading or changing code, or running commands, tests and builds');
    expect(line(profile('reviewer'))[0]).toMatch(/Your own reading informs, the verify task's gate decides the verdict\./);
  });

  it('a bot tells its workers to bring in fresh main with task_fetch, never a git fetch of their own', () => {
    for (const template of ['coordinator', 'developer', 'issue', 'custom'] as const) {
      expect(rolePrompt(profile(template))).toContain('with its task_fetch tool (wmux fetches with its own credentials), running the `git fetch` line it returns, then `git merge origin/<default branch>`');
    }
    expect(rolePrompt({ ...profile('custom'), template: 'custom', role: 'maintainer' })).toContain('task_fetch');
    expect(rolePrompt(profile('developer'))).toContain('A PR that conflicts with the default branch goes back to its worker (worker_message, or worker_resume once it ended): run task_fetch, run the `git fetch` line it returns, then `git merge origin/<default branch>`');
  });

  it('each template words its own work', () => {
    expect(rolePrompt(profile('reviewer'))).toMatch(/pr_verdict: .*evidence \{taskId\}/);
    expect(rolePrompt(profile('reviewer'))).toMatch(/UI recipes are outside it/);
    expect(rolePrompt(profile('coordinator'))).toMatch(/One `report` card|A `report` card when the owner asks/);
    expect(rolePrompt(profile('coordinator'))).toMatch(/room_read: .*any workspace/);
    expect(rolePrompt(profile('issue'))).toMatch(/preset "repro"/);
    expect(rolePrompt(profile('developer'))).toMatch(/preset "default"/);
    expect(rolePrompt(profile('researcher'))).toMatch(/source/);
    // Only the Coordinator is told it reads other workspaces.
    for (const template of BOT_TEMPLATES.filter((t) => t !== 'coordinator')) {
      expect(rolePrompt(profile(template))).not.toMatch(/any workspace's room/);
    }
  });

  it('the coordinator leads the room\'s flow with next; no template speaks of Moa; every bot sends a relay\'s result on', () => {
    const lead = rolePrompt(profile('coordinator'));
    expect(lead).toMatch(/handoff_send: .*next/);
    expect(lead).toMatch(/decide the flow/);
    expect(lead).toMatch(/A relay's last result/);
    // A closed issue or a merged PR is not dispatched again (#2214 was re-sent after its PR merged).
    expect(lead).toMatch(/Before you dispatch work on an issue or a pull request.*issue_read or pr_read.*is not dispatched again/);
    for (const template of BOT_TEMPLATES) {
      const prompt = rolePrompt(profile(template));
      expect(prompt).not.toMatch(/\bMoa\b/);
      expect(prompt).toMatch(/wmux passes it to the next bot or back to the coordinator/);
    }
    expect(rolePrompt(profile('researcher'))).toMatch(/send its `result`: the findings with their sources/);
    expect(rolePrompt(profile('developer'))).toMatch(/once its work is where the dispatch asked for it/);
  });

  it('a profile without a repository leaves the repository sentence out', () => {
    expect(rolePrompt(profile('coordinator', { repo: undefined }))).not.toContain('Your repository');
  });

  it('names the workspace by the owner\'s name for it, so a greeting does not name the repository folder', () => {
    const p = profile('coordinator');
    const first = (ws?: string | null) => renderBotPrompt(templateDefinitionOf(p), p, ws).split('\n')[0];
    expect(first('Workspace 1')).toBe('You are My coordinator, a bot of the wmux workspace "Workspace 1" (id ws-1); call it "Workspace 1" when you speak of it. Your repository is github.com/acme/app.');
    expect(first('Team "A"\nB')).toContain('workspace "Team A B"');
    expect(first(null)).toBe('You are My coordinator, a bot of wmux workspace ws-1. Your repository is github.com/acme/app.');
  });

  it('a delegate reports bot-handed work through its result only; approval reasons follow the owner\'s language', () => {
    for (const t of BOT_TEMPLATES) {
      const prompt = rolePromptOf(t);
      expect(prompt).toContain('Work another bot handed you is reported to the owner by that bot: your outcome goes in the `result` only. Post no status or report card of your own about that outcome in its thread');
      expect(prompt).toContain('The owner reads the reason on the approval card: write it in the owner\'s language');
    }
    const dev = rolePromptOf('developer');
    expect(dev).toContain('A `status` card per task outcome of work the owner asked of you');
    expect(dev).toContain('work another bot handed you gets no status card: its outcome goes in the `result`');
  });
});

describe('a bot with nothing to add stays silent', () => {
  it('every template says ending without posting means ending with no text, never a line about not posting', () => {
    for (const template of BOT_TEMPLATES) {
      const text = rolePrompt(profile(template));
      expect(text).toContain('Ending without posting means ending with no text either');
      expect(text).toContain('silence is an empty ending, not a line saying you stay silent');
    }
  });
});

describe('the owner is spoken to, not named', () => {
  it('every template says "the owner" is not what the bot calls them, and no title in Korean', () => {
    for (const template of BOT_TEMPLATES) {
      const text = rolePrompt(profile(template));
      expect(text).toContain('"The owner" in these instructions names the person you talk to, not what you call them: speak to them directly, as "you", with no label or title');
      expect(text).toContain('in Korean, plain sentences with no "owner님", "오너님" or other title');
      expect(text).toContain('Use their name only when they have told you it.');
    }
  });
});
