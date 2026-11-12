// @vitest-environment jsdom
//
// Settings › LAN, starting new agents from another PC: hidden while the
// feature flag is off; with it on, it starts from the saved (default-off)
// policy, saves the edited draft as a whole, shows the daemon's reason for a
// refused save, and never takes bypass permissions without a confirm.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSpawnPolicy, type A2aSpawnPolicyV1 } from '../../../../shared/a2aSpawn';
import { RemoteSpawnSection } from '../RemoteSpawnSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let spawnPolicySet: ReturnType<typeof vi.fn>;

function stub(set: (p: A2aSpawnPolicyV1) => unknown = (p) => ({ ok: true, policy: { ...p, version: p.version + 1 } }), stored: unknown = defaultSpawnPolicy()) {
  spawnPolicySet = vi.fn(async (p: A2aSpawnPolicyV1) => set(p));
  vi.stubGlobal('electronAPI', {
    a2aRemote: {
      spawnPolicyGet: vi.fn(async () => ({ policy: stored })),
      spawnPolicySet,
    },
  });
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
  await settle();
}
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error('missing element');
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
};
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('RemoteSpawnSection', () => {
  it('renders nothing while the flag is off, and reads nothing', async () => {
    stub();
    await render(<RemoteSpawnSection enabled={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('starts off from the default policy and saves the edited draft through spawnPolicySet', async () => {
    stub();
    const pickFolder = vi.fn(async () => '/Users/me/code/My API');
    await render(<RemoteSpawnSection enabled pickFolder={pickFolder} />);
    const master = $('[data-testid="remote-spawn-enabled"]')!;
    expect(master.getAttribute('aria-checked')).toBe('false');
    // Off: only the switch, and nothing to save yet.
    expect($('[data-testid="remote-spawn-mode"]')).toBeNull();
    expect($<HTMLButtonElement>('[data-testid="remote-spawn-save"]')!.disabled).toBe(true);

    await click(master);
    expect($<HTMLSelectElement>('select[data-testid="remote-spawn-mode"]')!.value).toBe('auto');
    expect(container.textContent).toContain('Allowing a PC lets it run an agent as you in these folders.');
    await click($('[data-testid="remote-spawn-add-folder"]'));
    await click($('[data-remote-spawn-agent="claude"]'));
    await click($('[data-testid="remote-spawn-save"]'));

    expect(spawnPolicySet).toHaveBeenCalledTimes(1);
    expect(spawnPolicySet.mock.calls[0][0]).toEqual({
      ...defaultSpawnPolicy(),
      enabled: true,
      roots: [{ id: expect.stringMatching(/^my-api-[a-z0-9]{6}$/), label: 'My API', path: '/Users/me/code/My API' }],
      agents: ['claude'],
    });
    expect(container.textContent).toContain('Saved');
    expect($<HTMLButtonElement>('[data-testid="remote-spawn-save"]')!.disabled).toBe(true);
  });

  it('shows each limit empty (no limit; open requests 100) and saves only the ones set', async () => {
    stub(undefined, { ...defaultSpawnPolicy(), enabled: true });
    await render(<RemoteSpawnSection enabled />);
    const field = (key: string) => $<HTMLInputElement>(`[data-testid="remote-spawn-limit-${key}"]`)!;
    for (const key of ['livePerPc', 'liveTotal', 'startsPerHour', 'startsPerDay']) {
      expect(field(key).value).toBe('');
      expect(field(key).placeholder).toBe('No limit');
    }
    expect(field('pendingPerPc').placeholder).toBe('100 (default)');
    const type = async (key: string, text: string) => {
      const el = field(key);
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      await settle();
    };
    await type('startsPerHour', '3');
    await type('pendingPerPc', '2000'); // past the store size: back to empty
    expect(field('pendingPerPc').value).toBe('');
    await click($('[data-testid="remote-spawn-save"]'));
    expect(spawnPolicySet.mock.calls.at(-1)![0].limits).toEqual({ startsPerHour: 3 });
    // Cleared again: the policy carries no limits at all.
    await type('startsPerHour', '');
    await click($('[data-testid="remote-spawn-save"]'));
    expect(spawnPolicySet.mock.calls.at(-1)![0]).not.toHaveProperty('limits');
  });

  it('offers only the agents another PC may start', async () => {
    stub();
    await render(<RemoteSpawnSection enabled />);
    await click($('[data-testid="remote-spawn-enabled"]'));
    const offered = [...container.querySelectorAll('[data-remote-spawn-agent]')].map((el) => el.getAttribute('data-remote-spawn-agent'));
    expect(offered).toContain('claude');
    expect(offered).toContain('codex');
    for (const agent of ['gemini', 'qwen', 'kimi']) expect(offered).not.toContain(agent);
  });

  it('a saved policy naming one of the others loses it, and the next save sends the rest', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111';
    const claude = { hostId, rootId: 'web', agent: 'claude' };
    stub(undefined, {
      ...defaultSpawnPolicy(), enabled: true, roots: [{ id: 'web', label: 'Web', path: '/r' }],
      agents: ['claude', 'gemini'], rules: [{ hostId, rootId: 'web', agent: 'gemini' }, claude],
    });
    await render(<RemoteSpawnSection enabled />);
    await click($('[data-remote-spawn-agent="codex"]'));
    await click($('[data-testid="remote-spawn-save"]'));
    expect(spawnPolicySet).toHaveBeenCalledTimes(1);
    expect(spawnPolicySet.mock.calls[0][0]).toMatchObject({ agents: ['claude', 'codex'], rules: [claude] });
  });

  it('shows the daemon’s reason when it refuses the save', async () => {
    stub(() => ({ ok: false, error: '/tmp/x is not the top folder of a git repository' }));
    await render(<RemoteSpawnSection enabled pickFolder={async () => '/tmp/x'} />);
    await click($('[data-testid="remote-spawn-enabled"]'));
    await click($('[data-testid="remote-spawn-add-folder"]'));
    await click($('[data-testid="remote-spawn-save"]'));
    expect($('[data-testid="remote-spawn-error"]')!.textContent).toBe('/tmp/x is not the top folder of a git repository');
    // Still a draft: Save stays available.
    expect($<HTMLButtonElement>('[data-testid="remote-spawn-save"]')!.disabled).toBe(false);
  });

  it('reloads the saved policy and says so when it changed elsewhere meanwhile', async () => {
    stub(() => ({ ok: false, conflict: true, error: 'the settings changed in the meantime' }));
    const elsewhere = { ...defaultSpawnPolicy(), enabled: true, version: 4 };
    const get = (window as unknown as { electronAPI: { a2aRemote: { spawnPolicyGet: ReturnType<typeof vi.fn> } } }).electronAPI.a2aRemote.spawnPolicyGet;
    await render(<RemoteSpawnSection enabled />);
    await click($('[data-testid="remote-spawn-enabled"]'));
    get.mockResolvedValue({ policy: elsewhere });
    await click($('[data-testid="remote-spawn-save"]'));
    expect($('[data-testid="remote-spawn-error"]')!.textContent).toBe('These settings changed in the meantime. They were reloaded; make your change again.');
    // The reloaded policy is the new baseline: nothing left to save.
    expect($('[data-testid="remote-spawn-enabled"]')!.getAttribute('aria-checked')).toBe('true');
    expect($<HTMLButtonElement>('[data-testid="remote-spawn-save"]')!.disabled).toBe(true);
  });

  it('takes bypass permissions only after the confirm', async () => {
    stub();
    await render(<RemoteSpawnSection enabled />);
    await click($('[data-testid="remote-spawn-enabled"]'));
    const select = () => $<HTMLSelectElement>('select[data-testid="remote-spawn-mode"]')!;

    await choose(select(), 'bypassPermissions');
    expect($('[data-testid="remote-spawn-bypass-confirm"]')).not.toBeNull();
    expect(select().value).toBe('auto');
    await click($('[data-testid="remote-spawn-save"]'));
    expect(spawnPolicySet.mock.calls[0][0].permissionMode).toBe('auto');

    await choose(select(), 'bypassPermissions');
    await click($('[data-testid="remote-spawn-bypass-ok"]'));
    expect($('[data-testid="remote-spawn-bypass-confirm"]')).toBeNull();
    expect(select().value).toBe('bypassPermissions');
    await click($('[data-testid="remote-spawn-save"]'));
    expect(spawnPolicySet.mock.calls[1][0].permissionMode).toBe('bypassPermissions');
  });
});
