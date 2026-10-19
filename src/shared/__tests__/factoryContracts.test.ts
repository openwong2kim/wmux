import { describe, expect, it } from 'vitest';
import { FACT_KINDS, factDedupeKey, isFactKind, type FactKind } from '../facts';
import { dmThreadBot, dmThreadId, groupThreadGroup, groupThreadId, parseThreadId, prThreadId, issueThreadId, taskOriginThread, taskThreadOf } from '../room';
import { normalizeRepoKey } from '../repoKey';
import {
  BOT_JOB_MAX,
  BOT_ROLES,
  BOT_TEMPLATES,
  TEMPLATE_LEGACY_ROLE,
  botTemplate,
  isBotTemplate,
  isCoordinatorBot,
  normalizeBotJob,
  templateOfRole,
  DEFAULT_BOT_BUDGETS,
  DEFAULT_BOT_ENGINE,
  botArgValue,
  botMcpArgs,
  botTokenFileArgValue,
  isBotBinding,
} from '../bot';
import { botFanoutIdempotencyKey, wakeReasonDedupeKey } from '../wake';
import { APPROVAL_NEVER_BY_RULE, isOwnerApprovalText } from '../botApproval';
import { SECRET_GRANT_ID_RE, isBotSecretName } from '../botSecret';

const AT = Date.UTC(2026, 9, 12, 9, 30, 15);
const MINUTE = Math.floor(AT / 60_000);

describe('factDedupeKey', () => {
  it('builds the design keys', () => {
    const repoKey = 'openwong2kim/wmux';
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, repoKey, ref: { pr: 12 } })).toBe('pr.opened:openwong2kim/wmux#12');
    expect(factDedupeKey({ kind: 'pr.head_moved', at: AT, repoKey, ref: { pr: 12, headSha: 'abc' } }))
      .toBe('pr.head_moved:openwong2kim/wmux#12:abc');
    expect(factDedupeKey({ kind: 'ci.green', at: AT, repoKey, ref: { pr: 12, headSha: 'abc' } })).toBe('ci.green:openwong2kim/wmux#12:abc');
    expect(factDedupeKey({ kind: 'issue.labelled', at: AT, repoKey, ref: { issue: 3, label: 'bug' } }))
      .toBe('issue.labelled:openwong2kim/wmux#3:bug');
    expect(factDedupeKey({ kind: 'verdict.recorded', at: AT, repoKey, ref: { pr: 12, headSha: 'abc', botId: 'bot-0000beef' } }))
      .toBe('verdict.recorded:openwong2kim/wmux#12:abc:bot-0000beef');
    expect(factDedupeKey({ kind: 'merge.done', at: AT, repoKey, ref: { pr: 12 } })).toBe('merge.done:openwong2kim/wmux#12');
    expect(factDedupeKey({ kind: 'task.done', at: AT, ref: { taskId: 't1' } })).toBe('task.done:t1');
    expect(factDedupeKey({ kind: 'pane.idle', at: AT, ref: { ptyId: 'p1' } })).toBe(`pane.idle:p1:${MINUTE}`);
    expect(factDedupeKey({ kind: 'handoff.received', at: AT, ref: { handoffId: 'h-1' } })).toBe('handoff.received:h-1');
    expect(factDedupeKey({ kind: 'schedule.fired', at: AT, ref: { scheduleId: 'morning' } }))
      .toBe(`schedule.fired:morning:${Math.floor(AT / 86_400_000)}`);
    expect(factDedupeKey({ kind: 'bot.refused', at: AT, ref: { botId: 'bot-0000beef', method: 'input.send' } }))
      .toBe(`bot.refused:bot-0000beef:input.send:${MINUTE}`);
  });

  it('a budget park is reported once per park: a second park in the same hour gets its own key', () => {
    const bot = { botId: 'bot-0000beef' };
    const first = factDedupeKey({ kind: 'bot.budget_exhausted', at: AT, ref: bot, payload: { reason: 'turns_hour', parkedAt: AT } });
    const again = factDedupeKey({ kind: 'bot.budget_exhausted', at: AT, ref: bot, payload: { reason: 'turns_hour', parkedAt: AT } });
    const second = factDedupeKey({ kind: 'bot.budget_exhausted', at: AT + 600_000, ref: bot, payload: { reason: 'turns_hour', parkedAt: AT + 600_000 } });
    expect(first).toBe(`bot.budget_exhausted:bot-0000beef:park:${AT}`);
    expect(again).toBe(first);
    expect(second).not.toBe(first);
    // No park (a worker start refused): one per reason per hour.
    expect(factDedupeKey({ kind: 'bot.budget_exhausted', at: AT, ref: bot, payload: { reason: 'worker_hours_day' } }))
      .toBe(`bot.budget_exhausted:bot-0000beef:worker_hours_day:${Math.floor(AT / 3_600_000)}`);
  });

  it('a slot refusal and a budget refusal in the same hour keep their own keys', () => {
    const bot = { botId: 'bot-0000beef' };
    const hour = Math.floor(AT / 3_600_000);
    const keys = [
      factDedupeKey({ kind: 'bot.workers_full', at: AT, ref: bot, payload: { scope: 'bot', running: 2, limit: 2 } }),
      factDedupeKey({ kind: 'bot.workers_full', at: AT, ref: bot, payload: { scope: 'factory', running: 3, limit: 3 } }),
      factDedupeKey({ kind: 'bot.budget_exhausted', at: AT, ref: bot, payload: { reason: 'worker_hours_day' } }),
    ];
    expect(keys).toEqual([
      `bot.workers_full:bot-0000beef:bot:${hour}`,
      `bot.workers_full:bot-0000beef:factory:${hour}`,
      `bot.budget_exhausted:bot-0000beef:worker_hours_day:${hour}`,
    ]);
    expect(factDedupeKey({ kind: 'bot.workers_full', at: AT, ref: bot, payload: {} })).toBe(`bot.workers_full:bot-0000beef:${hour}`);
  });

  it('a verdict from a pane (no bot) keys on its workspace', () => {
    expect(factDedupeKey({ kind: 'verdict.recorded', at: AT, repoKey: 'a/b', workspaceId: 'ws-1', ref: { pr: 1, headSha: 'f' } }))
      .toBe('verdict.recorded:a/b#1:f:ws-1');
  });

  it('refuses (null) when the parts the kind needs are missing', () => {
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, ref: { pr: 12 } })).toBeNull();
    expect(factDedupeKey({ kind: 'pr.head_moved', at: AT, repoKey: 'a/b', ref: { pr: 12 } })).toBeNull();
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, repoKey: 'a/b', ref: { pr: 0 } })).toBeNull();
    expect(factDedupeKey({ kind: 'task.done', at: AT })).toBeNull();
    expect(factDedupeKey({ kind: 'human.message', at: AT, ref: {} })).toBeNull();
    expect(factDedupeKey({ kind: 'pane.idle', at: Number.NaN, ref: { ptyId: 'p' } })).toBeNull();
  });

  it('has a key rule for every kind', () => {
    const full = { pr: 1, issue: 1, headSha: 's', taskId: 't', botId: 'b', handoffId: 'h', ptyId: 'p', label: 'l', scheduleId: 's', method: 'm', messageId: 'x' };
    for (const kind of FACT_KINDS) {
      expect(factDedupeKey({ kind, at: AT, repoKey: 'a/b', ref: full }), kind).toMatch(new RegExp(`^${kind.replace('.', '\\.')}:`));
    }
    expect(isFactKind('pr.opened')).toBe(true);
    expect(isFactKind('pr.reopened' as FactKind)).toBe(false);
  });
});

describe('thread ids', () => {
  it('accepts the thread shapes and builds pr / issue ids', () => {
    expect(parseThreadId('general')).toBe('general');
    expect(parseThreadId('pr:a/b#12')).toBe('pr:github.com/a/b#12');
    expect(parseThreadId(prThreadId('github.com/a/b', 5))).toBe('pr:github.com/a/b#5');
    expect(parseThreadId(issueThreadId('github.com/a/b', 3))).toBe('issue:github.com/a/b#3');
  });

  it('a bot\'s 1:1 thread is dm:<bot id>, and nothing else after dm: parses', () => {
    expect(dmThreadId('bot-0a1b2c3d')).toBe('dm:bot-0a1b2c3d');
    expect(parseThreadId('dm:bot-0a1b2c3d')).toBe('dm:bot-0a1b2c3d');
    expect(dmThreadBot('dm:bot-0a1b2c3d')).toBe('bot-0a1b2c3d');
    for (const v of ['dm:', 'dm:bot-XYZ', 'dm:moa', 'dm:bot-0a1b2c3d/x']) expect(parseThreadId(v), v).toBeNull();
    for (const v of ['general', 'task:t-1', 'dm:nope', undefined]) expect(dmThreadBot(v)).toBeNull();
  });

  it('a group chat\'s thread is group:<group id>, and nothing else after group: parses', () => {
    expect(groupThreadId('grp-0a1b2c3d')).toBe('group:grp-0a1b2c3d');
    expect(parseThreadId('group:grp-0a1b2c3d')).toBe('group:grp-0a1b2c3d');
    expect(groupThreadGroup('group:grp-0a1b2c3d')).toBe('grp-0a1b2c3d');
    for (const v of ['group:', 'group:grp-XYZ', 'group:bot-0a1b2c3d', 'group:grp-0a1b2c3d/x']) expect(parseThreadId(v), v).toBeNull();
    for (const v of ['general', 'dm:bot-0a1b2c3d', 'group:nope', undefined]) expect(groupThreadGroup(v)).toBeNull();
  });

  it('one PR is one thread however its repo key is spelled', () => {
    for (const key of ['Acme/App', 'acme/app', 'github.com/Acme/App', 'GitHub.com/acme/app.git', 'github.com/acme/app/']) {
      expect(prThreadId(key, 12)).toBe('pr:github.com/acme/app#12');
      expect(parseThreadId(prThreadId(key, 12))).toBe('pr:github.com/acme/app#12');
    }
    expect(issueThreadId('Acme/App', 7)).toBe('issue:github.com/acme/app#7');
    expect(parseThreadId(prThreadId('ghe.corp/acme/app', 1))).toBe('pr:ghe.corp/acme/app#1');
    expect(parseThreadId('task:wt-1')).toBe('task:wt-1');
    expect(parseThreadId('handoff:h-01')).toBe('handoff:h-01');
  });

  it('a thread id from the wire comes back in its canonical spelling', () => {
    for (const id of ['pr:Acme/App#12', 'pr:acme/app#12', 'pr:GitHub.com/Acme/App#12', 'pr:github.com/acme/app.git#12', 'pr:github.com/acme/app#12']) {
      expect(parseThreadId(id), id).toBe('pr:github.com/acme/app#12');
    }
    expect(parseThreadId('issue:Acme/App#7')).toBe('issue:github.com/acme/app#7');
    expect(parseThreadId('pr:GHE.corp/Acme/App#1')).toBe('pr:ghe.corp/acme/app#1');
    // Opaque thread ids keep their case.
    expect(parseThreadId('task:WT-1')).toBe('task:WT-1');
    // Canonical spelling past the length cap is no thread id.
    expect(parseThreadId(`pr:${'a'.repeat(115)}/${'b'.repeat(115)}#1`)).toBeNull();
  });

  it('rejects anything else', () => {
    expect(parseThreadId('pr:GitLab.corp/G/Sub/P#1')).toBe('pr:gitlab.corp/g/sub/p#1');
    for (const bad of ['', 'pr:a/b#0', 'pr:ab#1', 'pr:h/a//c#1', 'pr:a/b#x', 'nope:1', 'task:', 'task:a b', 42, null, `plan:${'x'.repeat(300)}`]) {
      expect(parseThreadId(bad), String(bad)).toBeNull();
    }
  });

  it('a task\'s thread: the recorded wake thread (canonical), else task:<id>; general and junk are none', () => {
    expect(taskOriginThread('issue:Acme/App#21')).toBe('issue:github.com/acme/app#21');
    expect(taskOriginThread('general')).toBeUndefined();
    expect(taskOriginThread('nope:1')).toBeUndefined();
    expect(taskOriginThread(null)).toBeUndefined();
    expect(taskThreadOf({ id: 'wt-1', dispatch: { threadId: 'pr:a/b#3' } })).toBe('pr:github.com/a/b#3');
    expect(taskThreadOf({ id: 'wt-1', dispatch: { threadId: 'general' } })).toBe('task:wt-1');
    expect(taskThreadOf({ id: 'wt-1', dispatch: {} })).toBe('task:wt-1');
    expect(taskThreadOf({ id: 'wt-1' })).toBe('task:wt-1');
  });
});

describe('bot args and bindings', () => {
  it('round-trips the MCP bot args', () => {
    const args = ['/b/index.js', ...botMcpArgs('verifier', '/tmp/x.token')];
    expect(botArgValue(args)).toBe('verifier');
    expect(botTokenFileArgValue(args)).toBe('/tmp/x.token');
    expect(botArgValue(['/b/index.js', '--commander'])).toBeUndefined();
  });

  it('validates a binding', () => {
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'lead' })).toBe(true);
    expect(isBotBinding({ workspaceId: '', botId: 'bot-0a1b2c3d', role: 'lead' })).toBe(false);
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-1', role: 'lead' })).toBe(false);
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'merge' })).toBe(false);
    expect(isBotBinding(null)).toBe(false);
  });

  it('has a default budget for every role and claude-sdk as the default engine', () => {
    for (const role of BOT_ROLES) expect(DEFAULT_BOT_BUDGETS[role].turnTimeoutMs).toBe(600_000);
    // Every bot may start workers; no default carries an hourly cap.
    for (const role of BOT_ROLES) {
      expect(DEFAULT_BOT_BUDGETS[role].maxConcurrentWorkers).toBeGreaterThan(0);
      expect(DEFAULT_BOT_BUDGETS[role].maxTurnsPerHour).toBeUndefined();
    }
    expect(DEFAULT_BOT_ENGINE).toEqual({ kind: 'claude-sdk' });
  });

  it('keys a bot fan-out by wake and ordinal', () => {
    expect(botFanoutIdempotencyKey('w1', 0)).toBe('wake:w1:0');
  });
});

describe('repo keys', () => {
  it('normalizes owner/repo and host/owner/repo to one lowercased host/owner/repo', () => {
    expect(normalizeRepoKey('Acme/App')).toBe('github.com/acme/app');
    expect(normalizeRepoKey(' github.com/Acme/App.git/ ')).toBe('github.com/acme/app');
    expect(normalizeRepoKey('ghe.corp/acme/app')).toBe('ghe.corp/acme/app');
    // An owner/repo whose canonical form would pass the cap is refused, so a stored key always normalizes again.
    const long = `${'o'.repeat(120)}/${'r'.repeat(125)}`;
    expect(long.length).toBeLessThanOrEqual(255);
    expect(normalizeRepoKey(long)).toBeNull();
    const fits = normalizeRepoKey(`${'o'.repeat(120)}/${'r'.repeat(120)}`);
    expect(fits && normalizeRepoKey(fits)).toBe(fits);
    // A GitLab subgroup project keeps its whole path.
    expect(normalizeRepoKey('GitLab.corp/Group/Sub/App.git')).toBe('gitlab.corp/group/sub/app');
    for (const bad of ['', 'app', 'a//b', 'h/a//c', `h/${Array(22).fill('g').join('/')}`, 'a b/c', 'a/b#1', `${'x'.repeat(260)}/a/b`, 42, null, undefined]) {
      expect(normalizeRepoKey(bad), String(bad)).toBeNull();
    }
  });
});

describe('templates and jobs (shared bot surface)', () => {
  it('maps every template to a legacy role and every role to a template', () => {
    for (const t of BOT_TEMPLATES) expect(BOT_ROLES).toContain(TEMPLATE_LEGACY_ROLE[t]);
    expect(BOT_ROLES.map(templateOfRole)).toEqual(['developer', 'issue', 'reviewer', 'custom', 'coordinator']);
    expect(isBotTemplate('coordinator')).toBe(true);
    expect(isBotTemplate('moa')).toBe(false);
  });

  it('reads a template from the profile, else from its legacy role', () => {
    expect(botTemplate({ role: 'moa' })).toBe('coordinator');
    expect(botTemplate({ role: 'moa', template: 'developer' })).toBe('developer');
    expect(isCoordinatorBot({ role: 'lead', template: 'coordinator' })).toBe(true);
    expect(isCoordinatorBot({ role: 'moa', template: 'custom' })).toBe(false);
    expect(isCoordinatorBot({ role: 'moa' })).toBe(true);
    expect(isCoordinatorBot(null)).toBe(false);
    expect(isCoordinatorBot(undefined)).toBe(false);
  });

  it('accepts a trimmed job of 1..BOT_JOB_MAX characters with newlines, nothing else', () => {
    expect(normalizeBotJob('  Find root causes.\r\nFix them.  ')).toBe('Find root causes.\nFix them.');
    expect(normalizeBotJob('a\tb')).toBe('a\tb');
    expect(normalizeBotJob('x'.repeat(BOT_JOB_MAX))).toHaveLength(BOT_JOB_MAX);
    for (const bad of ['', '   ', 'x'.repeat(BOT_JOB_MAX + 1), 'a\u0000b', 'a b', 'a\u001bb', 42, null]) {
      expect(normalizeBotJob(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('wake reason dedupe keys', () => {
  it('keys the reasons that repeat-proof themselves, and only those', () => {
    expect(wakeReasonDedupeKey({ kind: 'handoff', handoffId: 'h-1' })).toBe('handoff:h-1');
    expect(wakeReasonDedupeKey({ kind: 'human', text: 'hi', source: 'desktop', clientMessageId: 'c1' })).toBe('human:c1');
    expect(wakeReasonDedupeKey({ kind: 'human', text: 'hi', source: 'desktop' })).toBeNull();
    expect(wakeReasonDedupeKey({ kind: 'routine', routineId: 'r-abcdefgh', dueAt: 5 })).toBe('routine:r-abcdefgh:5');
    expect(wakeReasonDedupeKey({ kind: 'mention', cardId: 'c-1', handoffId: 'h-2', fromBotId: 'bot-0a1b2c3d' })).toBe('mention:c-1');
    expect(wakeReasonDedupeKey({ kind: 'intro' })).toBe('intro');
    expect(wakeReasonDedupeKey({ kind: 'manual', by: 'human' })).toBeNull();
    expect(wakeReasonDedupeKey({ kind: 'schedule', scheduleId: 'morning' })).toBeNull();
  });
});

describe('owner approval text', () => {
  it('reads short go-ahead words as approval', () => {
    for (const yes of ['머지해', '머지해요', '머지해!', ' 진행해주세요 ', 'merge', 'Merge it.', 'OK', 'go ahead', 'lgtm', '응', 'ok please']) {
      expect(isOwnerApprovalText(yes), yes).toBe(true);
    }
  });

  it('reads anything else — a question, a long message, a negation, a non-string — as no approval', () => {
    for (const no of ['머지하지마', '머지할까?ㅁ', 'merge #12 after the CI fix lands tomorrow', 'no', '', '   ', 'x'.repeat(41), 42, null]) {
      expect(isOwnerApprovalText(no), String(no)).toBe(false);
    }
    expect(APPROVAL_NEVER_BY_RULE.has('release')).toBe(true);
    expect(APPROVAL_NEVER_BY_RULE.has('merge')).toBe(false);
  });
});

describe('bot secret names', () => {
  it('takes credential-shaped upper-snake names only', () => {
    for (const ok of ['NPM_TOKEN', 'OPENAI_API_KEY', 'DEPLOY_PASSWORD', 'GITHUB_TOKEN', 'X_SECRET']) expect(isBotSecretName(ok), ok).toBe(true);
    for (const bad of ['npm_token', 'PATH', 'HOME', 'SSH_AUTH_SOCK', 'MY_VALUE', '_TOKEN', `A${'_'.repeat(60)}TOKEN`, 'A-B_TOKEN', '', 7]) {
      expect(isBotSecretName(bad), String(bad)).toBe(false);
    }
    expect(SECRET_GRANT_ID_RE.test('sg-0123456789abcdef')).toBe(true);
    expect(SECRET_GRANT_ID_RE.test('sg-short')).toBe(false);
  });
});
