// ─── Command Deck — fleet recovery greeting (P3b) ───────────────────────────
//
// After an OS reboot the daemon replays every pane's SHELL, but the agents that
// were running inside them are gone — each recovered pane gets a per-pane
// resume pill. P3b adds the fleet-level affordance: a greeting card in the
// Commander thread ("N agent panes can be recovered — recover the fleet?")
// whose button sends ONE canned prompt to the brain, which then types the
// resume command into every recovered pane via terminal_send and reports back.
//
// Policy split (substrate neutrality): wmux only computes the FACTS — which
// panes are recoverable and the exact resume command each one needs (the same
// gates the pill applies: resumable grammar, agent↔binding match, cwd match).
// The exact-session form also restores the RECORDED permission mode (e.g.
// `--dangerously-skip-permissions`) — without it a bypass-mode fleet comes back
// stuck on prompts, which isn't a recovery. D6 ("permission restore only on
// explicit user intent") is satisfied by the card's button click / the typed
// recovery request — both are the human explicitly asking for their fleet
// back as it was. Executing and narrating the recovery is the brain's job,
// through the same terminal_send any agent gets. There is no deterministic
// "recover all" engine in app code.
//
// Pure + store-free so every piece is unit-testable with plain objects.

import type { Workspace } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import {
  type ResumeBinding,
  normalizeResumeCwd,
  permissionFlagFor,
  resumeGrammarFor,
} from '../../../shared/agentResume';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';

/** One recoverable pane: everything the brain needs to bring its agent back. */
export interface RecoveryPane {
  ptyId: string;
  /** Coordinate auto-name (e.g. `2.1-claude`) — how the fleet context and the
   *  human refer to the pane. */
  autoName: string;
  /** User label when set (display only). */
  label: string;
  workspaceName: string;
  agent: string;
  /** The exact shell command to type into the pane. The exact-session form
   *  includes the binding's recorded permission-mode flag (the button click /
   *  typed request is the explicit user intent D6 requires). */
  command: string;
  /** Whether the command resumes the EXACT origin conversation (`--resume <id>`)
   *  or falls back to the cwd-relative form (`--continue` / `resume --last`). */
  exact: boolean;
}

/**
 * Join the resume hints (per-ptyId agent slug) against the live workspace tree
 * and produce the recoverable-pane list. Mirrors the pill's gates:
 *   - the agent must have a resume grammar (non-resumable agents are excluded
 *     daemon-side already; re-checked here defensively);
 *   - the pane's recovered PTY must have emitted its first data
 *     (`ptyReadyByPtyId`) — the pill waits for the same signal before typing,
 *     because a write into a not-yet-interactive recovered pipe is silently
 *     lost (EI6 / codex P2). The map is reactive, so a not-ready pane simply
 *     appears on the card once it comes up.
 *   - the exact-session form additionally requires the binding to be for the
 *     SAME agent and the pane's live cwd to still match the binding's origin
 *     cwd (`--resume` is cwd-scoped) — otherwise the cwd-relative fallback.
 * Panes whose ptyId no longer maps to a live pane are skipped.
 */
export function buildRecoveryPanes(args: {
  resumeHintByPtyId: Record<string, AgentSlug>;
  resumeBindingByPtyId: Record<string, ResumeBinding>;
  ptyReadyByPtyId: Record<string, true>;
  workspaces: Workspace[];
  paneLabel: Record<string, string>;
}): RecoveryPane[] {
  const { resumeHintByPtyId, resumeBindingByPtyId, ptyReadyByPtyId, workspaces, paneLabel } = args;
  const hintPtyIds = Object.keys(resumeHintByPtyId);
  if (hintPtyIds.length === 0) return [];

  const out: RecoveryPane[] = [];
  for (const w of workspaces) {
    const wsOrdinal = w.wsOrdinal ?? 0;
    for (const leaf of findLeafPanes(w.rootPane)) {
      for (const surface of leaf.surfaces) {
        const ptyId = surface.ptyId;
        if (!ptyId) continue;
        const agent = resumeHintByPtyId[ptyId];
        if (!agent) continue;
        if (!ptyReadyByPtyId[ptyId]) continue; // recovered pipe not writable yet (EI6)
        const grammar = resumeGrammarFor(agent);
        if (!grammar) continue; // not resumable — hint shouldn't exist (defensive)

        const binding = resumeBindingByPtyId[ptyId];
        const cwdMatches = !!(
          binding &&
          surface.cwd &&
          normalizeResumeCwd(binding.cwd) === normalizeResumeCwd(surface.cwd)
        );
        const exact = cwdMatches && binding?.agent === agent;
        // Exact-session form restores the recorded permission mode on the SAME
        // line as the resume flag (F6 — both must land in one command). The
        // fallback carries no mode: with no trusted binding there is nothing
        // recorded to restore.
        const permFlag = exact ? permissionFlagFor(binding?.permissionMode) : '';
        const command = exact
          ? `${agent}${permFlag ? ` ${permFlag}` : ''} ${grammar.withId(binding.sessionId)}`
          : `${agent} ${grammar.fallback}`;

        const autoName = computePaneAutoName(wsOrdinal, leaf.ordinal ?? 0, agent);
        out.push({
          ptyId,
          autoName,
          label: paneDisplayName(paneLabel[leaf.id], autoName),
          workspaceName: w.name,
          agent,
          command,
          exact,
        });
      }
    }
  }
  return out;
}

/**
 * The canned prompt the greeting card's button sends to the brain (also what a
 * typed "recover the fleet" resolves to, via the fleet-context lines below).
 * Explicit per-pane instructions — the brain executes and narrates, it does
 * not decide the commands.
 */
export function buildRecoveryPrompt(panes: RecoveryPane[]): string {
  const lines = [
    'Recover my fleet after the reboot. For EACH pane below, type its resume',
    'command into it with terminal_send (submit: true), then read the pane with',
    'terminal_read to confirm the agent came back. Run each command EXACTLY as',
    'given — never add or remove flags. When done, summarize per pane: did it',
    'resume, and what was it working on (from its restored conversation).',
    '',
    ...panes.map(
      (p) =>
        `- pane ${p.autoName}${p.label !== p.autoName ? ` ("${p.label}")` : ''} in "${p.workspaceName}" — ptyId ${p.ptyId} — run: ${p.command}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * Extra fleet-context lines (first-turn injection) so a typed "recover the
 * fleet" — without the card's button — still gives the brain the facts.
 */
export function buildRecoveryContextLines(panes: RecoveryPane[]): string {
  if (panes.length === 0) return '';
  return [
    `Reboot recovery: ${panes.length} pane(s) had agents running before the last`,
    'shutdown; each can be brought back by typing its resume command into it',
    '(terminal_send with submit: true, run the command exactly as given):',
    ...panes.map((p) => `- ${p.autoName} — ptyId ${p.ptyId} — ${p.command}`),
  ].join('\n');
}
