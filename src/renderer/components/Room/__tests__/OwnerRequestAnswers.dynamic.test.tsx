// @vitest-environment jsdom
// A bot's key request answered by the owner: the card's Enter key opens a
// dialog naming the bot and the exact env name, the bot's words as plain
// text; the value goes to main once and is not kept or echoed. Settings ›
// Bots lists names and use, never values.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../factoryPorts';
import { setBotSecretPort, type BotSecretPort } from '../botSecrets';
import { OwnerRequestAnswers, isOwnerRequestCard } from '../OwnerRequestAnswers';
import { BotSecretsSection } from '../../Settings/BotSecretsSection';
import { awaitsApproval } from '../../Bots/botsModel';
import type { RoomCard } from '../../../../shared/room';
import type { BotProfile } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VALUE = 'npm_RendererSideValue0123';
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

const bot: BotProfile = {
  version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'lead', name: 'Wmux Dev', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
};
const botPort: FactoryBotPort = {
  available: true,
  list: async () => [{ bot, status: null } as FactoryBotRow],
  subscribe: () => () => undefined,
  act: async () => ({ ok: true }),
};

const card: RoomCard = {
  version: 1, id: 'c-1', seq: 1, workspaceId: 'ws-1', threadId: 'general', kind: 'secret_request', at: 1,
  actor: { kind: 'bot', workspaceId: 'ws-1', botId: bot.id },
  title: 'npm publish token',
  body: 'to publish **v2** <img src=x onerror=alert(1)>',
  refs: { secretName: 'NPM_TOKEN' },
  state: 'open',
};

let container: HTMLDivElement;
let root: Root;
let sent: unknown[];
let replies: unknown[];

const secretPort: BotSecretPort = {
  available: true,
  list: async () => {
    const r = { ok: true as const, secrets: [{ name: 'NPM_TOKEN', createdAt: 1, updatedAt: 1, usable: true, lastUsed: { botId: bot.id, at: 1 } }] };
    replies.push(r);
    return r;
  },
  set: async (req) => {
    sent.push(req);
    const r = { ok: true as const, entry: { name: req.name, createdAt: 1, updatedAt: 1 } };
    replies.push(r);
    return r;
  },
  delete: async () => ({ ok: true }),
  login: async () => ({ ok: true as const, service: 'github' as const, signedIn: false }),
};

beforeEach(() => {
  sent = [];
  replies = [];
  setFactoryBotPort(botPort);
  setBotSecretPort(secretPort);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setFactoryBotPort(null);
  setBotSecretPort(null);
});

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('OwnerRequestAnswers', () => {
  it('an open request waits on the owner; an answered one shows nothing', () => {
    expect(isOwnerRequestCard(card)).toBe(true);
    expect(awaitsApproval(card, new Set())).toBe(true);
    expect(isOwnerRequestCard({ ...card, state: 'resolved' })).toBe(false);
    act(() => root.render(<OwnerRequestAnswers card={{ ...card, state: 'resolved' }} t={t} />));
    expect(container.innerHTML).toBe('');
  });

  it('Enter key → dialog with the bot and env name, the bot\'s words as plain text; the value is sent once and cleared', async () => {
    act(() => root.render(<OwnerRequestAnswers card={card} t={t} />));
    await act(async () => {
      (container.querySelector('[data-testid="secret-request-enter"]') as HTMLButtonElement).click();
    });
    await flush();
    const dialog = document.querySelector('[data-testid="secret-request-dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Wmux Dev');
    expect(dialog.textContent).toContain('NPM_TOKEN');
    // Plain text: no markup is made from the bot's words.
    expect(dialog.textContent).toContain('to publish **v2** <img src=x onerror=alert(1)>');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('strong')).toBeNull();
    const input = dialog.querySelector('[data-testid="secret-request-value"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    const save = dialog.querySelector('[data-testid="secret-request-save"]') as HTMLButtonElement;
    act(() => setInput(input, 'short'));
    expect(save.disabled).toBe(true);
    act(() => setInput(input, VALUE));
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    await flush();
    expect(sent).toEqual([{ name: 'NPM_TOKEN', value: VALUE, workspaceId: 'ws-1', cardId: 'c-1' }]);
    // The dialog is gone and nothing on the page or in main's answers holds it.
    expect(document.querySelector('[data-testid="secret-request-dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(JSON.stringify(replies)).not.toContain(VALUE);
  });

  it('Settings › Bots lists names and use, never a value', async () => {
    act(() => root.render(<BotSecretsSection t={t} port={secretPort} now={2} />));
    await flush();
    const row = container.querySelector('[data-factory-key="NPM_TOKEN"]') as HTMLElement;
    expect(row.textContent).toContain('NPM_TOKEN');
    expect(row.textContent).toContain('Wmux Dev');
    expect(container.innerHTML).not.toContain(VALUE);
    // Its Delete button is named for the key it deletes.
    const del = container.querySelector('[data-testid="factory-key-delete-NPM_TOKEN"]') as HTMLButtonElement;
    expect(del.getAttribute('aria-label')).toBe('settings.factory.keyDeleteNamed:{"name":"NPM_TOKEN"}');
  });
});
