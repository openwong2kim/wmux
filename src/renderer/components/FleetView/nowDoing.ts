import type { FleetRow } from '../../stores/selectors/fleet';
import { parseActivity } from '../../../shared/activityVerb';
import { flattenAgentText } from '../../../shared/assistantPreview';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "✎ foo.ts" → "Edited foo.ts"; an empty line → ''. */
export function activitySentence(summary: string | undefined, t: T): string {
  const parsed = parseActivity(summary);
  return parsed ? t(`fleet.now.${parsed.verb}`, { target: parsed.target }) : '';
}

export interface NowDoingLine {
  text: string;
  /** now = the running tool, last = the last tool of a finished turn,
   *  question / reply = the agent's own words, status = a fixed label. */
  kind: 'now' | 'last' | 'question' | 'reply' | 'status';
}

/**
 * The row's one readable line. A question always wins (it is why the row
 * needs you). A running agent says what it is doing; anything else says what
 * it did last, then falls back to its last reply (agents that send no tool
 * activity), then to the section's label. Error, stopped and unconfirmed rows
 * keep their label: it is the more urgent fact.
 */
export function nowDoingLine(row: FleetRow, lastActivity: string | undefined, t: T): NowDoingLine {
  if (row.detailSource === 'question' && row.detail) return { text: row.detail, kind: 'question' };
  const status = row.detailKey === 'fleet.detail.error' || row.detailKey === 'fleet.detail.unconfirmed'
    || row.detailKey === 'fleet.detail.supervisionStopped';
  if (!status) {
    if (row.detailSource === 'activity') {
      const now = activitySentence(row.detail, t);
      if (now) return { text: now, kind: 'now' };
    }
    if (row.pane.agentStatus !== 'running' && row.pane.surfaceType === 'terminal') {
      const last = activitySentence(flattenAgentText(lastActivity ?? ''), t);
      if (last) return { text: t('fleet.now.last', { text: last }), kind: 'last' };
    }
    if (row.detailSource === 'lastMessage' && row.detail) return { text: row.detail, kind: 'reply' };
  }
  return { text: t(row.detailKey), kind: 'status' };
}
