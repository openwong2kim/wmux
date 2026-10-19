// @vitest-environment jsdom
// The profile's Skills row: Archive sends one request at a time, however
// fast it is clicked, and its buttons wait for the answer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { setFactoryBotPort, type FactoryBotPort } from '../../Room/factoryPorts';
import type { SkillArchiveResult } from '../../../../shared/botSkill';
import { BotSkills, type BotSkillPort } from '../BotSkills';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => key;
const row = { bot: { id: 'bot-0000000a', name: 'Dev' } } as unknown as FactoryBotRow;

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

describe('BotSkills', () => {
  it('a double click on Archive sends one request and the buttons wait for it', async () => {
    let answer: (r: SkillArchiveResult) => void = () => undefined;
    const archive = vi.fn(() => new Promise<SkillArchiveResult>((resolve) => { answer = resolve; }));
    const port: BotSkillPort = {
      available: true,
      list: async () => ({
        ok: true,
        skills: [
          { name: 'report', state: 'approved', version: '1.0.0', description: 'd', updatedAt: 1 },
          { name: 'triage', state: 'approved', version: '1.0.0', description: 'd', updatedAt: 1 },
        ],
      }),
      archive,
    };
    await act(async () => root.render(<BotSkills row={row} t={t} port={port} />));
    const button = host.querySelector('[data-testid="bot-skill-archive-report"]') as HTMLButtonElement;
    act(() => {
      button.click();
      button.click();
    });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect((host.querySelector('[data-testid="bot-skill-archive-triage"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ ok: true, skill: { name: 'report', state: 'archived', updatedAt: 2 } }));
    expect(button.disabled).toBe(false);
    expect(host.textContent).not.toContain('skillArchiveFailed');
  });
});
