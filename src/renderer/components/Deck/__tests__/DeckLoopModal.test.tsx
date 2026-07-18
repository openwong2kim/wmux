// @vitest-environment jsdom
// DeckLoopModal — steps 편집기·스킬 자동완성·START 페이로드 (jsdom + fake api).
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

describe('filterSkillSuggestions — "/" 프리픽스 자동완성(순수)', () => {
  it('"/"로 시작할 때만, 부분일치 필터', () => {
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
          cwd: 'D:/proj',
          onClose: () => {},
          onStarted: () => {},
          ...over,
        }),
      );
    });
  }

  it('steps 추가·스킬 제안 선택·START 페이로드에 steps/taskTexts가 실린다', async () => {
    const api = fakeApi();
    await mount(api);
    // objective.
    setValue(container.querySelector('[data-deck-loop-objective-input]') as HTMLInputElement, 'keep CI green');
    // step 추가 → "/q" 타이핑 → 제안 노출 → 첫 제안 선택.
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
    // 두 번째 step은 자유 텍스트.
    await act(async () => {
      (container.querySelector('[data-deck-loop-step-add]') as HTMLButtonElement).click();
    });
    const steps = container.querySelectorAll('[data-deck-loop-step]');
    await act(async () => {
      setValue(steps[1] as HTMLInputElement, '실패 수정');
    });
    // done-when 두 줄.
    setValue(container.querySelector('[data-deck-loop-donewhen]') as HTMLTextAreaElement, 'tests pass\nlint clean');
    await act(async () => {
      (container.querySelector('[data-deck-loop-start]') as HTMLButtonElement).click();
    });
    expect(api.started).toHaveLength(1);
    expect(api.started[0]).toMatchObject({
      workspaceId: 'ws-1',
      objective: 'keep CI green',
      steps: ['/qa', '실패 수정'],
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

  it('objective 없이 START → 에러 표시, api 미호출', async () => {
    const api = fakeApi();
    await mount(api);
    await act(async () => {
      (container.querySelector('[data-deck-loop-start]') as HTMLButtonElement).click();
    });
    expect(api.started).toHaveLength(0);
    expect(container.querySelector('[data-deck-loop-error]')).not.toBeNull();
  });

  it('skills API 없는 구 preload에서도 렌더·START 동작(제안만 없음)', async () => {
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
