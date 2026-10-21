// @vitest-environment jsdom
// The profile's Commands row: hidden where the bot runs no commands; the
// switch, the decisions newest first (a page at a time) with Always allow on
// a command refused as not on the list only, main's refusal shown, and the
// owner's rules with Remove.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../../Room/factoryPorts';
import type { BotCommandLogEntry, BotCommandReadResult } from '../../../../shared/botCommand';
import { BotCommands, COMMANDS_PAGE, type BotCommandPort } from '../BotCommands';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const BOT = 'bot-0000000a';
const row = { bot: { id: BOT, name: 'Dev' } } as unknown as FactoryBotRow;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setFactoryBotPort({ subscribe: () => () => undefined } as unknown as FactoryBotPort);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFactoryBotPort(null);
});

const entry = (id: string, over: Partial<BotCommandLogEntry> = {}): BotCommandLogEntry => ({ id, at: Date.now(), tool: 'Bash', decision: 'allow', layer: 'allowlist', target: `cmd-${id}`, ...over });

function fakePort(view: Partial<Extract<BotCommandReadResult, { ok: true }>> = {}): BotCommandPort & { [K in 'setEnabled' | 'allow' | 'removeRule']: ReturnType<typeof vi.fn> } {
  return {
    available: true,
    read: async () => ({ ok: true, available: true, enabled: true, entries: [], rules: [], ...view }),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    allow: vi.fn(async () => ({ ok: true as const })),
    removeRule: vi.fn(async () => ({ ok: true as const })),
  };
}

const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null;

describe('BotCommands', () => {
  it('shows nothing where the bot runs no commands', async () => {
    await act(async () => root.render(<BotCommands row={row} t={t} port={fakePort({ available: false })} />));
    expect($('[data-bots-profile-commands]')).toBeNull();
  });

  it('the switch sends the owner\'s choice', async () => {
    const port = fakePort();
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    const sw = $('[data-testid="bot-commands-switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    expect(port.setEnabled).toHaveBeenCalledWith({ botId: BOT, enabled: false });
  });

  it('lists decisions a page at a time, with Always allow on a refused unlisted command only', async () => {
    const entries = [
      entry('d1', { decision: 'deny', layer: 'unlisted', target: 'make build', reason: 'make is not on the built-in list', canAllow: true }),
      entry('d2', { decision: 'deny', layer: 'floor', target: 'sudo ls' }),
      // A built-in refused for a blocked option: main does not offer it.
      entry('d3', { decision: 'deny', layer: 'unlisted', target: 'rg --pre=x foo' }),
      ...Array.from({ length: COMMANDS_PAGE + 3 }, (_, k) => entry(`a${k}`)),
    ];
    const port = fakePort({ entries });
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    expect(host.querySelectorAll('[data-bot-command-entry]')).toHaveLength(COMMANDS_PAGE);
    expect($('[data-bot-command-entry="d1"]')?.textContent).toContain('make build');
    expect($('[data-bot-command-entry="d1"]')?.textContent).toContain('bots.commands.refused');
    expect($('[data-bot-command-entry="d1"]')?.textContent).toContain('make is not on the built-in list');
    expect($('[data-testid="bot-command-allow-d1"]')).not.toBeNull();
    expect($('[data-testid="bot-command-allow-d2"]')).toBeNull();
    expect($('[data-testid="bot-command-allow-d3"]')).toBeNull();
    expect($('[data-testid="bot-command-allow-a0"]')).toBeNull();
    await act(async () => ($('[data-testid="bot-commands-more"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('[data-bot-command-entry]')).toHaveLength(entries.length);
    expect($('[data-testid="bot-commands-more"]')).toBeNull();
    await act(async () => ($('[data-testid="bot-command-allow-d1"]') as HTMLButtonElement).click());
    expect(port.allow).toHaveBeenCalledWith({ botId: BOT, entryId: 'd1' });
  });

  it('a reviewer decision shows its risk and rationale', async () => {
    const port = fakePort({ entries: [entry('r1', { decision: 'deny', layer: 'reviewer', target: 'touch a', review: { code: 'reviewer_deny', risk: 'high', rationale: 'writes outside the task' }, canAllow: true })] });
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    const text = $('[data-bot-command-entry="r1"]')?.textContent ?? '';
    expect(text).toContain('bots.commands.layer.reviewer');
    expect(text).toContain('bots.commands.risk.high');
    expect(text).toContain('writes outside the task');
    expect($('[data-testid="bot-command-allow-r1"]')).not.toBeNull();
  });

  it('Always allow on a rule that runs code warns first and needs a second click to confirm', async () => {
    const port = fakePort({ entries: [entry('m1', { decision: 'deny', layer: 'script', target: 'make build', canAllow: true, runsCode: true })] });
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    await act(async () => ($('[data-testid="bot-command-allow-m1"]') as HTMLButtonElement).click());
    expect(port.allow).not.toHaveBeenCalled();
    expect($('[data-bot-command-confirm="m1"]')?.textContent).toContain('bots.commands.runsCodeWarning');
    await act(async () => ($('[data-testid="bot-command-allow-cancel-m1"]') as HTMLButtonElement).click());
    expect($('[data-bot-command-confirm="m1"]')).toBeNull();
    await act(async () => ($('[data-testid="bot-command-allow-m1"]') as HTMLButtonElement).click());
    await act(async () => ($('[data-testid="bot-command-allow-confirm-m1"]') as HTMLButtonElement).click());
    expect(port.allow).toHaveBeenCalledWith({ botId: BOT, entryId: 'm1', confirm: true });
  });

  it('shows main\'s refusal of Always allow', async () => {
    const port = fakePort({ entries: [entry('d1', { decision: 'deny', layer: 'unlisted', target: 'make', canAllow: true })] });
    port.allow.mockResolvedValueOnce({ ok: false, error: 'a command rule has more than 16 words' });
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    await act(async () => ($('[data-testid="bot-command-allow-d1"]') as HTMLButtonElement).click());
    expect($('[role="alert"]')?.textContent).toBe('a command rule has more than 16 words');
  });

  it('lists the owner\'s rules, each with Remove', async () => {
    const port = fakePort({ rules: [{ text: 'make', anyArgs: true }, { text: 'npm test', anyArgs: false }] });
    await act(async () => root.render(<BotCommands row={row} t={t} port={port} />));
    expect($('[data-bot-command-rule="0"]')?.textContent).toContain('bots.commands.ruleAnyArgs:{"rule":"make"}');
    expect($('[data-bot-command-rule="1"]')?.textContent).toContain('npm test');
    await act(async () => ($('[data-testid="bot-command-rule-remove-1"]') as HTMLButtonElement).click());
    expect(port.removeRule).toHaveBeenCalledWith({ botId: BOT, index: 1, text: 'npm test' });
  });
});
