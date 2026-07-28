// Folded tool run (plan PR-7, DESIGN.md "tool calls render as flat mono log
// lines, never boxed chips").
//
// Collapsed: one line, `▸ 12 tool calls (Read ×5 · Edit ×4 · Bash ×3)`.
// Expanded: the same flat mono grammar per call — status glyph (● running amber
// / ✓ ok green / ✕ error red) + tool name + one-line arg summary.

import React, { useCallback, useState } from 'react';
import type { ToolBody, ToolResultEvent, ToolUseEvent } from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { formatToolRunLabel, toolCallState, type ToolRunRow } from './foldToolRuns';

export interface ToolRunLineProps {
  run: ToolRunRow;
  /** Resolves an over-cap body on expand — same handle CodeChip uses. */
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
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

/** The result that answered this call, if it has arrived. */
function resultFor(run: ToolRunRow, call: ToolUseEvent): ToolResultEvent | undefined {
  return run.events.find(
    (e): e is ToolResultEvent => e.kind === 'tool_result' && e.toolUseId === call.toolUseId,
  );
}

/**
 * One tool body — what a call was given, or what it returned.
 *
 * Most bodies arrive inline (measured: ~99% of inputs and ~95% of outputs fit
 * the 4 KB cap), so the common case is plain text with no fetch and no click.
 * A body over the cap arrives as a head plus a byte count; expanding pulls the
 * rest through the same `onFetchBody` handle CodeChip uses.
 *
 * Deliberately NOT a boxed chip: DESIGN.md says tool calls render as flat mono
 * log lines, and a bash transcript reads as a log, not as a card.
 */
function ToolBodyBlock({
  eventId,
  body,
  label,
  error,
  onFetchBody,
}: {
  eventId: string;
  body?: ToolBody;
  label: string;
  error?: boolean;
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}): React.ReactElement | null {
  const t = useT();
  const [full, setFull] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');

  const expand = useCallback(() => {
    if (!body || !onFetchBody || phase === 'loading') return;
    setPhase('loading');
    void onFetchBody(eventId, body.n)
      .then((text) => {
        setFull(text);
        setPhase('idle');
      })
      .catch(() => setPhase('error'));
  }, [body, onFetchBody, eventId, phase]);

  if (!body) return null;
  const shown = full ?? body.inline ?? '';
  // The producer says whether `inline` is only a head. Derived here it would
  // need a byte length, and `Buffer` does not exist in this renderer
  // (nodeIntegration: false) — that would throw, not merely miscount.
  const truncated = full === null && body.truncated === true;
  // A body can arrive with NO inline text at all: in a wide tool fan-out the
  // later calls spend the entry's whole inline allowance, so they carry only a
  // handle. Returning null here would take the expand button with it and leave
  // those calls permanently unreadable even though the daemon still has them.
  if (!shown && !truncated) return null;

  return (
    <div className="flex flex-col gap-0.5 pl-4" data-chat-tool-body={label}>
      <span className="text-[10px] font-mono text-[var(--text-muted)]">{label}</span>
      {shown && (
        <pre
          className={`m-0 whitespace-pre-wrap break-words text-[11px] font-mono leading-relaxed ${
            error ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]'
          }`}
        >
          {shown}
        </pre>
      )}
      {truncated && (
        <button
          type="button"
          onClick={expand}
          disabled={phase === 'loading' || !onFetchBody}
          data-chat-tool-body-expand
          className={`self-start text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
        >
          {phase === 'loading'
            ? t('chat.loadingBody')
            : phase === 'error'
              ? t('chat.bodyUnavailable')
              : t('chat.showFullBody', { bytes: String(body.bytes) })}
        </button>
      )}
    </div>
  );
}

export function ToolRunLine({ run, onFetchBody }: ToolRunLineProps): React.ReactElement {
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
            const result = resultFor(run, call);
            return (
              <div key={call.id} data-chat-tool-call={call.toolUseId} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-1.5 text-[11px] font-mono text-[var(--text-muted)]">
                  <span style={{ color: GLYPH_COLOR[callState] }} aria-hidden="true">
                    {GLYPH[callState]}
                  </span>
                  <span className="text-[var(--text-sub)]">{call.name}</span>
                  <span className="truncate">{call.argSummary}</span>
                </div>
                {/* What it was called WITH, then what came back. The summary
                    line above says which tool ran; these two say what actually
                    happened, which is the whole reason to expand a run. */}
                <ToolBodyBlock
                  eventId={call.id}
                  body={call.input}
                  label={t('chat.toolInput')}
                  onFetchBody={onFetchBody}
                />
                {result && (
                  <ToolBodyBlock
                    eventId={result.id}
                    body={result.output}
                    label={t('chat.toolOutput')}
                    error={!result.ok}
                    onFetchBody={onFetchBody}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ToolRunLine;
