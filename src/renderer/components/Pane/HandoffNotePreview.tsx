// The handoff note as it will be typed into the other agent, and its length:
// an 11px mono block on the selection fill (at most 120px, scrolling), then
// the length in muted tabular figures (DESIGN.md, usage-limit card). Shown by
// the usage-limit card and the pane menu's "Continue in another agent" dialog.
import { useT } from '../../hooks/useT';

export default function HandoffNotePreview({ note, className = '' }: { note: string; className?: string }) {
  const t = useT();
  return (
    <div className={className}>
      <pre
        aria-label={t('usageLimit.handoffPreview')}
        tabIndex={0}
        className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--chip-radius)] bg-[var(--selection)] p-2 font-mono text-[11px] text-[var(--text-sub)]"
        data-handoff-note
      >
        {note}
      </pre>
      <p className="mt-1 text-[11px] text-[var(--text-muted)] tabular-nums" data-handoff-note-length>
        {t('usageLimit.handoffLength', { count: note.length })}
      </p>
    </div>
  );
}
