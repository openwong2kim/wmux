import { describe, expect, it } from 'vitest';
import {
  BotPromptPushRouter,
  botPromptPushCollapseId,
  buildBotPromptPushPayload,
} from '../botPromptPush';
import { parseBotPromptPushRows } from '../../../shared/botPromptPush';
import type { PushPayload } from '../../../shared/push/pushEnvelope';

const base = { workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', botName: 'Scout' };

describe('buildBotPromptPushPayload', () => {
  it('★ names the card by botPromptId, never approvalId, with a structured summary per kind', () => {
    const [question, login, site] = parseBotPromptPushRows([
      { ...base, cardId: 'c-q1', promptKind: 'question' },
      { ...base, cardId: 'c-l1', promptKind: 'login_request', loginService: 'github' },
      { ...base, cardId: 'c-l2', promptKind: 'login_request', loginService: 'website', url: 'https://pay-now.example/' },
    ]) ?? [];
    const payload = buildBotPromptPushPayload(question);
    expect(payload).toEqual({
      title: 'Scout needs you',
      body: 'Has a question for you',
      approvalKind: 'bot_prompt',
      promptKind: 'question',
      botPromptId: 'c-q1',
      workspaceId: 'ws-1',
      threadId: 'general',
      botId: 'bot-1',
      requiresInAppChoice: true,
    });
    expect('approvalId' in payload).toBe(false);
    expect(buildBotPromptPushPayload(login).body).toBe('Asks you to sign in to GitHub');
    // A website's URL is the bot's to choose: it stays on the card.
    expect(JSON.stringify(buildBotPromptPushPayload(site))).not.toContain('pay-now');
    expect(botPromptPushCollapseId('c-q1')).toBe('botprompt-c-q1');
  });

  it('★ a secret_request carries the secret\'s name only, never a value', () => {
    const rows = parseBotPromptPushRows([
      { ...base, cardId: 'c-s1', promptKind: 'secret_request', secretName: 'NPM_TOKEN', value: 'npm_s3cr3t-value', secret: 'npm_s3cr3t-value' },
    ]) ?? [];
    expect(rows).toEqual([{ ...base, cardId: 'c-s1', promptKind: 'secret_request', secretName: 'NPM_TOKEN' }]);
    const payload = buildBotPromptPushPayload(rows[0]);
    expect(payload.body).toBe('Asks for the secret NPM_TOKEN');
    expect(JSON.stringify(payload)).not.toContain('s3cr3t');
    // A name that is not a secret's env name is not a row at all.
    expect(parseBotPromptPushRows([{ ...base, cardId: 'c-s2', promptKind: 'secret_request', secretName: 'npm_s3cr3t-value' }])).toEqual([]);
  });
});

describe('BotPromptPushRouter', () => {
  it('retracts a card that closed, under its collapse id, to botPromptPush devices', () => {
    const sent: Array<{ payload: PushPayload; opts: { collapseId: string; requires: string } }> = [];
    const router = new BotPromptPushRouter({
      suppress: () => false,
      send: (payload, opts) => sent.push({ payload, opts }),
      park: () => undefined,
      forget: () => undefined,
    });
    const rows = parseBotPromptPushRows([{ ...base, cardId: 'c-q1', promptKind: 'question' }]) ?? [];
    router.set(rows);
    router.set([]);
    expect(sent.map((s) => s.opts)).toEqual([
      { collapseId: 'botprompt-c-q1', requires: 'botPromptPush' },
      { collapseId: 'botprompt-c-q1', requires: 'botPromptPush' },
    ]);
    expect(sent[1].payload).toMatchObject({ kind: 'approval_retraction', retractsBotPromptId: 'c-q1' });
    expect('botPromptId' in sent[1].payload).toBe(false);
  });
});
