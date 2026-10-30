// @vitest-environment jsdom
// The window keeps the rows a reader scrolled up to when rows land above them
// mid-list (the bot chat inserts workflow cards and day dividers into its
// timeline after a read), not only before the first row.
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTranscriptWindow } from '../useTranscriptWindow';

let root: Root;
let host: HTMLDivElement;
const tops = new WeakMap<Element, number>();
let restoreTop: () => void;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, v: number) { tops.set(this, v); } });
  restoreTop = () => Object.defineProperty(Element.prototype, 'scrollTop', prev);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restoreTop();
  vi.unstubAllGlobals();
});

let api: ReturnType<typeof useTranscriptWindow<string>> | null = null;
function List({ items }: { items: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  api = useTranscriptWindow({ resetKey: 'chat', items, keyOf: (item) => item, isTurnStart: () => false, scrollRef });
  return <div ref={scrollRef} data-scroller><div>{api.visible.map((item) => <p key={item}>{item}</p>)}</div></div>;
}

it('keeps the first row in view when rows are inserted above the window', async () => {
  const items = Array.from({ length: 300 }, (_, i) => `r${i}`);
  await act(async () => root.render(<List items={items} />));
  expect(api!.visible[0]).toBe('r180');
  // The reader scrolls up a little: the window stops following.
  const scroller = host.querySelector('[data-scroller]') as HTMLElement;
  await act(async () => { scroller.scrollTop = 1000; api!.onScroll(false); });
  await act(async () => { scroller.scrollTop = 900; api!.onScroll(false); });
  // A card and a divider land mid-timeline, above the window; the first row stays r180.
  const inserted = [...items.slice(0, 50), 'workflow', 'day', ...items.slice(50)];
  await act(async () => root.render(<List items={inserted} />));
  expect(api!.visible[0]).toBe('r180');
  expect(api!.visible.at(-1)).toBe('r299');
  expect(host.querySelector('p')?.textContent).toBe('r180');
});
