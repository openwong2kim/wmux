// @vitest-environment jsdom
// The "Remember this?" card: shown from main's pending card, answered with
// Save or Discard only, and a text longer than the preview must be opened
// before Save is offered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaMemoryCard, PREVIEW_LINES, type MoaMemoryCardApi } from '../MoaMemoryCard';
import { setLocale, t } from '../../../i18n';
import type { MoaMemoryCard as CardData } from '../../../../shared/moa';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const short: CardData = {
  id: 'c1',
  kind: 'skill',
  name: 'triage-ci',
  question: 'Remember this? Moa proposes a skill: "triage-ci"',
  description: 'Triage a red CI run',
  fullText: '---\nname: triage-ci\ndescription: "Triage a red CI run"\n---\nAsk for the log first.\n',
  replaces: false,
};
const long: CardData = {
  ...short,
  id: 'c2',
  // The description fills the preview; the instruction that matters sits below it.
  fullText: `---\nname: triage-ci\ndescription: "${'x'.repeat(300)}"\n---\n${Array.from({ length: PREVIEW_LINES + 4 }, (_, i) => `line ${i}`).join('\n')}\nHIDDEN-TAIL\n`,
};

let container: HTMLDivElement;
let root: Root;
let current: CardData | null;
let listeners: Array<() => void>;
let api: MoaMemoryCardApi & { memoryResolve: ReturnType<typeof vi.fn> };

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (sel: string) => container.querySelector<HTMLElement>(sel);

beforeEach(() => {
  setLocale('en');
  current = null;
  listeners = [];
  api = {
    memoryCard: vi.fn(async () => ({ card: current })),
    memoryResolve: vi.fn(async () => {
      current = null;
      return { ok: true };
    }),
    onChanged: (cb) => {
      listeners.push(cb);
      return () => { listeners = listeners.filter((l) => l !== cb); };
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MoaMemoryCard', () => {
  it('appears when main raises a card and saves with one click', async () => {
    const pending = vi.fn();
    await act(async () => root.render(<MoaMemoryCard api={api} t={t} onPendingChange={pending} />));
    expect(q('[data-moa-memory-card]')).toBeNull();

    current = short;
    await act(async () => listeners.forEach((l) => l()));
    await flush();
    expect(q('[data-moa-memory-card]')?.textContent).toContain('Save this as a skill for next time?');
    expect(q('[data-moa-memory-text]')?.textContent).toContain('Ask for the log first.');
    // The frontmatter is Moa's, not the operator's.
    expect(q('[data-moa-memory-text]')?.textContent).not.toContain('name: triage-ci');
    expect(q('[data-moa-memory-toggle]')).toBeNull();
    expect(pending).toHaveBeenLastCalledWith(true);
    // No free-text answer on this card.
    expect(container.querySelector('input')).toBeNull();

    await act(async () => q('[data-moa-memory-save]')!.click());
    await flush();
    expect(api.memoryResolve).toHaveBeenCalledWith({ id: 'c1', answer: 'save', fullTextShown: true });
    expect(q('[data-moa-memory-card]')).toBeNull();
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it('a long text hides nothing behind Save: open it first, then Save sends fullTextShown', async () => {
    current = long;
    await act(async () => root.render(<MoaMemoryCard api={api} t={t} />));
    await flush();
    expect(q('[data-moa-memory-text]')?.textContent).not.toContain('HIDDEN-TAIL');
    expect((q('[data-moa-memory-save]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Open the full text to save it.');

    const toggle = q('[data-moa-memory-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-moa-memory-text]')?.textContent).toContain('HIDDEN-TAIL');

    const save = q('[data-moa-memory-save]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flush();
    expect(api.memoryResolve).toHaveBeenCalledWith({ id: 'c2', answer: 'save', fullTextShown: true });
  });

  it('Discard needs no full read, and a failed answer keeps the card with an alert', async () => {
    current = long;
    api.memoryResolve.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await act(async () => root.render(<MoaMemoryCard api={api} t={t} />));
    await flush();
    await act(async () => q('[data-moa-memory-discard]')!.click());
    await flush();
    expect(api.memoryResolve).toHaveBeenCalledWith({ id: 'c2', answer: 'discard', fullTextShown: false });
    expect(q('[role="alert"]')).not.toBeNull();
    expect(q('[data-moa-memory-card]')).not.toBeNull();
  });

  it('a precedent reads as one plain sentence: no frontmatter, id, kind or English boilerplate', async () => {
    current = {
      id: 'c3',
      kind: 'precedent',
      name: '97c3423382b5',
      question: 'Remember this answer as a precedent for next time?',
      description: 'math.js를 직접 볼 수 없습니다. 완료로 처리할까요?',
      fullText: [
        '---', 'name: 97c3423382b5', 'description: "math.js를 직접 볼 수 없습니다. 완료로 처리할까요?"', 'kind: precedent', '---',
        'A past answer, not a rule: if the situation differs, ask again.', '',
        'Question: math.js를 직접 볼 수 없습니다. 완료로 처리할까요?', 'Answer: 완료로 처리', 'Answered: 2026-10-05T12:00:00.000Z', 'Source task: none', '',
      ].join('\n'),
      replaces: false,
    };
    await act(async () => root.render(<MoaMemoryCard api={api} t={t} />));
    await flush();
    const text = q('[data-moa-memory-card]')!.textContent!;
    expect(text).toContain('Remember your answer for next time?');
    expect(q('[data-moa-memory-rule]')!.textContent).toBe('Next time Moa would ask “math.js를 직접 볼 수 없습니다. 완료로 처리할까요?”, it can go with “완료로 처리”.');
    for (const raw of ['---', '97c3423382b5', 'kind:', 'precedent', 'A past answer', 'Answered:', 'Source task']) expect(text).not.toContain(raw);
    expect(q('[data-moa-memory-text]')).toBeNull();
    expect(q('[data-moa-memory-discard]')!.textContent).toBe('Not now');
    await act(async () => q('[data-moa-memory-save]')!.click());
    await flush();
    expect(api.memoryResolve).toHaveBeenCalledWith({ id: 'c3', answer: 'save', fullTextShown: true });
  });

  it('in Korean, the card speaks Korean', async () => {
    setLocale('ko');
    current = { ...short, kind: 'precedent', fullText: '---\nname: x\nkind: precedent\n---\nQuestion: 진행할까요?\nAnswer: 네\n' };
    await act(async () => root.render(<MoaMemoryCard api={api} t={t} />));
    await flush();
    expect(q('[data-moa-memory-card]')!.textContent).toContain('이 답을 다음에도 쓸까요?');
    expect(q('[data-moa-memory-rule]')!.textContent).toContain('“네”');
    expect(q('[data-moa-memory-discard]')!.textContent).toBe('나중에');
  });
});
