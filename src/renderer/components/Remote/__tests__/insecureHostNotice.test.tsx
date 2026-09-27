// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import RemoteRepairNotice from '../RemoteRepairNotice';
import { classifyResizeRefusal } from '../mirrorFit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => createRoot(container).render(ui));
  return container;
}

describe('needs-HTTPS host surfaces', () => {
  it('the notice says what to do and offers no same-address "Pair again"', () => {
    const c = render(<RemoteRepairNotice insecure hostLabel="lan-mac" onRepair={vi.fn()} />);
    expect(c.textContent).toContain('lan-mac needs HTTPS — re-pair over HTTPS');
    expect(c.textContent).toContain('pair again from Remote → Other computers with an HTTPS link');
    expect(c.querySelector('button')).toBeNull();
  });

  it('the rejected-credential notice is unchanged', () => {
    const c = render(<RemoteRepairNotice hostLabel="mac" onRepair={vi.fn()} />);
    expect(c.querySelector('button')?.textContent).toBe('Pair again');
  });

  it('a refused resize is final, never retried', () => {
    expect(classifyResizeRefusal('insecure-transport')).toBe('final');
  });
});
