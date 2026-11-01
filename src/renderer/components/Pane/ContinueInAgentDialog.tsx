// Pane menu → "Continue in another agent…": a pane's work goes on in another
// agent at any time, not only at a usage limit. The same path as the
// usage-limit card's section (utils/continueInAgent.ts): one button per other
// agent that is installed and signed in opens it in a new tab of this pane
// with the handoff note typed in, never sent; this tab keeps its session.
// The note is previewed here with its length, and an unsent draft goes along
// only when the owner ticks it.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { agentRow } from '../../../shared/agentIdentity';
import { refreshAgentStatus, useAgentSetup } from '../../utils/agentSetupRuns';
import { continueInAgent, handoffFacts } from '../../utils/continueInAgent';
import { handoffNoteText, type HandoffFacts } from '../../utils/handoffNote';
import { IconRobot } from '../icons';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import HandoffNotePreview from './HandoffNotePreview';
import type { PaneActionItem } from './PaneActionsMenu';

export const PANE_CONTINUE_IN_AGENT_KEY = 'continue-in-agent';

const NO_FACTS: HandoffFacts = { requests: [], reply: null, filesTouched: [], planFiles: [], repo: null, branch: null, files: [], transcriptPath: null, draft: null };

/** The pane menu's entry, for a terminal whose agent wmux knows. Which other
 *  agents can take over is asked when the dialog opens, so the entry does not
 *  come and go with that probe. */
export function usePaneContinueInAgent(opts: {
  ptyId: string | undefined;
  /** False for a read-only mirror, whose ptyIds are not this main's panes. */
  allowed: boolean;
  onOpen: () => void;
}): PaneActionItem[] {
  const { ptyId, allowed, onOpen } = opts;
  const t = useT();
  const known = useStore((s) => (ptyId ? !!agentRow(s.surfaceAgent[ptyId]?.slug) : false));
  return useMemo(() => (allowed && known ? [{
    key: PANE_CONTINUE_IN_AGENT_KEY,
    label: t('pane.continueInAgent'),
    title: t('usageLimit.continueInAgentHint'),
    icon: <IconRobot size={14} />,
    onSelect: onOpen,
  }] : []), [allowed, known, onOpen, t]);
}

export default function ContinueInAgentDialog({ ptyId, workspaceId, paneId, cwd, onClose }: {
  ptyId: string;
  workspaceId: string;
  paneId: string;
  cwd?: string;
  onClose: () => void;
}) {
  const t = useT();
  const setup = useAgentSetup();
  const slug = useStore((s) => s.surfaceAgent[ptyId]?.slug);
  const [facts, setFacts] = useState<HandoffFacts | null>(null);
  const [carryDraft, setCarryDraft] = useState(false);

  // Asked again on every open: an agent installed or signed in since the last
  // probe is offered. The last answer shows meanwhile.
  useEffect(() => { void refreshAgentStatus(); }, []);
  // Gathered on open, so the note previewed is the one typed in. Unreadable
  // facts still give a note (who and where), so the buttons never stay off.
  useEffect(() => {
    let live = true;
    void handoffFacts(ptyId, cwd).then((f) => { if (live) setFacts(f); }, () => { if (live) setFacts(NO_FACTS); });
    return () => { live = false; };
  }, [ptyId, cwd]);

  const fromAgent = (slug && agentRow(slug)?.display) || slug || '';
  const targets = (setup.statuses ?? []).filter((s) => s.readiness === 'ready' && s.agent !== slug);
  const note = facts ? handoffNoteText(fromAgent, facts, { carryDraft }) : undefined;

  return (
    <Dialog onClose={onClose} width={400} data-testid="continue-in-agent-dialog">
      <DialogHeader title={t('usageLimit.continueInAgentTitle')} description={t('handoff.dialogDescription')} closeLabel={t('handoff.close')} />
      <DialogBody className="flex flex-col gap-3">
        {targets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {targets.map((s) => (
              <Button
                key={s.agent}
                size="sm"
                variant="secondary"
                // Not before the note is previewed: the owner sees it, and chooses the draft, first.
                disabled={note === undefined}
                title={t('usageLimit.continueInAgentHint')}
                onClick={() => {
                  void continueInAgent({ heldPtyId: ptyId, fromAgent, agent: s.agent, workspaceId, paneId, ...(cwd ? { cwd } : {}), ...(note ? { note } : {}) })
                    .catch((err: unknown) => { console.warn('[handoff] continue in agent failed', err); });
                  onClose();
                }}
                data-continue-in-agent={s.agent}
              >
                {agentRow(s.agent)?.display ?? s.agent}
              </Button>
            ))}
          </div>
        )}
        {setup.statuses && !setup.checking && targets.length === 0 && (
          <p className="text-[12px] text-[var(--text-sub)]" data-continue-in-agent-none>{t('handoff.noAgent')}</p>
        )}
        {facts?.draft && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
            <Checkbox checked={carryDraft} onCheckedChange={setCarryDraft} data-continue-in-agent-action="carry-draft" />
            {t('usageLimit.carryDraft')}
          </label>
        )}
        {note !== undefined && <HandoffNotePreview note={note} />}
      </DialogBody>
    </Dialog>
  );
}
