// The factory smoke graders, by scenario name, and the scoring rule:
// evidence_complete first (fails → status `error`, the run is a harness
// failure), then the scenario's criteria; the run passes only when every
// criterion passes. A grader that throws on the snapshot fails closed.

import { DEFAULT_REQUIRES, criterion, evidenceComplete } from './common.mjs';
import * as threads from './threads.mjs';
import * as wakes from './wakes.mjs';
import * as handoffs from './handoffs.mjs';
import * as lane from './lane.mjs';
import * as rooms from './rooms.mjs';
import * as content from './content.mjs';
import * as approvals from './approvals.mjs';
import * as group from './group.mjs';
import * as connectors from './connectors.mjs';

export const GRADERS = {
  'reply-in-wake-thread': threads.replyInWakeThread,
  'thread-id-roundtrip': threads.threadIdRoundtrip,
  'cross-thread-isolation': threads.crossThreadIsolation,
  'interleaved-worker-reports': handoffs.interleavedWorkerReports,
  'no-self-wake': wakes.noSelfWake,
  'directed-fact-only-addressee': wakes.directedFactOnlyAddressee,
  'narrative-name-no-wake': wakes.narrativeNameNoWake,
  'callback-exactly-once': handoffs.callbackExactlyOnce,
  'ask-person-question-card': handoffs.askPersonQuestionCard,
  'idempotent-post-retry': wakes.idempotentPostRetry,
  'hop-limit-refusal': handoffs.hopLimitRefusal,
  'human-queued-not-refused': wakes.humanQueued,
  'steer-only-same-thread': wakes.humanQueued,
  'budget-stop': wakes.budgetStop,
  'verifier-lane-fail-closed': lane.verifierLaneFailClosed,
  'stale-head-reverify': lane.staleHeadReverify,
  'room-read-paging': rooms.roomReadPaging,
  'unread-independent': rooms.unreadIndependent,
  'presence-unknown': wakes.presenceUnknown,
  'triage-real-issue': content.triageRealIssue,
  'verifier-real-pr': content.verifierRealPr,
  'moa-morning-report': handoffs.moaMorningReport,
  'moa-morning-report-real': content.moaMorningReportReal,
  'researcher-dispatch-real': content.researcherDispatchReal,
  'lane-ready-card': lane.laneReadyCard,
  'lane-owner-login-trusted': lane.laneReadyCard,
  'human-correction-plan-decline': handoffs.humanCorrectionPlanDecline,
  'interrupted-wake-after-restart': wakes.interruptedAfterRestart,
  'repowatch-baseline-first-poll': lane.repoWatchBaseline,
  'lead-task-system-gate': handoffs.leadTaskSystemGate,
  'research-no-repo-closes': handoffs.researchNoRepoCloses,
  'bot-worker-codex-engine': handoffs.botWorkerCodexEngine,
  'approval-typed-merge': approvals.approvalTypedMerge,
  'approval-needs-owner-words': approvals.approvalNeedsOwnerWords,
  'approval-head-moved': approvals.approvalHeadMoved,
  'approval-rule-next-time': approvals.approvalRuleNextTime,
  'taint-lane-refused': approvals.taintLaneRefused,
  'group-hi-replies': group.groupHiReplies,
  'structured-mention-wakes-target': group.structuredMentionWakesTarget,
  'mention-loop-bounded': group.mentionLoopBounded,
  'routine-create-fire-pause': group.routineCreateFirePause,
  'chat-stop-all': group.chatStopAll,
  'chain-survives-worker': handoffs.chainSurvivesWorker,
  'team-relay-owner-flow': handoffs.teamRelayOwnerFlow,
  'team-relay-limit': handoffs.teamRelayLimit,
  'team-relay-owner-tags-researcher': handoffs.teamRelayOwnerTagsResearcher,
  'taint-relay-lane-refused': approvals.taintRelayLaneRefused,
  'group-chat-wakes-its-members': group.groupChatWakesItsMembers,
  'group-chat-coordinator-takes-it': group.groupChatCoordinatorTakesIt,
  'taint-research-lane-refused': approvals.taintLaneRefused,
  'connector-worker-launch': connectors.connectorWorkerLaunch,
  'connector-off-for-bot-refused': connectors.connectorOffForBotRefused,
  'connector-task-lane-refused': connectors.connectorTaskLaneRefused,
  'connector-codex-worker-launch': connectors.connectorCodexWorkerLaunch,
};

/** `{status: 'pass'|'fail'|'error', criteria}` for one snapshot. */
export function gradeSnapshot(scenario, snap) {
  const expect = scenario?.expect ?? {};
  const complete = evidenceComplete(snap, expect.requires ?? DEFAULT_REQUIRES);
  if (!complete.pass) return { status: 'error', criteria: [complete] };
  const grader = GRADERS[scenario?.name];
  if (!grader) return { status: 'error', criteria: [complete, criterion('grader_exists', false, `no grader for ${scenario?.name}`)] };
  let criteria;
  try {
    criteria = grader(snap, expect);
  } catch (err) {
    criteria = [criterion('evidence_well_formed', false, `grader failed on the snapshot: ${String(err)}`)];
  }
  if (!Array.isArray(criteria) || criteria.length === 0) criteria = [criterion('evidence_well_formed', false, 'grader returned no criteria')];
  return { status: criteria.every((c) => c.pass) ? 'pass' : 'fail', criteria: [complete, ...criteria] };
}
