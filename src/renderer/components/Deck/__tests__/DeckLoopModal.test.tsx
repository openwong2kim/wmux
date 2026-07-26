// @vitest-environment jsdom
// DeckLoopModal — steps editor·skill autocomplete·START payload (jsdom + fake api).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckLoopModal, filterSkillSuggestions } from '../DeckLoopModal';
import type { DeckLoopApi } from '../DeckLoopPanel';
import type { SkillCatalogEntry } from '../../../../main/deck/skillCatalogScan';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const CATALOG: SkillCatalogEntry[] = [
  { name: 'qa', description: 'test the site', source: 'project', kind: 'skill' },
  { name: 'qa-only', description: 'report only', source: 'project', kind: 'skill' },
  { name: 'review', description: 'code review', source: 'user', kind: 'command' },
];

function fakeApi(): DeckLoopApi & { started: unknown[] } {
  const started: unknown[] = [];
  return {
    started,
    get: async () => ({ loop: null, wakeBudget: null }),
    setTask: async () => ({ ok: true }),
    start: async (args) => {
      started.push(args);
      return { ok: true };
    },
    stop: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    skills: async () => ({ skills: CATALOG }),
  };
}

function fakeModeApi(mode: 'off' | 'assist' | 'auto') {
  return { get: async () => ({ mode }), set: async () => ({ ok: true, mode }) };
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('filterSkillSuggestions — "/" prefix autocomplete (pure)', () => {
  it('only when starting with "/", partial-match filter', () => {
    expect(filterSkillSuggestions(CATALOG, 'qa')).toEqual([]);
    expect(filterSkillSuggestions(CATALOG, '/qa').map((s) => s.name)).toEqual(['qa', 'qa-only']);
    expect(filterSkillSuggestions(CATALOG, '/rev').map((s) => s.name)).toEqual(['review']);
    expect(filterSkillSuggestions(CATALOG, '/')).toHaveLength(3);
    expect(filterSkillSuggestions(CATALOG, '/zzz')).toEqual([]);
  });
});

describe('DeckLoopModal', () => {
  async function mount(api: DeckLoopApi, over: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        createElement(DeckLoopModal, {
          api,
          workspaceId: 'ws-1',
          location: { domain: 'host' as const, cwd: 'D:/proj', shell: 'pwsh.exe' },
          onClose: () => {},
          onStarted: () => {},
          ...over,
        }),
      );
    });
  }

  it('passes the authoritative WSL location to skill discovery', async () => {
    const api = fakeApi();
    const skills = vi.fn(async () => ({ skills: CATALOG }));
    api.skills = skills;
    const location = {
      domain: 'wsl' as const,
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };

    await mount(api, { location });

    expect(skills).toHaveBeenCalledWith(location);
  });

  // A bare cwd carries no shell, so nothing can tell a WSL `/home/me/proj`
  // from a host path. Fabricating `{ domain: 'host' }` there is what makes
  // Windows resolve a guest path as `C:\home\me\proj` (issue #21 AC 6), so the
  // modal scans nothing rather than scanning the wrong domain.
  it('never fabricates a location from a bare cwd', async () => {
    const api = fakeApi();
    const skills = vi.fn(async () => ({ skills: CATALOG }));
    api.skills = skills;

    await mount(api, { location: undefined, cwd: '/home/me/proj' });

    expect(skills).not.toHaveBeenCalled();
  });

  it('add steps·select skill suggestion·START payload carries steps/taskTexts', async () => {
    const api = fakeApi();
    await mount(api);
    // objective.
    setValue(container.querySelector('[data-deck-loop-objective-input]') as HTMLInputElement, 'keep CI green');
    // Add step → type "/q" → show suggestions → select first suggestion.
    await act(async () => {
      (container.querySelector('[data-deck-loop-step-add]') as HTMLButtonElement).click();
    });
    const stepInput = container.querySelector('[data-deck-loop-step]') as HTMLInputElement;
    await act(async () => {
      stepInput.focus();
      setValue(stepInput, '/q');
    });
    const suggest = container.querySelectorAll('[data-deck-loop-skill-suggest] button');
    expect(suggest.length).toBe(2); // qa, qa-only.
    expect(suggest[0].textContent).toContain('/qa');
    await act(async () => {
      suggest[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect((container.querySelector('[data-deck-loop-step]') as HTMLInputElement).value).toBe('/qa');
    // Second step is free text.
    await act(async () => {
      (container.querySelector('[data-deck-loop-step-add]') as HTMLButtonElement).click();
    });
    const steps = container.querySelectorAll('[data-deck-loop-step]');
    await act(async () => {
      setValue(steps[1] as HTMLInputElement, 'fix failure');
    });
    // Two done-when lines.
    setValue(container.querySelector('[data-deck-loop-donewhen]') as HTMLTextAreaElement, 'tests pass\nlint clean');
    await act(async () => {
      (container.querySelector('[data-deck-loop-start]') as HTMLButtonElement).click();
    });
    expect(api.started).toHaveLength(1);
    expect(api.started[0]).toMatchObject({
      workspaceId: 'ws-1',
      objective: 'keep CI green',
      steps: ['/qa', 'fix failure'],
      taskTexts: ['tests pass', 'lint clean'],
      tier: 'continue', // default is now `continue` (report read as inert on first use)
      iterations: 25,
    });
  });

  describe('effective-authority preview (mode↔loop dependency made visible)', () => {
    const flush = async () => { await act(async () => { await Promise.resolve(); }); };

    it('auto + default continue → drive ON, press ON (the unattended supervisor)', async () => {
      const api = fakeApi();
      await mount(api, { modeApi: fakeModeApi('auto') });
      await flush();
      const box = container.querySelector('[data-deck-loop-authority]');
      expect(box).not.toBeNull();
      expect(box!.getAttribute('data-mode')).toBe('auto');
      expect(container.querySelector('[data-deck-loop-auth-drive="on"]')).not.toBeNull();
      expect(container.querySelector('[data-deck-loop-auth-press="on"]')).not.toBeNull();
    });

    it('assist + continue → drive ON, press OFF, with a raise-to-Auto hint', async () => {
      const api = fakeApi();
      await mount(api, { modeApi: fakeModeApi('assist') });
      await flush();
      expect(container.querySelector('[data-deck-loop-auth-drive="on"]')).not.toBeNull();
      expect(container.querySelector('[data-deck-loop-auth-press="off"]')).not.toBeNull();
      // The hint tells the user where the press capability actually lives.
      expect(container.querySelector('[data-deck-loop-authority]')!.textContent).toContain('Auto');
    });

    it('off → both OFF, with the kill-switch warning', async () => {
      const api = fakeApi();
      await mount(api, { modeApi: fakeModeApi('off') });
      await flush();
      expect(container.querySelector('[data-deck-loop-auth-drive="off"]')).not.toBeNull();
      expect(container.querySelector('[data-deck-loop-auth-press="off"]')).not.toBeNull();
      expect(container.querySelector('[data-deck-loop-authority]')!.textContent).toContain('Off');
    });

    it('no modeApi (older preload / pure parent) → no preview at all', async () => {
      const api = fakeApi();
      await mount(api);
      await flush();
      expect(container.querySelector('[data-deck-loop-authority]')).toBeNull();
    });
  });

  it('START without objective → error shown, api not called', async () => {
    const api = fakeApi();
    await mount(api);
    await act(async () => {
      (container.querySelector('[data-deck-loop-start]') as HTMLButtonElement).click();
    });
    expect(api.started).toHaveLength(0);
    expect(container.querySelector('[data-deck-loop-error]')).not.toBeNull();
  });

  it('renders and START works on legacy preload without skills API (no suggestions only)', async () => {
    const api = fakeApi();
    delete (api as { skills?: unknown }).skills;
    await mount(api);
    setValue(container.querySelector('[data-deck-loop-objective-input]') as HTMLInputElement, 'o');
    await act(async () => {
      (container.querySelector('[data-deck-loop-start]') as HTMLButtonElement).click();
    });
    expect(api.started).toHaveLength(1);
  });
});
