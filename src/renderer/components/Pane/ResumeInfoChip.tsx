import React, { useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { isPaneAgentBusy } from '../../stores/selectors/fleet';
import {
  type ResumeBinding,
  permissionFlagFor,
  resumeGrammarFor,
} from '../../../shared/agentResume';

/**
 * Assemble the resume command for a pane from its binding + LIVE cwd
 * candidates. Mirrors the reboot-recovery pill's gates (Pane.tsx) so the two
 * never diverge:
 *   - exact form (`--resume <id>` + the recorded permission flag) ONLY when the
 *     binding's origin cwd still matches one of the pane's cwd candidates
 *     (`--resume` is cwd-scoped); the permission flag rides the SAME line
 *     (both must land together);
 *   - otherwise the cwd-relative fallback (Claude `--continue` / Codex
 *     `resume --last`), which carries no recorded mode.
 *
 * Why candidates, not a single cwd (2026-07-21, live-observed): surface.cwd is
 * the SHELL's tracked cwd and goes stale across `cd X; claude` one-liners (no
 * prompt render → no OSC 7) — the shell truly sat in the binding's cwd, yet the
 * gate compared against the stale value and wrongly downgraded a legitimate
 * exact resume to `--continue` (dropping the permission flag with it). The
 * workspace's hook-reported agent cwd (metadata.cwd) is the second candidate.
 * A false positive types a `--resume` that claude rejects visibly (nothing
 * auto-runs — the user presses Enter); a false negative silently resumes the
 * WRONG conversation. Loud beats silent.
 *
 * Returns `null` for a non-resumable agent (no grammar). Pure + exported so the
 * exact-vs-fallback decision is unit-testable without rendering.
 */
export function buildPaneResumeCommand(
  binding: ResumeBinding,
  paneCwds: ReadonlyArray<string | undefined>,
): { command: string; exact: boolean } | null {
  const grammar = resumeGrammarFor(binding.agent);
  if (!grammar) return null;
  // Lowercase ONLY a leading Windows drive letter; POSIX stays case-sensitive.
  const normCwd = (p: string | undefined): string => {
    let out = (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };
  const target = normCwd(binding.cwd);
  const exact = paneCwds.some((c) => !!c && normCwd(c) === target);
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
  /** Live cwd candidates for the cwd-match re-guard, in trust order:
   *  surface.cwd (OSC 7-tracked shell cwd), then the workspace's hook-reported
   *  agent cwd (metadata.cwd) — see buildPaneResumeCommand. */
  paneCwds: ReadonlyArray<string | undefined>;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const built = buildPaneResumeCommand(binding, paneCwds);
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

/**
 * Subscription boundary for the persistent resume chip's "is this pane's agent
 * busy?" gate. This exists purely to keep the store-wide `agentClockMs` decay
 * clock OUT of the Pane body.
 *
 * `useAgentActivityClock` bumps `agentClockMs` ~every 2 s while ANY agent is
 * active. Pane used to subscribe to it directly to recompute `isPaneAgentBusy`
 * — so at N mounted panes a single active agent re-ran ALL N Pane bodies every
 * tick, even though the busy flag only ever gates THIS chip. The subscription
 * lives here now: Pane mounts this leaf only for a pane that actually carries a
 * resume binding, and a clock tick re-renders just this tiny gate, never the
 * Pane body. A pane with no binding never mounts the leaf → zero work per tick.
 *
 * Busy semantics are unchanged (isPaneAgentBusy): typing a resume command into
 * a LIVE agent TUI would land in the agent's input, not a shell, so the chip
 * stays hidden until the agent has settled or exited.
 */
export function ResumeInfoChipGate(props: {
  ptyId: string;
  binding: ResumeBinding;
  paneCwds: ReadonlyArray<string | undefined>;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds } = props;
  // The reactive decay clock — subscribing HERE (not in Pane) is the whole point.
  const agentClockMs = useStore((s) => s.agentClockMs);
  const activityAt = useStore((s) => s.surfaceActivityAt[ptyId] ?? 0);
  const status = useStore((s) => s.surfaceAgentStatus[ptyId]);
  // OSC 133 authoritative shell state (undefined = shell integration off →
  // heuristic fallback inside isPaneAgentBusy).
  const commandRunning = useStore((s) => s.commandRunningByPtyId[ptyId]);
  const agentBusy = isPaneAgentBusy({ activityAt, agentClockMs, status, commandRunning });
  if (agentBusy) return null;
  return <ResumeInfoChip ptyId={ptyId} binding={binding} paneCwds={paneCwds} />;
}
