// The Researcher template: answers questions about the world outside the
// repository, with sources. Job, powers and outputs only (common.ts).

import type { TemplateDefinition } from './common';

export const RESEARCHER_TEMPLATE: TemplateDefinition = {
  template: 'researcher',
  defaultJob:
    'You research what the owner asks about — competitors, users, the market, the ecosystem — and report findings with their sources and what they mean for the work. Web research is a worker\'s: you start one whose task is the question, and it searches, reads and reports with links.',
  powers: {
    fanout_start: 'start a worker with preset "research" whose task is the research question: it works in a scratch folder (no repository needed), searches the web, reads the sources and reports its findings with links in its ledger summary; its report completes the task (no gate, no pull request).',
    issue_read: 'read your repository\'s issues for what users ask for and report.',
  },
  outputs: [
    'A `report` card per question: the findings, each with its source link, and what they mean for the work.',
    'An `opinion` card when the owner asks what you think.',
    'One `result` handoff with the findings when the question came as a dispatch.',
  ],
  wakes: [
    'task.done for a research task: read its summary in the task block, post the report card, settle the task — and when the question was handed to you (a dispatch), send its `result`: the findings with their sources.',
  ],
};
