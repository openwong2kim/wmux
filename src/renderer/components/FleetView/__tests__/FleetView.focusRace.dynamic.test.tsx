// @vitest-environment jsdom
//
// NB2 파동2 — FleetView 마운트 포커스 레이스 회귀 하네스.
//
// 증상(2모델 합의 CRITICAL): 상시 크롬으로 전환하면서 마운트 효과(rAF로 포커스를
// 당김)와 로빙 포커스 효과가 각각 useEffect로 분리됐다. 로빙 효과의
// `panel.contains(document.activeElement)` 가드는 마운트 시점에 동기 실행되는데,
// 그때는 rAF 콜백이 아직 안 돌아 패널 안에 포커스가 없어 거짓 → 즉시 return.
// 예전 마운트 효과는 panelRef(컨테이너)에만 포커스를 줬으므로 어떤 카드에도 실제
// DOM 포커스가 걸리지 않았다. 탭에 카드가 하나뿐이면 화살표를 눌러도 인덱스가
// 클램프돼 로빙이 영영 안 살아나고, 스크린리더도 최초 선택을 announce하지 못한다.
//
// 수정: 마운트 효과가 panelRef가 아니라 "현재 포커스 인덱스의 카드/행"에 직접
// 포커스한다. 이 하네스는 REAL <FleetView/>를 createRoot로 마운트해 효과를 돌리고,
// rAF를 flush한 뒤 document.activeElement가 (컨테이너가 아니라) data-fleet-card
// 버튼인지 검증한다. 카드가 하나뿐인 케이스(레이스가 영구화되던 조건)를 픽스처로
// 고정한다. 겸사겸사 닫힘 시 포커스 복원(INFO 4번)도 검증한다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as terminalTail from '../../../utils/terminalTail';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fixtures: 브라우저 서피스 단일 페인 = 카드 1개(터미널 tail 경로 회피) ─────
function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'browser', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}
const singleCardWorkspaces: Workspace[] = [
  workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
];

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(FleetView));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** 마운트 효과가 예약한 rAF 콜백(포커스 이동)을 flush한다. */
async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      sidebarPosition: 'left',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      workspaces: singleCardWorkspaces,
      // An idle agent (a pane with an agent identity), not a bare shell.
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    unmount();
  } catch {
    /* self-unmounted */
  }
  document.body.innerHTML = '';
});

describe('FleetView — mount focus race (NB2 wave2)', () => {
  it('lands real DOM focus on the single fleet card, not the panel container', async () => {
    // The fixture's only pane is idle, so the row sits behind the collapsed
    // "Idle N" option — which is where real DOM focus must land.
    mount();
    await flushRaf();

    const active = document.activeElement as HTMLElement | null;
    // 레이스가 있으면 여기서 active는 role=region 패널(또는 body)이라 실패한다.
    expect(active?.hasAttribute('data-fleet-idle-toggle')).toBe(true);
    expect(active?.getAttribute('role')).toBe('option');
  });

  it('restores focus to the opener element on close (unmount)', async () => {
    // 열기 트리거 대역: 마운트 직전에 포커스를 쥔 요소(예: 페인의 textarea).
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount();
    await flushRaf();
    // 열리면 포커스는 카드로 넘어간다.
    expect(document.activeElement).not.toBe(opener);

    unmount();
    // 닫히면 열기 시점 요소로 복원(브라우저가 body로 떨구지 않는다).
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

function seedFleet(): void {
  act(() => useStore.setState({
    workspaces: [
      workspace('ws-1', 'wmux', leaf('p1', [surface('s1', 'pty-1', { surfaceType: 'terminal', title: 'Codex CLI' })]), 'p1'),
      workspace('ws-2', 'marketing', leaf('p2', [surface('s2', 'pty-2', { surfaceType: 'terminal', title: '✳ Launch video' })]), 'p2'),
      workspace('ws-3', 'ios', leaf('p3', [surface('s3', 'pty-3', { surfaceType: 'terminal', title: 'Claude Code' })]), 'p3'),
    ],
    surfaceAgent: { 'pty-1': { name: 'Codex CLI', status: 'running' }, 'pty-2': { name: 'Claude Code', status: 'idle' }, 'pty-3': { name: 'Claude Code', status: 'idle' } },
    surfaceAgentStatus: { 'pty-2': 'complete' },
    surfacePendingQuestion: { 'pty-3': 'Which deployment target?' },
    surfaceTurnOpenAt: { 'pty-1': Date.now() },
    agentClockMs: Date.now(),
  }));
}

function rows(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-fleet-card]'));
}

function click(selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector)!;
  act(() => { button.focus(); button.click(); });
}

function key(element: Element, name: string): void {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
}

function search(value: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('FleetView — task triage', () => {
  it('derives running from the open turn and puts pending questions first', async () => {
    seedFleet();
    mount();
    await flushRaf();
    // One list: Needs you (the question, then the finished turn), then Running.
    expect(rows().map((row) => row.dataset.status)).toEqual(['awaiting_input', 'complete', 'running']);
    expect([...container.querySelectorAll<HTMLElement>('[data-fleet-section]')].map((el) => el.dataset.fleetSection))
      .toEqual(['needsYou', 'running']);
    expect(rows()[0].textContent).toContain('Which deployment target?');
    expect(rows()[2].textContent).toContain('wmux');
  });

  it('filters by task/project without stealing search focus, then navigates the results', async () => {
    seedFleet();
    mount();
    await flushRaf();
    const input = search('launch');
    await flushRaf();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Launch video');
    expect(document.activeElement).toBe(input);
    key(input, 'ArrowLeft');
    expect(document.activeElement).toBe(input);
    key(input, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[0]);
    search('not-a-project');
    await flushRaf();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('No panes match this view');
    click('.wmux-fleet-empty button');
    expect(rows()).toHaveLength(3);
  });

  it('keeps the selected pane across live reordering and scopes keyboard navigation to the filter', async () => {
    seedFleet();
    mount();
    await flushRaf();
    act(() => rows().find((row) => row.dataset.ptyId === 'pty-1')!.focus());
    act(() => useStore.setState({ surfaceAgentStatus: { 'pty-1': 'error', 'pty-2': 'complete' }, surfacePendingQuestion: {} }));
    await flushRaf();
    expect(document.activeElement?.getAttribute('data-pty-id')).toBe('pty-1');
    expect(rows()[0].dataset.ptyId).toBe('pty-1');
    // One list: ↓ steps to the next row, End and Home go to its ends.
    key(rows()[0], 'ArrowDown');
    await flushRaf();
    expect(document.activeElement).toBe(rows()[1]);
    key(rows()[1], 'End');
    await flushRaf();
    // The last option is the collapsed Idle row (pty-3 went idle).
    expect(document.activeElement?.hasAttribute('data-fleet-idle-toggle')).toBe(true);
    key(document.activeElement!, 'Home');
    await flushRaf();
    expect(document.activeElement?.getAttribute('data-pty-id')).toBe('pty-1');
  });

  it('opens the detail area on a deliberate selection, Space toggles it, Esc closes it before Fleet', async () => {
    const read = vi.spyOn(terminalTail, 'tailForPty').mockReturnValue(['real terminal output']);
    seedFleet();
    act(() => useStore.getState().setFleetViewVisible(true));
    mount();
    await flushRaf();
    // The mount focus selects the first row but opens nothing, and reads no output.
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    // ↓ is a deliberate selection: the detail opens on that row (20 lines).
    key(rows()[0], 'ArrowDown');
    await flushRaf();
    expect(read).toHaveBeenCalledWith('pty-2', 20);
    expect(container.querySelector('#fleet-output-preview')?.textContent).toBe('real terminal output');
    // Rows never carry terminal text; only the detail area does.
    expect(rows().some((row) => row.textContent?.includes('real terminal output'))).toBe(false);
    const focused = rows()[1];
    key(focused, ' ');
    await flushRaf();
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
    // Space did not click the row (no jump to its workspace).
    expect(useStore.getState().activeWorkspaceId).not.toBe('ws-2');
    key(focused, ' ');
    expect(container.querySelector('#fleet-output-preview')).not.toBeNull();
    // Esc closes the detail area first; the page stays.
    key(focused, 'Escape');
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
    expect(useStore.getState().fleetViewVisible).toBe(true);
    key(focused, 'Escape');
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('the row\'s details button selects that row and opens its detail', async () => {
    vi.spyOn(terminalTail, 'tailForPty').mockReturnValue(['output of the running agent']);
    seedFleet();
    mount();
    await flushRaf();
    const toggles = container.querySelectorAll<HTMLButtonElement>('[data-fleet-detail-toggle]');
    act(() => toggles[2].click());
    await flushRaf();
    expect(toggles[2].getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#fleet-output-preview')?.textContent).toBe('output of the running agent');
    act(() => toggles[2].click());
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
  });

  it('has no tabs: approvals open from the summary only when there are some; filter chips hide at zero', async () => {
    seedFleet();
    mount();
    await flushRaf();
    expect(container.querySelector('[role=tablist]')).toBeNull();
    expect(container.querySelector('[data-fleet-stat="approvals"]')).toBeNull();
    // Zero-count chips are not drawn (no idle agents, no tickets).
    expect([...container.querySelectorAll('[data-filter]')].map((el) => el.getAttribute('data-filter')))
      .toEqual(['attention', 'running', 'complete']);
    // Running narrows the list; pressing it again shows everything.
    click('[data-filter="running"]');
    expect(rows().map((row) => row.dataset.ptyId)).toEqual(['pty-1']);
    click('[data-filter="running"]');
    expect(rows()).toHaveLength(3);
    // The board's 1–4 column keys are gone.
    act(() => rows()[0].focus());
    key(rows()[0], '3');
    await flushRaf();
    expect(document.activeElement).toBe(rows()[0]);
  });
});

describe('FleetView — attention board sections', () => {
  function seedIdleFleet(): void {
    const now = Date.now();
    act(() => useStore.setState({
      workspaces: [
        workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1', { surfaceType: 'terminal', title: 'alpha task' })]), 'p1'),
        workspace('ws-2', 'beta', leaf('p2', [surface('s2', 'pty-2', { surfaceType: 'terminal', title: 'beta task' })]), 'p2'),
      ],
      surfaceOutputAt: { 'pty-1': now - 2 * 86_400_000, 'pty-2': now - 5 * 60_000 },
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' }, 'pty-2': { name: 'Claude Code', status: 'idle' } },
    }));
  }

  it('focuses the collapsed idle row when everything is idle', async () => {
    seedIdleFleet();
    mount();
    await flushRaf();
    const toggle = container.querySelector<HTMLButtonElement>('[data-fleet-idle-toggle]')!;
    expect(toggle.textContent).toContain('Idle 2 · oldest 2d');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(rows()).toHaveLength(0);
    // Empty sections draw no header at all.
    expect(container.querySelector('[data-fleet-section=needsYou]')).toBeNull();
    expect(container.querySelector('[data-fleet-section=running]')).toBeNull();
  });

  it('expanding and collapsing idle keeps roving focus on a valid row', async () => {
    seedIdleFleet();
    mount();
    await flushRaf();
    const toggle = container.querySelector<HTMLButtonElement>('[data-fleet-idle-toggle]')!;
    click('[data-fleet-idle-toggle]');
    expect(useStore.getState().fleetIdleExpanded).toBe(true);
    expect(rows().map((row) => row.dataset.ptyId)).toEqual(['pty-2', 'pty-1']);
    key(toggle, 'ArrowDown');
    await flushRaf();
    expect(document.activeElement).toBe(rows()[0]);
    key(rows()[0], 'ArrowDown');
    await flushRaf();
    expect(document.activeElement).toBe(rows()[1]);
    // Collapse while an idle row holds the roving slot: exactly one option
    // stays tabbable and it is a rendered one.
    act(() => useStore.getState().setFleetIdleExpanded(false));
    await flushRaf();
    expect(rows()).toHaveLength(0);
    const tabbable = container.querySelectorAll('[role=option][tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(container.querySelector('[data-fleet-idle-toggle]'));
  });

  it('uses the stored last message as the detail of a finished turn', async () => {
    seedIdleFleet();
    act(() => useStore.setState({
      surfaceAgentStatus: { 'pty-1': 'complete' },
      surfaceLastMessage: { 'pty-1': 'Refactor done; 12 tests pass.' },
    }));
    mount();
    await flushRaf();
    expect(rows()[0].dataset.ptyId).toBe('pty-1');
    expect(rows()[0].querySelector('.wmux-fleet-detail')?.textContent).toBe('Refactor done; 12 tests pass.');
  });

  it('shows a row\'s elapsed time since its newest activity stamp', async () => {
    seedIdleFleet();
    act(() => useStore.setState({ fleetIdleExpanded: true }));
    mount();
    await flushRaf();
    expect(rows()[0].querySelector('[data-fleet-elapsed]')?.textContent).toBe('5m');
    expect(rows()[1].querySelector('[data-fleet-elapsed]')?.textContent).toBe('2d');
  });
});

describe('FleetView — changed since you last looked', () => {
  it('marks a needs-you row whose status changed after the last close, and only then', async () => {
    seedFleet();
    mount();
    await flushRaf();
    // First open: no snapshot, no dots.
    expect(container.querySelectorAll('[data-fleet-changed]')).toHaveLength(0);
    unmount();
    expect(useStore.getState().fleetLastSeen?.statuses).toMatchObject({
      'pty-1': { status: 'running' },
      'pty-2': { status: 'complete' },
      'pty-3': { status: 'awaiting_input', question: 'Which deployment target?' },
    });

    // While closed, pty-1 errors; pty-2 / pty-3 stay as they were.
    act(() => useStore.setState({ surfaceAgentStatus: { 'pty-1': 'error', 'pty-2': 'complete' } }));
    mount();
    await flushRaf();
    const changed = rows().filter((row) => row.querySelector('[data-fleet-changed]'));
    expect(changed.map((row) => row.dataset.ptyId)).toEqual(['pty-1']);
    expect(changed[0].getAttribute('aria-label')).toContain('changed since you last looked');
    expect(rows().find((row) => row.dataset.ptyId === 'pty-3')?.getAttribute('aria-label')).not.toContain('changed since');
  });
});

describe('FleetView — remote rows and browser help stay wired', () => {
  it('passes remoteWorkspaces to the selector: a remote agent renders with the origin glyph', async () => {
    act(() => useStore.setState({
      workspaces: [workspace('ws-r', 'remote proj', leaf('pr', [surface('rs-1', '', {
        surfaceType: 'remote-terminal', remoteHostId: 'host-1', remoteSessionId: 'rsession-9',
      })]), 'pr')],
      remoteWorkspaces: [{
        key: 'host-1:rw-1', hostId: 'host-1', hostLabel: 'office-mac', workspaceId: 'rw-1', name: 'proj',
        panes: [{ sessionId: 'rsession-9', shell: 'zsh', agentName: 'Codex', agentStatus: 'awaiting_input' }],
      }] as unknown as ReturnType<typeof useStore.getState>['remoteWorkspaces'],
    }));
    mount();
    await flushRaf();
    const row = rows()[0];
    expect(row.dataset.status).toBe('awaiting_input');
    expect(row.querySelector('[data-fleet-remote]')?.getAttribute('title')).toBe('@office-mac');
    expect(row.getAttribute('aria-label')).toContain('office-mac');
  });

  it('browser-help Jump closes Fleet', async () => {
    act(() => useStore.setState({
      fleetActiveTab: 'approvals', appRoute: 'fleet', fleetViewVisible: true,
      browserHelpRequests: { r1: { requestId: 'r1', workspaceId: 'ws-1', surfaceId: 's1', prompt: 'Sign in', deadlineAt: Date.now() + 60_000 } },
      browserHelpOrder: ['r1'],
    }));
    mount();
    await flushRaf();
    click('[data-inbox-row] button[title]');
    expect(useStore.getState().fleetViewVisible).toBe(false);
    expect(useStore.getState().activeWorkspaceId).toBe('ws-1');
  });

  it('renders a browser help request on the approvals tab', async () => {
    act(() => useStore.setState({
      fleetActiveTab: 'approvals',
      browserHelpRequests: { r1: { requestId: 'r1', workspaceId: 'ws-1', surfaceId: 's1', prompt: 'Sign in, then press Done.', deadlineAt: Date.now() + 60_000 } },
      browserHelpOrder: ['r1'],
    }));
    mount();
    await flushRaf();
    expect(container.textContent).toContain('Browser needs you');
    expect(container.textContent).toContain('Sign in, then press Done.');
  });
});

describe('FleetView — a rail page: a jump returns to Workspaces', () => {
  it('goes back to Workspaces on the jumped-to workspace', async () => {
    seedFleet();
    act(() => useStore.getState().setFleetViewVisible(true));
    mount();
    await flushRaf();
    expect(useStore.getState().appRoute).toBe('fleet');
    click('[data-pty-id="pty-2"]');
    expect(useStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('leaves with Escape inside Fleet or the global toggle — the page has no close button', async () => {
    seedFleet();
    act(() => useStore.getState().setFleetViewVisible(true));
    mount();
    await flushRaf();
    expect(container.querySelector('.wmux-fleet-close')).toBeNull();
    key(rows()[0], 'Escape');
    expect(useStore.getState().appRoute).toBe('workspaces');
    act(() => useStore.getState().toggleFleetView());
    expect(useStore.getState().appRoute).toBe('fleet');
    act(() => useStore.getState().toggleFleetView());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});
