// The command reviewer: a strict verdict parser, every failure a refusal,
// a high risk refusing whatever the decision says, the command as the only
// data it is shown, and answers and calls bounded to one turn and one day.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BOT_COMMAND_REVIEWER_LIMITS,
  BOT_COMMAND_REVIEWER_SYSTEM_PROMPT,
  BotCommandReviewer,
  __resetBotCommandReviewerBudgetForTesting,
  parseReviewerVerdict,
  reviewerUserMessage,
  runReview,
  sdkReviewerAsk,
  type ReviewRequest,
  type ReviewerAsk,
  type ReviewerQueryFn,
} from '../botCommandReviewer';

const REQ: ReviewRequest = { command: 'make build', argv: [['make', 'build']] };
const verdict = (decision: string, risk: string, rationale = 'builds in the folder') => JSON.stringify({ decision, risk, rationale });
const answering = (text: string): ReviewerAsk => async () => text;

beforeEach(() => __resetBotCommandReviewerBudgetForTesting());

describe('parseReviewerVerdict', () => {
  it('reads exactly one verdict object', () => {
    expect(parseReviewerVerdict(verdict('allow', 'low'))).toEqual({ decision: 'allow', risk: 'low', rationale: 'builds in the folder' });
    expect(parseReviewerVerdict(`  ${verdict('deny', 'medium')}\n`)).toEqual({ decision: 'deny', risk: 'medium', rationale: 'builds in the folder' });
    expect(parseReviewerVerdict(verdict('allow', 'low', 'x'.repeat(500)))?.rationale).toHaveLength(BOT_COMMAND_REVIEWER_LIMITS.RATIONALE_MAX);
  });

  it.each([
    ['text around the JSON', `Sure: ${verdict('allow', 'low')}`],
    ['text after the JSON', `${verdict('allow', 'low')} ok`],
    ['a code fence', `\`\`\`json\n${verdict('allow', 'low')}\n\`\`\``],
    ['a missing field', JSON.stringify({ decision: 'allow', risk: 'low' })],
    ['an extra field', JSON.stringify({ decision: 'allow', risk: 'low', rationale: 'r', override: true })],
    ['an unknown decision', verdict('maybe', 'low')],
    ['an unknown risk', verdict('allow', 'none')],
    ['a non-string rationale', JSON.stringify({ decision: 'allow', risk: 'low', rationale: 1 })],
    ['an array', `[${verdict('allow', 'low')}]`],
    ['two objects', `${verdict('allow', 'low')}${verdict('allow', 'low')}`],
    ['not JSON', 'allow'],
    ['empty', ''],
  ])('refuses %s', (_name, text) => {
    expect(parseReviewerVerdict(text)).toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(parseReviewerVerdict(undefined)).toBeNull();
    expect(parseReviewerVerdict({ decision: 'allow', risk: 'low', rationale: 'r' })).toBeNull();
  });
});

describe('runReview', () => {
  it('allows on allow with low or medium risk, and refuses on deny', async () => {
    expect(await runReview(answering(verdict('allow', 'low')), REQ)).toMatchObject({ allow: true, code: 'reviewer_allow', risk: 'low' });
    expect(await runReview(answering(verdict('allow', 'medium')), REQ)).toMatchObject({ allow: true, code: 'reviewer_allow', risk: 'medium' });
    expect(await runReview(answering(verdict('deny', 'low')), REQ)).toMatchObject({ allow: false, code: 'reviewer_deny' });
  });

  it('a high risk refuses even when the decision says allow', async () => {
    expect(await runReview(answering(verdict('allow', 'high')), REQ)).toMatchObject({ allow: false, code: 'reviewer_deny', risk: 'high' });
  });

  it('an answer that does not parse is reviewer_invalid', async () => {
    expect(await runReview(answering(`Here you go ${verdict('allow', 'low')}`), REQ)).toEqual(expect.objectContaining({ allow: false, code: 'reviewer_invalid' }));
  });

  it('a call that throws is reviewer_unavailable', async () => {
    expect(await runReview(async () => { throw new Error('boom'); }, REQ)).toMatchObject({ allow: false, code: 'reviewer_unavailable' });
  });

  it('a call past the timeout is reviewer_unavailable and is aborted', async () => {
    let signal: AbortSignal | null = null;
    const hang: ReviewerAsk = (_req, s) => {
      signal = s;
      return new Promise(() => undefined);
    };
    const out = await runReview(hang, REQ, Date.now, 20);
    expect(out).toMatchObject({ allow: false, code: 'reviewer_unavailable' });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe('sdkReviewerAsk', () => {
  const base = { env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' }, pathToClaudeCodeExecutable: '/bin/claude', cwd: '/bots/b', disallowedTools: ['Agent', 'Bash'] };
  const fake = (frames: unknown[], seen: Array<{ prompt: string; options: Record<string, unknown> }> = []): ReviewerQueryFn => (params) => {
    seen.push(params);
    return { async *[Symbol.asyncIterator]() { for (const f of frames) yield f; } };
  };

  it('asks with the command data only, no tools, no settings, no MCP, no saved session', async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const ask = sdkReviewerAsk({ query: () => fake([{ type: 'result', subtype: 'success', is_error: false, result: verdict('allow', 'low') }], seen), base: () => base });
    expect(await runReview(ask, REQ)).toMatchObject({ allow: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toBe(reviewerUserMessage(REQ));
    const data = JSON.parse(seen[0].prompt.split('\n').slice(1).join('\n'));
    expect(Object.keys(data).sort()).toEqual(['argv', 'command', 'sandbox', 'workingDirectory']);
    expect(data).toMatchObject({ command: 'make build', argv: [['make', 'build']], workingDirectory: "the bot's own folder" });
    const o = seen[0].options;
    expect(o).toMatchObject({
      model: BOT_COMMAND_REVIEWER_LIMITS.MODEL, maxTurns: 1, tools: [], allowedTools: [], disallowedTools: ['Agent', 'Bash'],
      settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false,
      systemPrompt: BOT_COMMAND_REVIEWER_SYSTEM_PROMPT, env: base.env, pathToClaudeCodeExecutable: '/bin/claude', cwd: '/bots/b',
    });
    expect(o.env).not.toBe(base.env);
    expect(o.hooks).toBeUndefined();
    expect(o.sandbox).toBeUndefined();
    expect(o.resume).toBeUndefined();
    expect(await (o.canUseTool as () => Promise<{ behavior: string }>)()).toMatchObject({ behavior: 'deny' });
  });

  it.each([
    ['a usage limit (an error result)', [{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }]],
    ['an error result', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'] }]],
    ['an assistant error frame', [{ type: 'assistant', error: 'rate_limit', message: { content: [] } }, { type: 'result', subtype: 'success', is_error: false, result: verdict('allow', 'low') }]],
    ['no result', [{ type: 'system', subtype: 'init' }]],
  ])('%s is reviewer_unavailable', async (_name, frames) => {
    const ask = sdkReviewerAsk({ query: () => fake(frames), base: () => base });
    expect(await runReview(ask, REQ)).toMatchObject({ allow: false, code: 'reviewer_unavailable' });
  });

  it('an SDK that throws is reviewer_unavailable', async () => {
    const ask = sdkReviewerAsk({ query: () => { throw new Error('no sdk'); }, base: () => base });
    expect(await runReview(ask, REQ)).toMatchObject({ allow: false, code: 'reviewer_unavailable' });
  });

  it('a timeout interrupts the call', async () => {
    const interrupt = vi.fn();
    const query: ReviewerQueryFn = () => ({ interrupt, [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) });
    const out = await runReview(sdkReviewerAsk({ query: () => query, base: () => base }), REQ, Date.now, 20);
    expect(out).toMatchObject({ allow: false, code: 'reviewer_unavailable' });
    expect(interrupt).toHaveBeenCalled();
  });
});

describe('BotCommandReviewer', () => {
  it('answers a repeat of a line in the same turn without asking again, in flight too', async () => {
    const ask = vi.fn(answering(verdict('allow', 'low')));
    const turn = new BotCommandReviewer('bot-a', ask);
    const [a, b] = await Promise.all([turn.review(REQ), turn.review(REQ)]);
    expect(a).toMatchObject({ allow: true });
    expect(b).toMatchObject({ allow: true, cached: true });
    expect(await turn.review(REQ)).toMatchObject({ allow: true, cached: true });
    expect(ask).toHaveBeenCalledTimes(1);
    // A refusal is kept for the turn as well.
    const deny = vi.fn(answering(verdict('deny', 'medium')));
    const t2 = new BotCommandReviewer('bot-a', deny);
    await t2.review(REQ);
    expect(await t2.review(REQ)).toMatchObject({ allow: false, code: 'reviewer_deny', cached: true });
    expect(deny).toHaveBeenCalledTimes(1);
  });

  it('the next turn asks again', async () => {
    const ask = vi.fn(answering(verdict('allow', 'low')));
    await new BotCommandReviewer('bot-a', ask).review(REQ);
    await new BotCommandReviewer('bot-a', ask).review(REQ);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('at most PER_TURN calls a turn; past it, reviewer_budget without a call', async () => {
    const ask = vi.fn(answering(verdict('allow', 'low')));
    const turn = new BotCommandReviewer('bot-a', ask);
    for (let k = 0; k < BOT_COMMAND_REVIEWER_LIMITS.PER_TURN; k++) expect(await turn.review({ command: `make t${k}`, argv: [['make', `t${k}`]] })).toMatchObject({ allow: true });
    expect(await turn.review({ command: 'make more', argv: [['make', 'more']] })).toMatchObject({ allow: false, code: 'reviewer_budget' });
    expect(ask).toHaveBeenCalledTimes(BOT_COMMAND_REVIEWER_LIMITS.PER_TURN);
    // A line already answered this turn is still answered.
    expect(await turn.review({ command: 'make t0', argv: [['make', 't0']] })).toMatchObject({ allow: true, cached: true });
  });

  it('at most PER_BOT_PER_DAY calls a bot a local day, counted per bot', async () => {
    let now = new Date(2026, 9, 21, 10).getTime();
    const ask = vi.fn(answering(verdict('allow', 'low')));
    let asked = 0;
    while (asked < BOT_COMMAND_REVIEWER_LIMITS.PER_BOT_PER_DAY) {
      const turn = new BotCommandReviewer('bot-a', ask, () => now);
      for (let k = 0; k < BOT_COMMAND_REVIEWER_LIMITS.PER_TURN && asked < BOT_COMMAND_REVIEWER_LIMITS.PER_BOT_PER_DAY; k++, asked++) await turn.review({ command: `make d${asked}`, argv: [] });
    }
    expect(ask).toHaveBeenCalledTimes(BOT_COMMAND_REVIEWER_LIMITS.PER_BOT_PER_DAY);
    expect(await new BotCommandReviewer('bot-a', ask, () => now).review(REQ)).toMatchObject({ allow: false, code: 'reviewer_budget' });
    expect(await new BotCommandReviewer('bot-b', ask, () => now).review(REQ)).toMatchObject({ allow: true });
    now = new Date(2026, 9, 22, 9).getTime();
    expect(await new BotCommandReviewer('bot-a', ask, () => now).review(REQ)).toMatchObject({ allow: true });
  });
});
