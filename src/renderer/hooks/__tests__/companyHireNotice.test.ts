// @vitest-environment jsdom
//
// The CEO hears of a hired seat once its agent is up: nothing while the seat
// has no agent, one line when it appears, nothing once the pane closed or the
// company is gone, and never into a CEO mid-turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { HIRE_NOTICE_TRIES, watchHireNotice } from '../companyHireNotice';

const CEO_PTY = 'pty-ceo';
const SEAT_PTY = 'pty-seat';
const TEXT = 'wmux: #dev-4 joined the company (owns Windows; branch company/dev-4-456789ab). Brief it like your other seats.';

const surface = (id: string, ptyId: string): Surface => ({ id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' });
const leaf = (id: string, surfaces: Surface[]): PaneLeaf =>
  ({ id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' }) as PaneLeaf;
const company = (seat: PaneLeaf): Workspace => ({
  id: 'ws-co',
  name: 'Acme',
  wsOrdinal: 1,
  activePaneId: 'p-ceo',
  company: { v: 1, id: 'co-1', coordinatorPaneId: 'p-ceo' },
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p-ceo', [surface('s-ceo', CEO_PTY)]), seat],
  } as unknown as Pane,
}) as Workspace;
const emptySeat = () => leaf('p-seat', []);
const startedSeat = () => leaf('p-seat', [surface('s-seat', SEAT_PTY)]);

let gatedSubmit: ReturnType<typeof vi.fn>;
let stop: () => void = () => undefined;

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  gatedSubmit = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { rpc: { gatedSubmit } };
  useStore.setState({ ...useStore.getInitialState(), workspaces: [company(emptySeat())] });
  useStore.getState().setSurfaceAgent(CEO_PTY, 'Claude Code', 'idle', 'claude');
  useStore.getState().hydrateAgentAlive({ [CEO_PTY]: true });
});
afterEach(() => {
  stop();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const watch = () => {
  stop = watchHireNotice({ workspaceId: 'ws-co', paneId: 'p-seat', label: 'dev-4', owns: 'Windows', branch: 'company/dev-4-456789ab' });
};

describe('watchHireNotice', () => {
  it('sends nothing while the seat has no agent, then one line to the CEO pane when it appears', async () => {
    watch();
    await flush();
    expect(gatedSubmit).not.toHaveBeenCalled();
    // A terminal with no agent in it yet.
    useStore.setState({ workspaces: [company(startedSeat())] });
    await flush();
    expect(gatedSubmit).not.toHaveBeenCalled();

    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    await flush();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(gatedSubmit.mock.calls[0][0]).toBe(CEO_PTY);
    expect(gatedSubmit.mock.calls[0][1]).toBe(TEXT);
    expect(gatedSubmit.mock.calls[0][2]).toBe('Claude Code');
    expect(gatedSubmit.mock.calls[0][3]).toMatchObject({ waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: expect.any(Number) });

    // Later changes send nothing more.
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'running', 'codex');
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    await flush();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once the seat\'s pane has closed', async () => {
    useStore.setState({ workspaces: [company(startedSeat())] });
    watch();
    useStore.setState({
      workspaces: [{ ...company(startedSeat()), rootPane: leaf('p-ceo', [surface('s-ceo', CEO_PTY)]) } as Workspace],
    });
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    // The pane back under the same id is not the seat any more.
    useStore.setState({ workspaces: [company(startedSeat())] });
    await flush();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('sends nothing once the workspace is no longer a company', async () => {
    useStore.setState({ workspaces: [company(startedSeat())] });
    watch();
    useStore.setState({ workspaces: [{ ...company(startedSeat()), company: undefined }] });
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    useStore.setState({ workspaces: [company(startedSeat())] });
    await flush();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('waits while the CEO is mid-turn, and sends when it is free', async () => {
    useStore.setState({ workspaces: [company(startedSeat())] });
    useStore.getState().setSurfaceAgent(CEO_PTY, 'Claude Code', 'running', 'claude');
    watch();
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    await flush();
    expect(gatedSubmit).not.toHaveBeenCalled();
    useStore.getState().setSurfaceAgent(CEO_PTY, 'Claude Code', 'idle', 'claude');
    await flush();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('tries a refused line again on a later change, a few times at most', async () => {
    gatedSubmit.mockResolvedValue({ ok: false, reason: 'user_typing', detail: 'typing' });
    useStore.setState({ workspaces: [company(startedSeat())] });
    useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', 'idle', 'codex');
    watch();
    await flush();
    for (let i = 0; i < HIRE_NOTICE_TRIES + 2; i++) {
      useStore.getState().setSurfaceAgent(SEAT_PTY, 'Codex', i % 2 ? 'idle' : 'waiting', 'codex');
      await flush();
    }
    expect(gatedSubmit).toHaveBeenCalledTimes(HIRE_NOTICE_TRIES);
  });
});
