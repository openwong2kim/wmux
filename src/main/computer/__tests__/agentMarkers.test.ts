import { describe, expect, it, vi } from 'vitest';
import { AGENT_MARKER_COLORS } from '../../../shared/computer/agentMarker';
import { AGENT_MARKER_LABEL_MAX, AgentMarkers } from '../agentMarkers';
import type { ComputerAgent } from '../ComputerService';

const pane = (n: number, extra: Partial<ComputerAgent> = {}): ComputerAgent => ({
  key: `claude-code @ ws-a/pty-${n}`,
  label: 'claude-code in workspace "api"',
  ptyId: `pty-${n}`,
  client: 'claude-code',
  workspaceName: 'api',
  ...extra,
});

describe('AgentMarkers', () => {
  it('gives colours in first-input order, keeps each for good, and starts the palette over after the last', () => {
    const markers = new AgentMarkers();
    const colours = Array.from({ length: AGENT_MARKER_COLORS.length + 1 }, (_, i) => markers.markerFor(pane(i)).color);
    expect(colours.slice(0, AGENT_MARKER_COLORS.length)).toEqual([...AGENT_MARKER_COLORS]);
    expect(colours[AGENT_MARKER_COLORS.length]).toBe(AGENT_MARKER_COLORS[0]);

    const first = markers.markerFor(pane(0));
    expect(first.color).toBe(AGENT_MARKER_COLORS[0]);
    expect(markers.markerFor(pane(0)).id).toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{12}$/);
    expect(markers.markerFor(pane(1)).id).not.toBe(first.id);
  });

  it('labels the pill with the pane tag, else the workspace, then the client', () => {
    const paneTag = vi.fn((ptyId: string): string | null => (ptyId === 'pty-1' ? '#api-1' : null));
    const markers = new AgentMarkers({ paneTag });
    expect(markers.markerFor(pane(1)).label).toBe('#api-1 · Claude Code');
    expect(markers.markerFor(pane(2)).label).toBe('api · Claude Code');
    expect(markers.markerFor({ key: 'x', label: 'x', client: 'some-client' }).label).toBe('outside wmux · some-client');
    // A tag that appears later (the pane was named) shows on the next input.
    paneTag.mockImplementation(() => '#web');
    expect(markers.markerFor(pane(2)).label).toBe('#web · Claude Code');
    expect(markers.labelOf(pane(2).key)).toBe('#web · Claude Code');
    expect(markers.labelOf('never-sent-input')).toBeUndefined();
  });

  it('keeps the label short and survives a tag lookup that throws', () => {
    const markers = new AgentMarkers({ paneTag: () => { throw new Error('no mirror'); } });
    const long = markers.markerFor(pane(1, { workspaceName: 'a workspace name that goes on and on and on', client: 'an-mcp-client-with-a-long-name' }));
    expect(Array.from(long.label).length).toBeLessThanOrEqual(AGENT_MARKER_LABEL_MAX);
    expect(long.label).toMatch(/^a workspace .*… · an-mcp-client-with-…$/);
  });

  it('gives a new agent a colour that agents gone quiet freed, and keeps the busy ones', () => {
    let now = 0;
    const markers = new AgentMarkers({ now: () => now });
    expect([0, 1, 2].map((i) => markers.markerFor(pane(i)).color)).toEqual(AGENT_MARKER_COLORS.slice(0, 3));
    now = 31 * 60_000;
    expect(markers.markerFor(pane(1)).color).toBe(AGENT_MARKER_COLORS[1]);
    // pty-0 and pty-2 have been quiet for over 30 minutes: their colours are free again.
    expect(markers.markerFor(pane(3)).color).toBe(AGENT_MARKER_COLORS[0]);
    expect(markers.markerFor(pane(4)).color).toBe(AGENT_MARKER_COLORS[2]);
    expect(markers.markerFor(pane(0)).color).toBe(AGENT_MARKER_COLORS[0]);
  });

  it('keeps a client name from passing for a pane tag, and fits a wide one', () => {
    const markers = new AgentMarkers();
    expect(markers.markerFor({ key: 'y', label: 'y', client: '#w1-1 · Claude Code' }).label).toBe('outside wmux · w1-1 Claude Code');
    const wide = markers.markerFor(pane(1, { client: '😀'.repeat(20), workspaceName: 'a workspace name that goes on' }));
    expect(Array.from(wide.label).length).toBeLessThanOrEqual(AGENT_MARKER_LABEL_MAX);
    expect(wide.label).toMatch(/^a workspace .*… · 😀+$/u);
  });

  it('marks a pane with its first agent when two drive from it', () => {
    const markers = new AgentMarkers();
    markers.markerFor(pane(1));
    markers.markerFor(pane(1, { key: 'codex @ ws-a/pty-1', client: 'codex' }));
    expect(markers.entries()).toEqual([{ ptyId: 'pty-1', color: AGENT_MARKER_COLORS[0] }]);
  });

  it('lists one colour per pane and announces each pane that gets one', () => {
    const onPaneColour = vi.fn();
    const markers = new AgentMarkers({ onPaneColour });
    markers.markerFor({ key: 'commander', label: 'c', client: 'claude-code', workspaceName: 'api' });
    expect(onPaneColour).not.toHaveBeenCalled();
    markers.markerFor(pane(1));
    markers.markerFor(pane(1));
    expect(onPaneColour).toHaveBeenCalledTimes(1);
    expect(onPaneColour).toHaveBeenLastCalledWith([{ ptyId: 'pty-1', color: AGENT_MARKER_COLORS[1] }]);
    markers.markerFor(pane(2));
    expect(markers.entries()).toEqual([
      { ptyId: 'pty-1', color: AGENT_MARKER_COLORS[1] },
      { ptyId: 'pty-2', color: AGENT_MARKER_COLORS[2] },
    ]);
    expect(onPaneColour).toHaveBeenCalledTimes(2);
  });
});
