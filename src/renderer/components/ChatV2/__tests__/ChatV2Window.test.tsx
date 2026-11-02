// @vitest-environment jsdom
// A long transcript mounts only its recent rows, reads earlier ones in as the
// reader scrolls up (holding their place), and find still reaches a row the
// window hides.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { TRANSCRIPT_WINDOW_SIZE } from '../../shared/transcriptWindow';
import { setChatV2BridgeForTests } from '../bridge';
import ChatV2View from '../ChatV2View';
import { createMockHost, type MockHost } from './mockHost';

vi.mock('../../../stores', () => ({ useStore: Object.assign((select: (s: unknown) => unknown) => select({ surfaceAgent: {}, agentAliveByPtyId: {}, commandRunningByPtyId: {} }), { getState: () => ({ setSurfaceViewMode: vi.fn() }) }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../../../hooks/useNotificationListener', () => ({ focusPaneByPtyId: vi.fn() }));

const ROW_PX = 20;
let root: Root;
let host: HTMLDivElement;
let mock: MockHost;
const tops = new WeakMap<Element, number>();
const restore: Array<() => void> = [];

function stub<K extends string>(proto: object, key: K, desc: PropertyDescriptor) {
  const prev = Object.getOwnPropertyDescriptor(proto, key);
  Object.defineProperty(proto, key, { configurable: true, ...desc });
  restore.push(() => (prev ? Object.defineProperty(proto, key, prev) : delete (proto as Record<string, unknown>)[key]));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Layout jsdom lacks: every row is ROW_PX tall, the viewport 400 px.
  stub(HTMLElement.prototype, 'scrollHeight', { get(this: HTMLElement) { return this.querySelectorAll('.wmux-chatv2-column > *').length * ROW_PX; } });
  stub(HTMLElement.prototype, 'clientHeight', { get: () => 400 });
  stub(HTMLElement.prototype, 'scrollTop', { get(this: HTMLElement) { return tops.get(this) ?? 0; }, set(this: HTMLElement, v: number) { tops.set(this, Math.max(0, Math.min(v, this.scrollHeight - 400))); } });
  stub(Element.prototype, 'scrollIntoView', { value: vi.fn() });
  // A row's box: its place in the column, moved by the viewport's scroll.
  stub(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      const column = this.parentElement;
      const viewport = this.closest('.wmux-chatv2-viewport') as HTMLElement | null;
      const top = column?.classList.contains('wmux-chatv2-column') && viewport ? [...column.children].indexOf(this) * ROW_PX - viewport.scrollTop : 0;
      return { top, bottom: top + ROW_PX, left: 0, right: 0, width: 0, height: ROW_PX, x: 0, y: top, toJSON: () => ({}) };
    },
  });
  if (typeof CSS === 'undefined') vi.stubGlobal('CSS', { escape: (value: string) => value });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mock = createMockHost({ windowBlocks: 100_000 });
  setChatV2BridgeForTests(mock);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setChatV2BridgeForTests(null);
  while (restore.length) restore.pop()!();
  vi.unstubAllGlobals();
});

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const rowEls = () => [...host.querySelectorAll('.wmux-chatv2-column > *')];
const viewport = () => host.querySelector('.wmux-chatv2-viewport') as HTMLElement;

/** `turns` finished turns (user, reply, footer = 3 rows each). */
async function openLong(paneId: string, turns: number) {
  await mock.call('subscribe', { paneId });
  await mock.call('create', { paneId, agent: 'claude', mode: 'default' });
  const events: HarnessEvent[] = [];
  for (let i = 0; i < turns; i++) {
    events.push(
      { type: 'user.message', text: `question ${i} end`, clientMessageId: `c-${String(i).padStart(8, '0')}` },
      { type: 'message.delta', text: `answer ${i} end` },
      { type: 'turn.ended', outcome: 'completed' },
    );
  }
  for (let i = 0; i < events.length; i += 300) mock.emit(paneId, events.slice(i, i + 300));
  await act(async () => root.render(<ChatV2View paneId={paneId} active onTerminal={() => undefined} />));
  await flush();
}

/** A long transcript with find open on a row the window hides (question 5). */
async function openFind(paneId: string) {
  await openLong(paneId, 400);
  expect(host.textContent).not.toContain('question 5 end');
  await act(async () => {
    host.querySelector('.wmux-chatv2')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  });
  const input = host.querySelector('.wmux-chatv2-find input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'question 5 end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

describe('ChatV2 transcript window', () => {
  it('mounts the tail of a long transcript and keeps following new turns', async () => {
    await openLong('win-tail', 400);
    expect(rowEls().length).toBeLessThanOrEqual(2 * TRANSCRIPT_WINDOW_SIZE);
    expect(host.textContent).toContain('question 399 end');
    expect(host.textContent).not.toContain('question 0 end');
    // At the bottom; a new turn and its streamed text are followed.
    expect(viewport().scrollTop).toBe(viewport().scrollHeight - 400);
    await act(async () => { mock.emit('win-tail', [{ type: 'user.message', text: 'newest end', clientMessageId: 'c-99999999' }, { type: 'message.delta', text: 'streaming' }]); });
    const count = rowEls().length;
    await act(async () => { mock.emit('win-tail', [{ type: 'message.delta', text: ' more' }]); });
    expect(rowEls().length).toBe(count);
    expect(host.textContent).toContain('streaming more');
    expect(viewport().scrollTop).toBe(viewport().scrollHeight - 400);
  });

  it('shows a transcript at or under the window size whole', async () => {
    await openLong('win-short', 40);
    expect(rowEls().length).toBe(120);
    expect(host.textContent).toContain('question 0 end');
  });

  it('reads earlier rows in near the top without moving the rows in view', async () => {
    await openLong('win-up', 400);
    const before = rowEls().length;
    const firstShown = rowEls()[0];
    const el = viewport();
    await act(async () => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')); });
    const added = rowEls().length - before;
    expect(added).toBe(TRANSCRIPT_WINDOW_SIZE);
    // The row that was first is where it was on screen: everything read in sits above it.
    expect(rowEls().indexOf(firstShown)).toBe(added);
    expect(el.scrollTop).toBe(100 + added * ROW_PX);
  });

  it('holds the row in view when rows stream in below while earlier ones are read in', async () => {
    await openLong('win-stream', 400);
    const el = viewport();
    const before = rowEls().length;
    await act(async () => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
      mock.emit('win-stream', [{ type: 'user.message', text: 'late end', clientMessageId: 'c-99999998' }, { type: 'message.delta', text: 'late reply' }]);
    });
    // 120 read in above, the new turn below: only the rows above move the view.
    expect(rowEls().length).toBeGreaterThan(before + TRANSCRIPT_WINDOW_SIZE);
    expect(el.scrollTop).toBe(100 + TRANSCRIPT_WINDOW_SIZE * ROW_PX);
  });

  it('finds and reveals a row the window hides', async () => {
    await openFind('win-find');
    const match = host.querySelector('[data-find-active]');
    expect(match?.textContent).toContain('question 5 end');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(rowEls().length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE + 1);
  });

  it('closing find returns a reader who was following to the tail, and follows new turns', async () => {
    await openFind('win-close');
    expect(host.textContent).not.toContain('question 399 end');
    await act(async () => { (host.querySelector('.wmux-chatv2-find input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(host.querySelector('.wmux-chatv2-find')).toBeNull();
    expect(host.textContent).toContain('question 399 end');
    expect(host.textContent).not.toContain('question 5 end');
    await act(async () => { mock.emit('win-close', [{ type: 'user.message', text: 'after find end', clientMessageId: 'c-99999997' }]); });
    expect(host.textContent).toContain('after find end');
    expect(viewport().scrollTop).toBe(viewport().scrollHeight - 400);
  });

  it('reaching the bottom of a window find cut short reads in everything after it', async () => {
    await openFind('win-cut');
    expect(host.textContent).not.toContain('question 399 end');
    const el = viewport();
    await act(async () => { el.scrollTop = el.scrollHeight - 400; el.dispatchEvent(new Event('scroll')); });
    expect(host.textContent).toContain('question 399 end');
  });
});
