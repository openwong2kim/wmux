// A hunk's lines drawn with +/- colour only (no syntax highlighting). Bare, it
// is the diff panel's body; with `numbered`, each line gets an old/new line
// number gutter, an optional gutter action (e.g. comment on this line) and an
// optional block under the line (threads, a composer), which reset the mono /
// pre-formatted text of the diff.
import type { ReactNode } from 'react';
import { numberHunkLines, type DiffLine } from '../../../shared/prReview';

const lineColor = (mark: string): string =>
  mark === '+' ? 'text-[var(--accent-green)]' : mark === '-' ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]';

export function HunkLines({ bodyLines, numbered, gutter, below }: {
  bodyLines: readonly string[];
  /** The hunk's start lines: draw a line-number gutter. */
  numbered?: { oldStart: number; newStart: number };
  /** The gutter for a numbered line (replaces the plain numbers when set). */
  gutter?: (line: DiffLine) => ReactNode;
  /** A block drawn under a numbered line. */
  below?: (line: DiffLine) => ReactNode;
}) {
  if (!numbered) {
    return (
      <div className="font-mono text-[11px] leading-[1.5] whitespace-pre overflow-x-auto">
        {bodyLines.map((line, i) => (
          <div key={i} className={lineColor(line.charAt(0))}>
            {line || ' '}
          </div>
        ))}
      </div>
    );
  }
  const lines = numberHunkLines({ ...numbered, bodyLines });
  return (
    <div className="wmux-hunk-lines font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => {
        const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        const extra = below?.(line);
        return (
          <div key={i} data-hunk-line={line.kind}>
            <div className="wmux-hunk-row">
              {gutter ? gutter(line) : <HunkGutter line={line} />}
              <span className={`wmux-hunk-text ${lineColor(mark)}`}>{line.kind === 'meta' ? line.text : `${mark}${line.text}`}</span>
            </div>
            {extra && <div className="wmux-hunk-below">{extra}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** The old and new line numbers of one line (blank where the line has none). */
export function HunkGutter({ line }: { line: DiffLine }) {
  return (
    <span className="wmux-hunk-gutter" aria-hidden="true">
      <span>{line.oldLine ?? ''}</span>
      <span>{line.newLine ?? ''}</span>
    </span>
  );
}
