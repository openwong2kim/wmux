// @vitest-environment jsdom
//
// Settings › Claude Code › Shared MCP process: three choices, saved through
// main; the environment variable's override and a pending restart are said on
// the row; a failed save says so.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROKER_ROW_REFRESH_MS, BrokerSettingRow } from '../BrokerSettingRow';
import type { BrokerSetting, BrokerSettingPayload } from '../../../../shared/mcpBroker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let setBrokerSetting: ReturnType<typeof vi.fn>;
let api: Record<string, unknown> | undefined;

const payload = (p: Partial<BrokerSettingPayload> = {}): BrokerSettingPayload => ({
  saved: 'default',
  env: 'unset',
  running: { on: false, source: 'default' },
  next: { on: false, source: 'default' },
  platformDefaultOn: false,
  hostsSessions: true,
  ...p,
});

function stub(initial: BrokerSettingPayload, set: (s: BrokerSetting) => Promise<BrokerSettingPayload>) {
  setBrokerSetting = vi.fn(set);
  api = { brokerSetting: vi.fn(async () => initial), setBrokerSetting };
}
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function render() {
  await act(async () => root.render(<BrokerSettingRow api={api} />));
  await settle();
}
const radio = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === label) ?? null;
const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
beforeEach(() => { api = undefined; });
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('BrokerSettingRow', () => {
  it('shows the three choices with Default naming the platform default, and the saved one selected', async () => {
    stub(payload(), async (s) => payload({ saved: s }));
    await render();
    expect([...container.querySelectorAll('[role=radio]')].map((b) => b.textContent)).toEqual(['Default (off)', 'On', 'Off']);
    expect(radio('Default (off)')?.getAttribute('aria-checked')).toBe('true');
  });

  it('saves a choice and says it applies when wmux restarts', async () => {
    stub(payload(), async (s) => payload({ saved: s, next: { on: s === 'on', source: 'setting' } }));
    await render();
    await act(async () => { radio('On')!.click(); });
    await settle();
    expect(setBrokerSetting).toHaveBeenCalledWith('on');
    expect(radio('On')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-testid=settings-mcp-broker-restart]')?.textContent).toBe('Turns on when wmux restarts.');
  });

  it('says when WMUX_MCP_BROKER decides it, instead of a restart line', async () => {
    stub(payload({ saved: 'off', env: 'on', running: { on: true, source: 'env' }, next: { on: true, source: 'env' } }), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-env]')?.textContent).toBe(
      'WMUX_MCP_BROKER=1 is set for the app and decides this: on.',
    );
    expect(container.querySelector('[data-testid=settings-mcp-broker-restart]')).toBeNull();
  });

  it('names the WMUX_MCP_BROKER value as set', async () => {
    stub(payload({ env: 'off', envValue: 'off', running: { on: false, source: 'env' }, next: { on: false, source: 'env' } }), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-env]')?.textContent).toBe(
      'WMUX_MCP_BROKER=off is set for the app and decides this: off.',
    );
  });

  it('says when the app stopped the broker for its peer self-check', async () => {
    stub(payload({ peerUnavailable: true }), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-peer]')?.textContent).toBe(
      'wmux could not confirm which process connects to the shared process on this system, so it is stopped until wmux restarts. Each agent uses its own MCP server.',
    );
  });

  it('shows the stop note when the broker stops while the row is open, then stops re-reading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const on = { running: { on: true, source: 'default' as const }, next: { on: true, source: 'default' as const } };
      const read = vi.fn<() => Promise<BrokerSettingPayload>>()
        .mockResolvedValueOnce(payload(on))
        .mockResolvedValue(payload({ ...on, peerUnavailable: true }));
      api = { brokerSetting: read, setBrokerSetting: vi.fn() };
      await render();
      expect(container.querySelector('[data-testid=settings-mcp-broker-peer]')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(BROKER_ROW_REFRESH_MS); });
      await settle();
      expect(container.querySelector('[data-testid=settings-mcp-broker-peer]')).not.toBeNull();
      await act(async () => { vi.advanceTimersByTime(BROKER_ROW_REFRESH_MS * 3); });
      await settle();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-read while the broker is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      stub(payload(), async () => payload());
      await render();
      await act(async () => { vi.advanceTimersByTime(BROKER_ROW_REFRESH_MS * 3); });
      expect(api?.brokerSetting).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a failed save, and keeps the last saved choice', async () => {
    stub(payload({ saved: 'off' }), async () => { throw new Error('EACCES'); });
    await render();
    await act(async () => { radio('On')!.click(); });
    await settle();
    expect(text()).toContain('The choice was not saved.');
    expect(radio('Off')?.getAttribute('aria-checked')).toBe('true');
  });

  it('says when the saved file could not be used', async () => {
    stub(payload({ problem: 'mcp-broker.json: not valid JSON' }), async () => payload());
    await render();
    expect(text()).toContain('The saved choice could not be read, so the default applies.');
  });

  it('leaves the file note out while WMUX_MCP_BROKER decides', async () => {
    stub(payload({ problem: 'mcp-broker.json: not valid JSON', env: 'on', running: { on: true, source: 'env' }, next: { on: true, source: 'env' } }), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-env]')).not.toBeNull();
    expect(text()).not.toContain('The saved choice could not be read');
  });

  it('says where the shared process hosts no agents yet (Windows), and only there', async () => {
    stub(payload({ hostsSessions: false }), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-idle]')?.textContent).toBe(
      'On Windows the shared process does not host agents yet: each agent keeps its own MCP server, so On only adds an idle process.',
    );
    act(() => root.unmount());
    root = createRoot(container);
    stub(payload(), async () => payload());
    await render();
    expect(container.querySelector('[data-testid=settings-mcp-broker-idle]')).toBeNull();
  });

  it('renders nothing on an app without the channel', async () => {
    api = {};
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('keeps the row, and says so, when the choice cannot be read', async () => {
    api = { brokerSetting: vi.fn(async () => { throw new Error('ipc'); }), setBrokerSetting: vi.fn() };
    await render();
    expect(container.querySelector('[data-setting-id=mcpbroker]')).not.toBeNull();
    expect(text()).toContain('The current choice could not be read from wmux.');
  });
});
