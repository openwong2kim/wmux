import { memo, useEffect, useState } from 'react';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import type { AgentStep, Block, ToolPreview } from '../../../shared/chatv2/session';
import { claudeModelLabel } from '../../../shared/claudeModels';
import { displayPath } from '../../../shared/chatv2/paths';
import { taskListProgressLabel } from '../../../shared/chatv2/taskList';
import type { FormAnswers } from '../../../shared/chatv2/questions';
import { ApprovalCard, QuestionCard } from './Cards';
import { formatClockTime, formatWorkingDuration } from './format';
import type { ToolState, TranscriptRow } from './rows';
import type { BodyRead } from './controller';
import { S } from './strings';

export interface TranscriptActions {
  answer(requestId: string, decision: 'allow' | 'deny', answers?: FormAnswers): Promise<boolean>;
  body(blockId: string, field: 'text' | 'detail' | 'output', offset?: number): Promise<BodyRead | null>;
}

const GLYPH: Record<ToolState, string> = { running: '●', done: '✓', failed: '✕' };

function StatusGlyph({ state }: { state: ToolState }) {
  return <span className="wmux-chatv2-glyph" data-state={state} aria-hidden>{GLYPH[state]}</span>;
}

function previewSummary(preview: ToolPreview | undefined, title: string, cwd: string): string {
  const value = preview?.path ? displayPath(preview.path, cwd) : preview?.query ?? (preview?.kind === 'shell' ? preview.title ?? '' : '');
  return value && !title.includes(value) ? value : '';
}

function PreviewBody({ preview }: { preview: ToolPreview }) {
  if (preview.lines?.length) {
    return (
      <pre className="wmux-chatv2-pre">
        {preview.lines.map((line, index) => (
          <span key={index} className="wmux-chatv2-line" data-kind={line.kind}>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} {line.text}{'\n'}
          </span>
        ))}
      </pre>
    );
  }
  return preview.output ? <pre className="wmux-chatv2-pre">{preview.output}</pre> : null;
}

/**
 * The part a byte cap cut, fetched on request (`bodies`). `text` undefined =
 * not asked, null = no longer kept. A partial read keeps what it has and offers
 * to continue (`stopped`).
 */
function useFullBody(block: Block, field: 'text' | 'detail' | 'output', actions: TranscriptActions) {
  const [read, setRead] = useState<BodyRead | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (loading) return;
    setLoading(true);
    const from = read?.stopped ? read.nextOffset ?? 0 : 0;
    const before = read?.stopped ? read.text : '';
    void actions.body(block.id, field, from).then((next) => {
      if (next) setRead({ ...next, text: before + next.text });
      else if (before) setRead({ text: before, nextOffset: from, stopped: 'error' });
      else setRead(null);
    }).finally(() => setLoading(false));
  };
  return { read, load, loading };
}

/** Continue or retry a partial read, or say the value is gone. */
function BodyMore({ read, loading, load, first }: { read: BodyRead | null | undefined; loading: boolean; load: () => void; first: string }) {
  if (read === null) return <span className="wmux-chatv2-meta">{S.bodyGone}</span>;
  if (read && !read.stopped) return null;
  const label = loading ? S.loadingFull : !read ? first : read.stopped === 'limit' ? S.showRest : S.retry;
  return (
    <span className="wmux-chatv2-body-more">
      {read?.stopped === 'error' && <span className="wmux-chatv2-meta" role="status">{S.partialLoaded}</span>}
      <button type="button" className="wmux-chatv2-link" data-truncated disabled={loading} onClick={load}>{label}</button>
    </span>
  );
}

function FullBody({ block, field, actions }: { block: Block; field: 'detail' | 'output'; actions: TranscriptActions }) {
  const { read, load, loading } = useFullBody(block, field, actions);
  return (
    <>
      {read && <pre className="wmux-chatv2-pre">{read.text}</pre>}
      <BodyMore read={read} loading={loading} load={load} first={S.showMore} />
    </>
  );
}

/** Block prose, with the cut tail offered on request when the fold capped it. */
function CappedText({ block, actions, render }: { block: Block; actions: TranscriptActions; render: (text: string) => React.ReactNode }) {
  const { read, load, loading } = useFullBody(block, 'text', actions);
  return (
    <>
      {render(read ? read.text : block.text)}
      {block.overflow?.text && <BodyMore read={read} loading={loading} load={load} first={S.showFullText} />}
    </>
  );
}

function ToolRow({ block, state, cwd, actions, findActive }: { block: Block; state: ToolState; cwd: string; actions: TranscriptActions; findActive: boolean }) {
  const tool = block.tool;
  const title = tool?.title || block.text || tool?.kind || 'Tool';
  const summary = previewSummary(tool?.preview, title, cwd);
  const hasBody = !!(tool?.preview?.lines?.length || tool?.preview?.output || tool?.detail);
  const line = (
    <>
      <StatusGlyph state={state} />
      <span className="wmux-chatv2-tool-title">{title}</span>
      {summary && <span className="wmux-chatv2-tool-summary">{summary}</span>}
    </>
  );
  return (
    <div className="wmux-chatv2-tool" data-block-id={block.id} data-find-active={findActive || undefined}>
      {hasBody ? (
        <details>
          <summary className="wmux-chatv2-tool-line">{line}</summary>
          {tool?.preview && <PreviewBody preview={tool.preview} />}
          {block.overflow?.output && <FullBody block={block} field="output" actions={actions} />}
          {tool?.detail && <pre className="wmux-chatv2-pre">{tool.detail}</pre>}
          {block.overflow?.detail && <FullBody block={block} field="detail" actions={actions} />}
        </details>
      ) : (
        <div className="wmux-chatv2-tool-line">{line}</div>
      )}
      {block.approval && <ApprovalCard block={block} onAnswer={actions.answer} />}
    </div>
  );
}

function stepState(step: AgentStep): ToolState {
  if (step.status === 'failed' || step.status === 'cancelled') return 'failed';
  return step.status === 'completed' || step.kind !== 'tool' ? 'done' : 'running';
}

function SubagentRow({ block, state, actions, findActive }: { block: Block; state: ToolState; actions: TranscriptActions; findActive: boolean }) {
  const run = block.agentRun!;
  const meta = [run.agentType, run.model && claudeModelLabel(run.model), S.steps(run.steps.length)].filter(Boolean).join(' · ');
  return (
    <div className="wmux-chatv2-subagent" data-block-id={block.id} data-find-active={findActive || undefined}>
      <details>
        <summary className="wmux-chatv2-tool-line">
          <StatusGlyph state={state} />
          <span className="wmux-chatv2-tool-title">{run.name || S.subagent}</span>
          <span className="wmux-chatv2-tool-summary">{meta}</span>
        </summary>
        <ol className="wmux-chatv2-steps">
          {run.steps.map((step) => (
            <li key={step.id} className="wmux-chatv2-tool-line" data-kind={step.kind}>
              {step.kind === 'tool' ? <StatusGlyph state={stepState(step)} /> : <span className="wmux-chatv2-glyph" aria-hidden>·</span>}
              <span className="wmux-chatv2-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
      </details>
      {block.approval && <ApprovalCard block={block} onAnswer={actions.answer} />}
    </div>
  );
}

/** Live turns tick every second; finished ones show the stored duration and end time. */
function TurnFooter({ row }: { row: Extract<TranscriptRow, { kind: 'footer' }> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!row.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [row.live]);
  const elapsed = row.live ? (row.startedAt != null ? Math.max(0, now - row.startedAt) : null) : row.durationMs ?? null;
  const label = formatWorkingDuration(elapsed, row.model, !row.live);
  const endedAt = !row.live && row.startedAt != null && row.durationMs != null ? row.startedAt + row.durationMs : null;
  const outcome = row.outcome === 'interrupted' ? S.interrupted : row.outcome === 'failed' ? S.failed : row.outcome === 'usage-limited' ? S.usageLimited : null;
  return (
    <div className="wmux-chatv2-footer" data-live={row.live || undefined} aria-live={row.live ? 'off' : undefined}>
      {row.live && <span className="wmux-chatv2-live-dot" aria-hidden />}
      <span>{label}</span>
      {endedAt != null && <><span aria-hidden>·</span><span>{formatClockTime(endedAt)}</span></>}
      {outcome && <><span aria-hidden>·</span><span data-outcome={row.outcome}>{outcome}</span></>}
    </div>
  );
}

export const TranscriptRowView = memo(function TranscriptRowView({ row, cwd, actions, findActive }: {
  row: TranscriptRow;
  cwd: string;
  actions: TranscriptActions;
  findActive: boolean;
}) {
  const active = { 'data-find-active': findActive || undefined };
  switch (row.kind) {
    case 'user':
      return <div className="wmux-chatv2-user" data-block-id={row.block.id} {...active}><CappedText block={row.block} actions={actions} render={(text) => text} /></div>;
    case 'assistant':
      return (
        <div className="wmux-chatv2-assistant" data-block-id={row.block.id} data-streaming={row.block.streaming || undefined} {...active}>
          <CappedText block={row.block} actions={actions} render={renderBrainMarkdown} />
        </div>
      );
    case 'reasoning':
      return (
        <details className="wmux-chatv2-reasoning" data-block-id={row.block.id}>
          <summary>{row.block.streaming ? `${S.thinking}…` : S.thinking}</summary>
          <div className="wmux-chatv2-reasoning-body"><CappedText block={row.block} actions={actions} render={(text) => text} /></div>
        </details>
      );
    case 'tool':
      return <ToolRow block={row.block} state={row.state} cwd={cwd} actions={actions} findActive={findActive} />;
    case 'subagent':
      return <SubagentRow block={row.block} state={row.state} actions={actions} findActive={findActive} />;
    case 'tasks': {
      const list = row.block.taskList!;
      return (
        <div className="wmux-chatv2-tasks" data-block-id={row.block.id} {...active}>
          <span className="wmux-chatv2-tool-summary">{taskListProgressLabel(list.items)}</span>
          <ul>
            {list.items.map((item, index) => (
              <li key={item.id ?? index} data-status={item.status}>
                <span className="wmux-chatv2-glyph" aria-hidden>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : item.status === 'cancelled' ? '✕' : '○'}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case 'plan':
      return <div className="wmux-chatv2-plan" data-block-id={row.block.id} {...active}><CappedText block={row.block} actions={actions} render={renderBrainMarkdown} /></div>;
    case 'image':
      return <div className="wmux-chatv2-meta" data-block-id={row.block.id}>{row.block.image?.name ?? row.block.text}</div>;
    case 'notice':
      return <div className="wmux-chatv2-notice" data-tone={row.tone} role={row.tone === 'error' ? 'alert' : undefined}>{row.block.text}</div>;
    case 'meta':
      return <div className="wmux-chatv2-meta">{row.block.text}</div>;
    case 'question':
      return <QuestionCard prompt={row.prompt} onAnswer={actions.answer} />;
    case 'footer':
      return <TurnFooter row={row} />;
  }
});
