import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountRotationControls } from '../AccountRotationControls';

describe('AccountRotationControls', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows the provider-terms notice next to the two switches', () => {
    vi.stubGlobal('window', { electronAPI: { accountRotation: { get: vi.fn(), set: vi.fn() } } });
    const html = renderToStaticMarkup(createElement(AccountRotationControls, {
      state: { settings: { claude: true, codex: false }, rows: [] },
      reload: () => undefined,
    }));
    expect(html.match(/data-rotation-vendor=/g)).toHaveLength(2);
    expect(html).toContain("You are responsible for following each provider&#x27;s terms.");
  });
});
