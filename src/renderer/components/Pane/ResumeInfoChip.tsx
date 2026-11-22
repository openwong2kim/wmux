import React, { useState } from 'react';
import { notePaneFenceError, notePaneFenceResult } from '../../utils/paneFence';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { isPaneAgentBusy } from '../../stores/selectors/fleet';
import {
  type ResumeBinding,
  agentSupportsPermissionFlag,
  defaultResumeSkipPermissions,
  resumeGrammarFor,
  resumePermissionFlag,
} from '../../../shared/agentResume';
import { applyRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';
import { CHATV2_PROVIDER_SESSION_ID } from '../../../shared/chatv2/ipc';
import { inResumeCwd, resumeCwdUsable, type ResumeShell } from '../../../shared/resumeShell';
import { toastFolderTrustLaunchRefusal } from '../../utils/folderTrustLaunchToast';

/**
 * Assemble the resume command for a pane from its binding + LIVE cwd
 * candidates. Mirrors the reboot-recovery pill's gates (Pane.tsx) so the two
 * never diverge:
 *   - exact form (`--resume <id>` + the recorded permission flag) ONLY when the
 *     binding's origin cwd still matches one of the pane's cwd candidates
 *     (`--resume` is cwd-scoped); the permission flag rides the SAME line
 *     (both must land together);
 *   - otherwise the agent's session picker (Claude `--resume` / Codex
 *     `resume`), which carries no recorded mode. Never the cwd-relative
 *     `--continue` / `resume --last`: several panes can share a folder, and
 *     each would reopen the same newest conversation (#1946).
 *
 * Why candidates, not a single cwd (2026-07-21, live-observed): surface.cwd is
 * the SHELL's tracked cwd and goes stale across `cd X; claude` one-liners (no
 * prompt render → no OSC 7) — the shell truly sat in the binding's cwd, yet the
 * gate compared against the stale value and wrongly downgraded a legitimate
 * exact resume to the fallback (dropping the permission flag with it). The
 * workspace's hook-reported agent cwd (metadata.cwd) is the second candidate.
 * A false positive types a `--resume` that claude rejects visibly (nothing
 * auto-runs — the user presses Enter); a false negative silently resumes the
 * WRONG conversation. Loud beats silent. (Since #1946 a false negative opens
 * the picker instead, which is no longer silent but still costs a choice.)
 *
 * `skipPermissions` (the pane toggle) forces `--dangerously-skip-permissions`
 * for Claude on an EXACT resume; when off, the captured permission mode
 * (acceptEdits/plan) is restored if any, and a captured bypassPermissions is
 * not. #1916: the session picker never carries a permission flag — the user
 * may pick any conversation in the folder, which may be unrelated to this
 * pane, so bypass requires an exact binding
 * (resumePermissionFlag). Codex takes no permission flag, so the toggle is inert
 * there.
 *
 * A role binding's `skipPermissions` does NOT override an explicit OFF: when the
 * toggle is offered (Claude) and off, the role's skip flag is withheld (and
 * dropped from the role's args, #1681), so the restored mode is what runs (`--dangerously-skip-permissions` beats
 * `--permission-mode` on the same line). The role's model, effort and args still
 * apply. Where the toggle is inert (Codex) the role's skip flag applies as usual
 * on an exact resume. On the picker it is withheld for every agent (#1916).
 *
 * Returns `null` for a non-resumable agent (no grammar). Pure + exported so the
 * exact-vs-fallback decision is unit-testable without rendering.
 */
export function buildPaneResumeCommand(
  binding: ResumeBinding,
  paneCwds: ReadonlyArray<string | undefined>,
  skipPermissions: boolean,
  roleBinding?: RoleBinding,
  exactOverride?: boolean,
): { command: string; exact: boolean; roleRewritten: boolean } | null {
  const grammar = resumeGrammarFor(binding.agent);
  if (!grammar) return null;
  // Lowercase ONLY a leading Windows drive letter; POSIX stays case-sensitive.
  const normCwd = (p: string | undefined): string => {
    let out = (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };
  const target = normCwd(binding.cwd);
  // #1342 — a REMOTE pane's cwds live on another machine, so the desktop cannot
  // run this comparison at all; the host answers the question instead and the
  // caller passes its verdict through. Local callers leave it undefined.
  // A folder the daemon reports gone is never resumed, even when a pane cwd
  // still names it (a stale surface or hook cwd).
  const exact = exactOverride ?? (binding.cwdMissing !== true && paneCwds.some((c) => !!c && normCwd(c) === target));
  // #1916: a permission flag only on an EXACT resume. Toggle on → bypass;
  // toggle off → the captured mode, never a captured bypass. The session
  // picker carries none.
  const permFlag = resumePermissionFlag({
    agent: binding.agent,
    exact,
    recordedMode: binding.permissionMode,
    skipPermissions,
  });
  const resumeArg = exact ? grammar.withId(binding.sessionId) : grammar.picker;
  const base = `${binding.agent}${permFlag ? ` ${permFlag}` : ''} ${resumeArg}`;
  // D2 — re-assert the role's enforced model on resume. The reconstruction above
  // rebuilds from the agent stem + resume/permission flags only, so a bound
  // model would silently drop; applyRoleBinding re-injects it (unless the
  // operator already put an explicit --model on the line).
  // `roleRewritten` is reported rather than logged here so this stays a pure
  // function (it runs on every render of the chip); the caller emits the audit
  // line once, from an effect.
  // The picker line withholds the role's skip flag and the permission choices
  // in its args, for every agent (#1916).
  const toggledOff = !exact || (agentSupportsPermissionFlag(binding.agent) && !skipPermissions);
  const rewrite = applyRoleBinding(base, roleBinding, {
    suppressSkipPermissions: toggledOff,
    suppressPermissionChoices: !exact,
  });
  return { command: rewrite.command, exact, roleRewritten: rewrite.changed };
}

/**
 * The grammar a copied lost-folder resume line is written in, or null when the
 * pane's shell reads neither (cmd.exe, nushell, fish), so no line that would
 * fail there is offered. Mirrors the daemon's bound-resume shell check. An
 * empty shell is the platform default, a POSIX shell off Windows.
 */
export function lostFolderShell(platform: string | undefined, shell: string | undefined): ResumeShell | null {
  if (platform !== 'win32') {
    const leaf = (shell ?? '').split(/[\\/]/).pop() ?? '';
    return !leaf || /^-?(?:zsh|bash|sh)$/.test(leaf) ? 'posix' : null;
  }
  return /pwsh|powershell/i.test(shell ?? '') ? 'pwsh' : null;
}

/**
 * The line for a conversation whose folder is gone (`cwdMissing`): change to
 * that folder, then resume exactly that id. It is copied, never typed, and
 * runs once the folder is back. Null when the id, the folder or the shell
 * fails its check: the notice then names the folder and the UUID only.
 *
 * The pane's role binding applies as on an exact resume with the skip toggle
 * off (the copied line has no toggle), and to the agent invocation before the
 * folder change is prefixed, so its agent-stem gate reads the launch itself.
 */
export function lostFolderResumeCommand(
  binding: ResumeBinding,
  shell: ResumeShell | null,
  roleBinding?: RoleBinding,
): string | null {
  const grammar = resumeGrammarFor(binding.agent);
  if (!grammar || !shell || !CHATV2_PROVIDER_SESSION_ID.test(binding.sessionId)) return null;
  const exact = grammar.withId(binding.sessionId);
  if (exact === grammar.picker || !resumeCwdUsable(binding.cwd, shell)) return null;
  const line = applyRoleBinding(`${binding.agent} ${exact}`, roleBinding, {
    suppressSkipPermissions: agentSupportsPermissionFlag(binding.agent),
    suppressPermissionChoices: false,
  }).command;
  return inResumeCwd(binding.cwd, line, shell);
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
  /** #1342 — host verdict for a remote pane's cwd match (see
   *  buildPaneResumeCommand). Undefined for a local pane. */
  exactOverride?: boolean;
  /** #1342 — where the assembled command goes. Undefined = this pane's local
   *  PTY. A remote-terminal surface has no local PTY, so it supplies the
   *  remote input path instead. */
  onSend?: (command: string) => void;
  /** Live cwd candidates for the cwd-match re-guard, in trust order:
   *  surface.cwd (OSC 7-tracked shell cwd), then the workspace's hook-reported
   *  agent cwd (metadata.cwd) — see buildPaneResumeCommand. */
  paneCwds: ReadonlyArray<string | undefined>;
  /** D2 — the pane's enforced role→model binding (re-asserted on resume). */
  roleBinding?: RoleBinding;
  /** D2 — the role name that supplied `roleBinding`, for the audit log. */
  role?: string;
  /** The pane's shell, for the lost-folder line's grammar (lostFolderShell). */
  shell?: string;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds, roleBinding, role, exactOverride, onSend, shell } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  // #1916: holds only the user's explicit choice. Until they make one, the
  // toggle is on only for an exact resume of a session recorded in
  // bypassPermissions mode. Claude-only (Codex has no such flag), and not
  // offered on the session picker line, which never carries the flag.
  const [skipOverride, setSkipOverride] = useState<boolean | undefined>(undefined);
  // The exact-vs-fallback decision does not depend on the toggle.
  const probe = buildPaneResumeCommand(binding, paneCwds, false, roleBinding, exactOverride);
  if (!probe) return null; // not a resumable agent — nothing to offer
  const skipPermissions = skipOverride ?? defaultResumeSkipPermissions(binding.permissionMode, probe.exact);
  const canSkipPermissions = agentSupportsPermissionFlag(binding.agent) && probe.exact;
  const built = skipPermissions
    ? buildPaneResumeCommand(binding, paneCwds, true, roleBinding, exactOverride) ?? probe
    : probe;
  const { command } = built;

  const agentName = binding.agent.charAt(0).toUpperCase() + binding.agent.slice(1);
  // The conversation's folder is gone: the picker would open somewhere that
  // cannot list it, so the panel names the folder and offers the exact line to
  // copy instead. A remote pane's folder is the host's to judge, so not there.
  const lostFolder = !built.exact && binding.cwdMissing === true && exactOverride === undefined;
  const lostCommand = lostFolder
    ? lostFolderResumeCommand(binding, lostFolderShell(window.electronAPI.platform, shell), roleBinding)
    : null;

  const onRecover = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (built.roleRewritten) {
      // Audit trail — a role silently changed what this chip types. Logged at
      // the ACTION (not while building the preview) so it fires once per use.
      console.log('[wmux:role-binding] resume command rewritten', {
        role,
        agent: binding.agent,
        after: command,
      });
    }
    // No trailing \r — the user presses Enter to run (D6: bypass is re-granted
    // only by an explicit keystroke, never automatically).
    if (onSend) onSend(command);
    else {
      window.electronAPI.pty.writeLaunch(ptyId, command, false, 'human').then((res: unknown) => notePaneFenceResult(ptyId, res), (err: unknown) => {
        console.warn('[wmux:resume] the resume line was not typed', String(err));
        notePaneFenceError(ptyId, err);
        toastFolderTrustLaunchRefusal(err);
      });
    }
    setOpen(false);
  };

  const copyText = (text: string, setFlag: (v: boolean) => void) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setFlag(true);
        window.setTimeout(() => setFlag(false), 1200);
      },
      () => { /* clipboard blocked — leave the text visible to select manually */ },
    );
  };
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(binding.sessionId, setCopied);
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
                background: 'color-mix(in srgb, var(--text-main) 6%, transparent)',
                border: '1px solid var(--border-soft)',
                borderRadius: 3,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {/* Skip-permissions toggle (Claude only, exact resume only, #1916).
              Starts at the recorded mode. Forces --dangerously-skip-permissions
              onto the resume line; the preview below updates live as it
              toggles. */}
          {canSkipPermissions && (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                color: 'var(--text-sub)',
                userSelect: 'none',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={skipPermissions}
                onChange={(e) => setSkipOverride(e.target.checked)}
                style={{ accentColor: 'var(--accent-cursor)', cursor: 'pointer', margin: 0 }}
              />
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>--dangerously-skip-permissions</span>
            </label>
          )}

          {/* Exact command preview — WYSIWYG with what 복구 types (or, for a
              lost folder, with what Copy copies). */}
          {(!lostFolder || lostCommand) && <code
            style={{
              display: 'block',
              padding: '4px 6px',
              color: 'var(--text-sub)',
              backgroundColor: 'var(--bg-base)',
              border: '1px solid var(--border-soft)',
              borderRadius: 3,
              userSelect: 'text',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            }}
          >
            {lostFolder ? lostCommand : command}
          </code>}
          {/* #1916: the folder the line runs in (the shell's tracked cwd).
              A remote pane passes no local cwd, so nothing is shown there. */}
          {paneCwds[0] && !lostFolder && (
            <span style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
              {t('resume.runsIn', { cwd: paneCwds[0] })}
            </span>
          )}
          {lostFolder && (
            <span style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
              {t('resume.folderGone', { agent: agentName, id: binding.sessionId.slice(0, 8), cwd: binding.cwd })}
            </span>
          )}
          {!built.exact && !lostFolder && (
            <span style={{ color: 'var(--text-muted)' }}>{t('resume.pickerNote')}</span>
          )}

          {/* A lost folder: copy the line, never type it (it runs only once
              the folder is back), and no picker. */}
          {lostFolder && lostCommand && (
            <button
              onClick={(e) => { e.stopPropagation(); copyText(lostCommand, setCommandCopied); }}
              title={t('resume.copyCommandTooltip')}
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
              {commandCopied ? `✓ ${t('common.copied')}` : `⧉ ${t('resume.copyCommand')}`}
            </button>
          )}

          {/* 복구 — type the command into THIS pane (no auto-Enter). */}
          {!lostFolder && <button
            onClick={onRecover}
            title={built.exact ? t('resume.tooltip') : t('resume.pickTooltip')}
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
            ↩ {built.exact
              ? t('resume.label', { agent: agentName })
              : t('resume.pickLabel', { agent: agentName })}
          </button>}
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
  roleBinding?: RoleBinding;
  role?: string;
  shell?: string;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds, roleBinding, role, shell } = props;
  // The reactive decay clock — subscribing HERE (not in Pane) is the whole point.
  const agentClockMs = useStore((s) => s.agentClockMs);
  const activityAt = useStore((s) => s.surfaceActivityAt[ptyId] ?? 0);
  const status = useStore((s) => s.surfaceAgentStatus[ptyId]);
  // OSC 133 authoritative shell state (undefined = shell integration off →
  // process-truth tier, then heuristic fallback inside isPaneAgentBusy).
  const commandRunning = useStore((s) => s.commandRunningByPtyId[ptyId]);
  // Process-truth agent liveness (daemon AgentProcessTracker) — the edge
  // trigger that keeps the chip hidden while a QUIET agent is still alive on
  // a pane without shell integration, and lets it appear on the exit edge.
  const agentProcessAlive = useStore((s) => s.agentAliveByPtyId[ptyId]);
  // The hook's turn latch. Without it a governed pane's quiet turn (no byte
  // output for two minutes) would decay out of the heuristic tier and pop the
  // chip over a live agent's TUI, which is precisely what the chip must not do.
  const turnOpen = useStore((s) => (s.surfaceTurnOpenAt[ptyId] ?? 0) > 0);
  const agentBusy = isPaneAgentBusy({ activityAt, agentClockMs, status, commandRunning, agentProcessAlive, turnOpen });
  if (agentBusy) return null;
  return (
    <ResumeInfoChip
      // A new conversation in this pane starts from its own recorded mode,
      // not from a toggle choice made for the previous one (#1916).
      key={binding.sessionId}
      ptyId={ptyId}
      binding={binding}
      paneCwds={paneCwds}
      roleBinding={roleBinding}
      role={role}
      shell={shell}
    />
  );
}
