// Folded tool run (plan PR-7, DESIGN.md "tool calls render as flat mono log
// lines, never boxed chips").
//
// Collapsed: one line, `▸ 12 tool calls (Read ×5 · Edit ×4 · Bash ×3)`.
// Expanded: the same flat mono grammar per call — status glyph (● running amber
// / ✓ ok green / ✕ error red) + tool name + one-line arg summary.

import React, { useState } from 'react';
import type { ToolUseEvent } from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { formatToolRunLabel, toolCallState, type ToolRunRow } from './foldToolRuns';

export interface ToolRunLineProps {
  run: ToolRunRow;
}

const GLYPH: Record<'running' | 'ok' | 'error', string> = {
  running: '●',
  ok: '✓',
  error: '✕',
};

const GLYPH_COLOR: Record<'running' | 'ok' | 'error', string> = {
  running: 'var(--accent)',
  ok: 'var(--accent-green)',
  error: 'var(--accent-red)',
};

function runState(run: ToolRunRow): 'running' | 'ok' | 'error' {
  if (run.failed) return 'error';
  return run.running ? 'running' : 'ok';
}

export function ToolRunLine({ run }: ToolRunLineProps): React.ReactElement {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const state = runState(run);
  const calls = run.events.filter((e): e is ToolUseEvent => e.kind === 'tool_use');

  return (
    <div className="flex flex-col gap-0.5" data-chat-tool-run={run.id}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? t('chat.collapseToolRun') : t('chat.expandToolRun')}
        className={`self-start inline-flex items-baseline gap-1.5 text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span style={{ color: GLYPH_COLOR[state] }} aria-hidden="true">{GLYPH[state]}</span>
        <span data-chat-tool-run-label>{formatToolRunLabel(run, t)}</span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-0.5 pl-4" data-chat-tool-run-calls>
          {calls.map((call) => {
            const callState = toolCallState(run, call);
            return (
              <div
                key={call.id}
                data-chat-tool-call={call.toolUseId}
                className="flex items-baseline gap-1.5 text-[11px] font-mono text-[var(--text-muted)]"
              >
                <span style={{ color: GLYPH_COLOR[callState] }} aria-hidden="true">
                  {GLYPH[callState]}
                </span>
                <span className="text-[var(--text-sub)]">{call.name}</span>
                <span className="truncate">{call.argSummary}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ToolRunLine;
