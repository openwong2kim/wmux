import type { TerminalCursorStyle } from '../../../shared/terminalCursor';
import { TERMINAL_CURSOR_STYLES } from '../../../shared/terminalCursor';
import { FOCUS_RING } from '../focusRing';

const LABEL_KEY: Record<TerminalCursorStyle, 'settings.cursorBlock' | 'settings.cursorBar' | 'settings.cursorUnderline'> = {
  block: 'settings.cursorBlock',
  bar: 'settings.cursorBar',
  underline: 'settings.cursorUnderline',
};

function CursorGlyph({ style }: { style: TerminalCursorStyle }) {
  if (style === 'block') {
    return <span aria-hidden="true" className="inline-block w-[7px] h-[14px] align-[-2px]" style={{ backgroundColor: 'var(--accent)' }} />;
  }
  if (style === 'bar') {
    return <span aria-hidden="true" className="inline-block w-[2px] h-[14px] align-[-2px]" style={{ backgroundColor: 'var(--accent)' }} />;
  }
  return <span aria-hidden="true" className="inline-block w-[7px] h-[2px] align-[-2px]" style={{ backgroundColor: 'var(--accent)' }} />;
}

export function CursorShapePicker({
  value,
  onChange,
  t,
}: {
  value: TerminalCursorStyle;
  onChange: (style: TerminalCursorStyle) => void;
  t: (key: string) => string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t('settings.cursorShape')}
      className="grid grid-cols-3 gap-2 w-full"
    >
      {TERMINAL_CURSOR_STYLES.map((style) => {
        const selected = value === style;
        return (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={selected}
            data-cursor-style={style}
            onClick={() => onChange(style)}
            // Same selection grammar as the theme cards: a neutral outline,
            // never steel (steel is the focus ring).
            className={`settings-theme-card px-2 pt-2 pb-1.5 ${FOCUS_RING}`}
            style={{ backgroundColor: 'var(--surface-fill)' }}
          >
            <div
              className="h-9 rounded-[6px] px-2.5 flex items-center gap-1 font-mono text-xs"
              style={{ backgroundColor: '#101012', color: '#c8c4bc' }}
            >
              <span>~/wmux</span>
              <CursorGlyph style={style} />
            </div>
            <div
              className="mt-1.5 text-[13px]"
              style={{ color: selected ? 'var(--text-main)' : 'var(--text-sub)', fontWeight: selected ? 500 : 400 }}
            >
              {t(LABEL_KEY[style])}
            </div>
          </button>
        );
      })}
    </div>
  );
}
