// Nightly red runs as GitHub issues: the pure parts of scripts/ci-failure-issue.mjs.
//
// runtime.yml and windows.yml run on main (nightly, on push, on demand) and
// gate nothing. A red run used to notify by email only. Now a `report` job
// runs after the test jobs, whatever happened to them, and opens one issue per
// workflow, titled `Nightly red: <workflow>` and labelled `ci-nightly`, or
// comments on it while it is open; the next green run closes it. repoWatch
// turns a new issue into an `issue.opened` fact and the triage bot wakes on it
// (src/main/factory/roleDefaults.ts), so a red night becomes a bot task.
//
// Everything here takes an injected `gh(args) => stdout` runner, so the tests
// drive it with a fake and the command line is the only file that spawns.
//
// The issue body is plain data from fixed templates: the run URL, the event,
// the commit and the failed job names. Never log text: a log can carry
// anything a test printed, and the issue is read by a bot.
//
// Why a job of its own and not a last step in each test job: a step cannot
// report a job that timed out (the job is gone before `if: failure()` runs),
// and windows.yml's two shards would each report, racing to open the issue
// and to close it. One job after all of them sees every result once. A
// timed-out job reads as `cancelled` in the jobs API; markTimeouts tells it
// from a superseded run by its check-run annotation.
//
// Runs of one workflow still overlap: a push run and the nightly sit in
// separate concurrency groups. A green run closes the issue only when it is
// not older than the newest red run the issue reports (run ids grow with
// creation time; a rerun keeps its id), so an older green run finishing late
// never hides a newer red one, and a green rerun still closes.
//
// GitHub has no lock for read-then-write on an issue, so every write is
// followed by a read that converges on the newest run: a duplicate issue
// hands its report to the oldest and closes; a close that raced a newer red
// comment reopens; a red comment that raced an older green close reopens.
// One window stays open, by choice: an older red run can open an issue just
// after a newer green run's report found none to close (that green run is
// not "completed" yet, so newestGreenRun cannot see it). The cost is a stale
// open issue that the next green run closes; a red result is never lost.

export const LABEL = 'ci-nightly';
export const LABEL_COLOR = 'B60205';
export const LABEL_DESCRIPTION = 'A scheduled or main-branch CI workflow went red';
export const TITLE_PREFIX = 'Nightly red: ';

/** The one issue title per workflow. */
export function issueTitle(workflow) {
  if (!workflow || !String(workflow).trim()) throw new Error('workflow name is required (GITHUB_WORKFLOW)');
  return `${TITLE_PREFIX}${String(workflow).trim()}`;
}

/** The run's page, from the GITHUB_* variables every Actions step gets. */
export function runUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Names of the run's failed jobs, from `gh run view --json jobs`. The report
 * job runs after every other job has finished, so only finished jobs count.
 */
export function failedJobNames(jobsJson) {
  const names = [];
  for (const job of jobsJson?.jobs ?? []) {
    if (job.status === 'completed' && FAILED.has(job.conclusion) && job.name) names.push(String(job.name));
  }
  return [...new Set(names)].sort();
}

/**
 * What the run's finished jobs add up to: 'failure' when one failed or timed
 * out, 'cancelled' when one was cancelled (a newer push superseded the run;
 * nothing to report), else 'success'. The report job itself is the one still
 * in progress and is left out.
 */
export function runOutcome(jobsJson) {
  const done = (jobsJson?.jobs ?? []).filter((job) => job.status === 'completed');
  if (done.some((job) => FAILED.has(job.conclusion))) return 'failure';
  if (done.length === 0 || done.some((job) => job.conclusion === 'cancelled')) return 'cancelled';
  return 'success';
}

function sanitize(value) {
  // Single line, no markdown that could close the code span or ping anyone.
  return String(value ?? '').replace(/[\r\n`@]/g, ' ').trim() || 'unknown';
}

export function renderFailureBody({ url, event, sha, jobs }) {
  const jobLines = jobs.length > 0 ? jobs.map((name) => `- \`${sanitize(name)}\``) : ['- (none reported yet)'];
  return [
    `Run: ${url}`,
    `Event: \`${sanitize(event)}\``,
    `Commit: \`${sanitize(sha)}\``,
    '',
    'Failed jobs:',
    ...jobLines,
    '',
    'Opened by scripts/ci-failure-issue.mjs. The logs are on the run page.',
  ].join('\n');
}

export function renderGreenComment(url) {
  return `green again at ${url}`;
}

/** The newest green run that closed the issue ("green again at <url>"), or 0. */
export function newestClosingRun(issueJson) {
  let newest = 0;
  for (const c of issueJson.comments ?? []) {
    for (const m of (c.body ?? '').matchAll(/^green again at \S*\/actions\/runs\/(\d+)\s*$/gm)) newest = Math.max(newest, Number(m[1]));
  }
  return newest;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`could not parse ${what}: ${error.message}`);
  }
}

/** The open `ci-nightly` issue with exactly this title, or null. */
export function findOpenIssue(gh, { repo, title }) {
  const out = gh(['issue', 'list', '-R', repo, '--state', 'open', '--label', LABEL,
    '--limit', '100', '--json', 'number,title']);
  const issues = parseJson(out || '[]', 'gh issue list');
  const match = issues
    .filter((issue) => issue.title === title)
    .sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

/** The newest red run the issue reports, or 0: the `Run: <url>` line that
 *  starts each failure body (renderFailureBody), in the body and comments.
 *  Other links (a person's comment, "green again at") do not count. */
export function newestReportedRun(issueJson) {
  const texts = [issueJson.body ?? '', ...(issueJson.comments ?? []).map((c) => c.body ?? '')];
  let newest = 0;
  for (const text of texts) {
    for (const m of text.matchAll(/^Run: \S*\/actions\/runs\/(\d+)\s*$/gm)) newest = Math.max(newest, Number(m[1]));
  }
  return newest;
}

function readIssue(gh, { repo, number }) {
  return parseJson(gh(['issue', 'view', String(number), '-R', repo, '--json', 'state,body,comments']) || '{}', 'gh issue view');
}

function readJobs(gh, { repo, runId }) {
  return parseJson(gh(['run', 'view', String(runId), '-R', repo, '--json', 'jobs']) || '{}', 'gh run view');
}

/**
 * The newest green run of this workflow on this branch, or 0. A red run that
 * finishes after a newer run already came back green reports a state the
 * branch has left, so it files nothing.
 */
export function newestGreenRun(gh, { repo, workflow, branch }) {
  if (!branch) return 0;
  const out = gh(['run', 'list', '-R', repo, '--workflow', workflow, '--branch', branch,
    '--status', 'success', '--limit', '1', '--json', 'databaseId']);
  const runs = parseJson(out || '[]', 'gh run list');
  return runs.length > 0 ? Number(runs[0].databaseId) || 0 : 0;
}

const TIMED_OUT = /exceeded the maximum execution time/i;

/**
 * The jobs API reports a job that hit its timeout-minutes as `cancelled`, the
 * same as one a newer push superseded. Its check run's annotations tell them
 * apart: "The job has exceeded the maximum execution time of …". A cancelled
 * job whose annotations say so is rewritten to `timed_out`, a failure.
 */
export function markTimeouts(gh, { repo }, jobsJson) {
  const jobs = (jobsJson?.jobs ?? []).map((job) => {
    if (job.status !== 'completed' || job.conclusion !== 'cancelled' || !job.databaseId) return job;
    // Every page, one message per line: a job with many warnings can push the
    // timeout annotation past the first page.
    const messages = gh(['api', '--paginate', `repos/${repo}/check-runs/${job.databaseId}/annotations`, '--jq', '.[].message']);
    return TIMED_OUT.test(messages || '') ? { ...job, conclusion: 'timed_out' } : job;
  });
  return { ...jobsJson, jobs };
}

/**
 * One report. `state` is 'failure', 'success', or 'auto' (the default): the
 * run's finished jobs decide (runOutcome). `gh(args, { allowFailure })` runs
 * one command and returns its stdout; `log` prints a line. Returns what it
 * did: 'created', 'commented', 'closed' or 'none'.
 */
export function report({ state = 'auto', env, gh, log = () => undefined }) {
  if (!['failure', 'success', 'auto'].includes(state)) throw new Error(`--state must be failure, success or auto, not ${state}`);
  const repo = env.GITHUB_REPOSITORY;
  const title = issueTitle(env.GITHUB_WORKFLOW);
  const url = runUrl(env);
  const jobsJson = markTimeouts(gh, { repo }, readJobs(gh, { repo, runId: env.GITHUB_RUN_ID }));
  if (state === 'auto') state = runOutcome(jobsJson);
  if (state === 'cancelled') {
    log('the run was cancelled; nothing to report');
    return 'none';
  }

  const existing = findOpenIssue(gh, { repo, title });

  if (state === 'success') {
    if (existing === null) {
      log(`no open issue titled "${title}"; nothing to close`);
      return 'none';
    }
    const newestRed = newestReportedRun(readIssue(gh, { repo, number: existing }));
    // Equal is this run's own red attempt: a rerun keeps GITHUB_RUN_ID and
    // bumps GITHUB_RUN_ATTEMPT, and a green rerun may close.
    if (Number(env.GITHUB_RUN_ID) < newestRed) {
      log(`run ${env.GITHUB_RUN_ID} is older than red run ${newestRed}; leaving #${existing} open`);
      return 'none';
    }
    gh(['issue', 'close', String(existing), '-R', repo, '--comment', renderGreenComment(url)]);
    // A newer red run may have commented between the read above and the
    // close; with no lock, check again and undo the close if one did.
    const newerRed = newestReportedRun(readIssue(gh, { repo, number: existing }));
    if (newerRed > Number(env.GITHUB_RUN_ID)) {
      gh(['issue', 'reopen', String(existing), '-R', repo, '--comment', `Reopened: red run ${newerRed} reported while run ${env.GITHUB_RUN_ID} was closing this.`]);
      log(`red run ${newerRed} reported meanwhile; reopened #${existing}`);
      return 'none';
    }
    log(`closed #${existing}`);
    return 'closed';
  }

  const newestGreen = newestGreenRun(gh, { repo, workflow: env.GITHUB_WORKFLOW, branch: env.GITHUB_REF_NAME });
  if (newestGreen > Number(env.GITHUB_RUN_ID)) {
    log(`run ${env.GITHUB_RUN_ID} is older than green run ${newestGreen}; not reporting a stale red`);
    return 'none';
  }
  const jobs = failedJobNames(jobsJson);
  const body = renderFailureBody({ url, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, jobs });

  if (existing !== null) {
    gh(['issue', 'comment', String(existing), '-R', repo, '--body', body]);
    log(`commented on #${existing}`);
    // An older green run may have closed the issue between the list above
    // and this comment. This red is newer than that green, so it stands.
    const after = readIssue(gh, { repo, number: existing });
    if (after.state === 'CLOSED' && newestClosingRun(after) < Number(env.GITHUB_RUN_ID)) {
      gh(['issue', 'reopen', String(existing), '-R', repo]);
      log(`an older green run closed #${existing} meanwhile; reopened it`);
    }
    return 'commented';
  }
  // Exists after the first time; the failure is ignored like `|| true`.
  gh(['label', 'create', LABEL, '-R', repo, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION],
    { allowFailure: true });
  const createdUrl = gh(['issue', 'create', '-R', repo, '--title', title, '--label', 'bug', '--label', LABEL, '--body', body]);
  const created = Number(/\/issues\/(\d+)/.exec(createdUrl ?? '')?.[1]) || null;
  log(`opened "${title}"${created ? ` (#${created})` : ''}`);
  // Two report jobs (a nightly and a push run) can both find no open issue
  // and both create one; GitHub has no lock to stop that. Converge instead:
  // the oldest open issue with the title is the one, and a newer duplicate
  // hands its report over as a comment and closes.
  const oldest = findOpenIssue(gh, { repo, title });
  if (created && oldest !== null && oldest < created) {
    gh(['issue', 'comment', String(oldest), '-R', repo, '--body', body]);
    gh(['issue', 'close', String(created), '-R', repo, '--comment', `Duplicate of #${oldest}, which carries this report.`]);
    log(`#${created} duplicated #${oldest}; moved the report there and closed it`);
    return 'commented';
  }
  return 'created';
}
