import React, { useState } from 'react';
import { useT } from '../../hooks/useT';
import {
  type ResumeBinding,
  permissionFlagFor,
  resumeGrammarFor,
} from '../../../shared/agentResume';

/**
 * Assemble the resume command for a pane from its binding + LIVE cwd. Mirrors
 * the reboot-recovery pill's gates (Pane.tsx) so the two never diverge:
 *   - exact form (`--resume <id>` + the recorded permission flag) ONLY when the
 *     binding's origin cwd still matches the pane's live cwd (`--resume` is
 *     cwd-scoped); the permission flag rides the SAME line (both must land
 *     together);
 *   - otherwise the cwd-relative fallback (Claude `--continue` / Codex
 *     `resume --last`), which carries no recorded mode.
 * Returns `null` for a non-resumable agent (no grammar). Pure + exported so the
 * exact-vs-fallback decision is unit-testable without rendering.
 */
export function buildPaneResumeCommand(
  binding: ResumeBinding,
  paneCwd: string | undefined,
): { command: string; exact: boolean } | null {
  const grammar = resumeGrammarFor(binding.agent);
  if (!grammar) return null;
  // Lowercase ONLY a leading Windows drive letter; POSIX stays case-sensitive.
  const normCwd = (p: string | undefined): string => {
    let out = (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };
  const exact = !!(paneCwd && normCwd(binding.cwd) === normCwd(paneCwd));
  const permFlag = exact ? permissionFlagFor(binding.permissionMode) : '';
  const command = exact
    ? `${binding.agent}${permFlag ? ` ${permFlag}` : ''} ${grammar.withId(binding.sessionId)}`
    : `${binding.agent} ${grammar.fallback}`;
  return { command, exact };
}

/**
 * Per-pane resume affordance — the persistent sibling of the reboot-recovery
 * pill (Pane.tsx). Shown on ANY agent pane that carries a captured conversation
 * binding (surfaced by the daemon once its transcript exists), not only right
 * after a reboot. Reveals the Claude/Codex conversation UUID and, on 복구, types
 * the exact resume command into THIS pane — e.g.
 *   `claude --dangerously-skip-permissions --resume <uuid>`
 *
 * Typing carries NO trailing Enter — the click is the explicit intent D6
 * requires, the user presses Enter to run (so a `--dangerously-skip-permissions`
 * line is never auto-executed).
 */
export default function ResumeInfoChip(props: {
  ptyId: string;
  binding: ResumeBinding;
  /** The pane's live surface cwd (OSC 7-updated) for the cwd-match re-guard. */
  paneCwd: string | undefined;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwd } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const built = buildPaneResumeCommand(binding, paneCwd);
  if (!built) return null; // not a resumable agent — nothing to offer
  const { command } = built;

  const agentName = binding.agent.charAt(0).toUpperCase() + binding.agent.slice(1);

  const onRecover = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No trailing \r — the user presses Enter to run (D6: bypass is re-granted
    // only by an explicit keystroke, never automatically).
    window.electronAPI.pty.write(ptyId, command);
    setOpen(false);
  };

  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(binding.sessionId).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => { /* clipboard blocked — leave the UUID visible to select manually */ },
    );
  };

  return (
    <span
      style={{
        position: 'absolute',
        top: 4,
        left: 6,
        zIndex: 20,
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        fontSize: 10,
        fontFamily: 'ui-monospace, monospace',
        letterSpacing: '0.02em',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Quiet trigger chip — DESIGN.md: neutral surface, thin amber edge, no
          amber fill. Collapsed by default so an agent pane isn't cluttered. */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={t('resume.tooltip')}
        aria-label={t('resume.tooltip')}
        aria-expanded={open}
        style={{
          padding: '1px 6px',
          fontWeight: 600,
          color: 'var(--text-main)',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid color-mix(in srgb, var(--accent-cursor) 45%, transparent)',
          borderRadius: 4,
          boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.25))',
          cursor: 'pointer',
        }}
      >
        ↩ {t('resume.label', { agent: agentName })}
      </button>

      {open && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            maxWidth: 360,
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.35))',
          }}
        >
          {/* Conversation UUID + copy */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-subtle)' }}>UUID</span>
            <span
              style={{
                color: 'var(--text-sub)',
                userSelect: 'text',
                overflowWrap: 'anywhere',
              }}
            >
              {binding.sessionId}
            </span>
            <button
              onClick={onCopy}
              title={t('contextMenu.copy')}
              aria-label={t('contextMenu.copy')}
              style={{
                padding: '0 5px',
                font: 'inherit',
                color: 'var(--text-main)',
                background: 'var(--bg-surface0, rgba(255,255,255,0.06))',
                border: '1px solid var(--border-soft)',
                borderRadius: 3,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {/* Exact command preview — WYSIWYG with what 복구 types. */}
          <code
            style={{
              display: 'block',
              padding: '4px 6px',
              color: 'var(--text-sub)',
              backgroundColor: 'var(--bg-base, rgba(0,0,0,0.25))',
              border: '1px solid var(--border-soft)',
              borderRadius: 3,
              userSelect: 'text',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            }}
          >
            {command}
          </code>

          {/* 복구 — type the command into THIS pane (no auto-Enter). */}
          <button
            onClick={onRecover}
            title={t('resume.tooltip')}
            style={{
              alignSelf: 'flex-start',
              padding: '2px 10px',
              font: 'inherit',
              fontWeight: 600,
              color: 'var(--text-main)',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid color-mix(in srgb, var(--accent-cursor) 55%, transparent)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            ↩ {t('resume.label', { agent: agentName })}
          </button>
        </div>
      )}
    </span>
  );
}
