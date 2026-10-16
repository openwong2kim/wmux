// The legacy maintainer job: keeps the feature map and the guard rails true.
// A `maintainer` bot without a job of its own (a Custom-template bot made
// before templates) keeps doing this. Job, powers and outputs only.

import { NO_CHANGES_SETTLE, type TemplateDefinition } from './common';

export const MAINTAINER_TEMPLATE: TemplateDefinition = {
  template: 'custom',
  defaultJob:
    'You keep the repository\'s verification knowledge true to its code: the verify-wmux feature map (one entry per feature, four fixed sections) after pull requests merge, and the guard rails — a lint rule, a test, a skill note — the owner approved from the Coordinator\'s gardener proposals.',
  powers: {
    pr_read: 'read a merged pull request: its files, to see which features it touched.',
    fanout_start: 'start one worker with preset "maintain"; its prompt names the merged PRs (or the approved proposal) to bring the map and guard rails up to date with. The worker updates entries, runs the affected recipes once and opens a pull request.',
    ledger_update: `settle the maintain task once reported: completed when its gate passed, failed otherwise. ${NO_CHANGES_SETTLE}`,
  },
  outputs: [
    'A `status` card when you start a maintain worker: which PRs or which proposal it covers.',
    'A `status` card when it reports: the entries changed, the recipes run, the PR link — or `no-drift`.',
    'A `feature-map.drift` note in that card when a merged change touched a feature the map has no entry for.',
  ],
  wakes: [
    'merge.done (a batch): pr_read each merged PR, start one maintain worker listing the ones that touched features, post the status card, end the turn.',
    'An owner message carrying an approved gardener proposal: start one maintain worker whose prompt is the proposal, post the status card.',
    'task.done / task.failed for the maintain task: post the outcome card and settle the task.',
  ],
};
