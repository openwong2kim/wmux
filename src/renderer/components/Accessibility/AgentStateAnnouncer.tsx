// ─── Agent state, spoken ─────────────────────────────────────────────────────
//
// For screen-reader users only: a visually hidden polite live region that says
// when a pane's agent needs you, finished or stopped with an error. Nothing is
// rendered while no screen reader is on. The pane state is the sidebar
// roster's (selectWorkspaceAgentRoster), so what is said matches what the
// sidebar shows; utils/agentAnnouncements.ts decides what to say and how often.

import { useEffect, useState } from 'react';
import { useStore, type StoreState } from '../../stores';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { paneTag } from '../../utils/paneNaming';
import { useScreenReaderOn } from '../../utils/screenReader';
import {
  diffAgentStates,
  EMPTY_RATE_STATE,
  rateLimitAnnouncements,
  type AgentAnnouncement,
  type AgentAnnouncementKind,
  type AgentPaneState,
} from '../../utils/agentAnnouncements';
import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n/locales/en';

const LINE_KEYS: Record<AgentAnnouncementKind, TranslationKey> = {
  needsYou: 'a11y.agent.needsYou',
  finished: 'a11y.agent.finished',
  error: 'a11y.agent.error',
};

function announcementLine(a: AgentAnnouncement): string {
  return t(LINE_KEYS[a.kind], { tag: a.tag, agent: a.agent });
}

/** Every agent row of every workspace, with the pane tag the sidebar shows. */
export function selectAgentPaneStates(state: StoreState): AgentPaneState[] {
  const out: AgentPaneState[] = [];
  for (const ws of state.workspaces) {
    const leaves = new Map(getWorkspaceLeafPanes(ws).map((leaf) => [leaf.id, leaf]));
    for (const row of selectWorkspaceAgentRoster(state, ws.id).rows) {
      const leaf = leaves.get(row.paneId);
      if (!leaf) continue;
      out.push({ ptyId: row.ptyId, tag: paneTag(ws, leaf), agent: row.agentName, agentStatus: row.status });
    }
  }
  return out;
}

function AnnouncerRegion() {
  const [text, setText] = useState('');

  useEffect(() => {
    let prev: AgentPaneState[] | null = null;
    let rate = EMPTY_RATE_STATE;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A live region speaks when its text changes, so the same line twice in a
    // row would be said once. Every other announcement carries a trailing
    // no-break space to make it new text.
    let odd = false;

    const step = (lines: string[]) => {
      const result = rateLimitAnnouncements(rate, lines, Date.now());
      rate = result.state;
      if (result.announce !== null) {
        odd = !odd;
        setText(odd ? result.announce : `${result.announce}\u00a0`);
      }
      if (result.retryInMs !== null && timer === null) {
        timer = setTimeout(() => {
          timer = null;
          step([]);
        }, result.retryInMs);
      }
    };

    const check = (state: StoreState) => {
      const next = selectAgentPaneStates(state);
      const lines = diffAgentStates(prev, next).map(announcementLine);
      prev = next;
      if (lines.length > 0) step(lines);
    };

    check(useStore.getState());
    const unsubscribe = useStore.subscribe(check);
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" className="sr-only" data-agent-state-announcer>
      {text}
    </div>
  );
}

export default function AgentStateAnnouncer() {
  return useScreenReaderOn() ? <AnnouncerRegion /> : null;
}
