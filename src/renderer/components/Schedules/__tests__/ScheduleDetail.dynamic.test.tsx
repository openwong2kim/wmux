// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import ScheduleDetail from '../ScheduleDetail';
import { automation, run } from './fixtures';

let container: HTMLDivElement;
let root: Root;
const snapshot = vi.fn(async () => ({ text: 'status: someone@example.com' }));

beforeEach(() => {
  snapshot.mockClear();
  vi.stubGlobal('electronAPI', { automation: { snapshot } });
  useStore.setState({
    automations: [automation()],
    automationRuns: [run({ id: 'r1', state: 'completed', hasSnapshot: true, startedAt: 1, endedAt: 2 })],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ScheduleDetail output snapshot', () => {
  it('keeps a finished run\'s output collapsed until asked for', async () => {
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-run-output]')).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('example.com');
    const toggle = container.querySelector<HTMLButtonElement>('[data-run-output-toggle]')!;
    expect(toggle.textContent).toBe('Show output');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(container.querySelector('[data-run-output]')!.textContent).toContain('example.com');
    expect(toggle.textContent).toBe('Hide output');
  });
});
