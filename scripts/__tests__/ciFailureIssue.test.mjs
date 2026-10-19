// Nightly red issues (scripts/lib/ci-failure-issue.mjs, scripts/ci-failure-issue.mjs).
//
// A red run on main opens one `Nightly red: <workflow>` issue, or comments on
// the open one; a green run closes it. These drive the logic with a fake gh
// and pin the argv it sends, since the argv is the whole contract with GitHub.
import { describe, expect, it } from 'vitest';
import {
  failedJobNames,
  issueTitle,
  newestReportedRun,
  renderFailureBody,
  report,
  runOutcome,
  runUrl,
} from '../lib/ci-failure-issue.mjs';

const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_RUN_ID: '42',
  GITHUB_WORKFLOW: 'Runtime suite',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF_NAME: 'main',
};
const RUN_URL = 'https://github.com/acme/app/actions/runs/42';

function job(name, status, conclusion, stepConclusions = []) {
  return {
    name,
    status,
    conclusion,
    steps: stepConclusions.map((c, i) => ({ name: `step ${i}`, number: i + 1, status: 'completed', conclusion: c })),
  };
}

// The report job runs after the test jobs: it is the one still in progress.
const REPORT = job('Report to issue', 'in_progress', '', ['success']);
const RED = job('validate-runtime', 'completed', 'failure');
const GREEN = job('validate-runtime', 'completed', 'success');

function fakeGh({
  issues = [], jobs = [], issue = { body: '', comments: [] }, annotations = {}, greenRuns = [],
  issuesAfterCreate = null, createdUrl = 'https://github.com/acme/app/issues/30\n', issueAfterClose = null,
} = {}) {
  const calls = [];
  const gh = (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(greenRuns.map((databaseId) => ({ databaseId })));
    if (args[0] === 'api') {
      expect(args.slice(0, 2)).toEqual(['api', '--paginate']);
      expect(args.slice(3)).toEqual(['--jq', '.[].message']);
      const id = /check-runs\/(\d+)\/annotations$/.exec(args[2])?.[1];
      return (annotations[id] ?? []).join('\n');
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      // The second list (after a create) sees what other jobs opened meanwhile.
      const listed = calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'list').length;
      return JSON.stringify(listed > 1 && issuesAfterCreate ? issuesAfterCreate : issues);
    }
    if (args[0] === 'issue' && args[1] === 'create') return createdUrl;
    if (args[0] === 'issue' && args[1] === 'view') {
      // The second view (after a close) sees what other jobs wrote meanwhile.
      const viewed = calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'view').length;
      return JSON.stringify(viewed > 1 && issueAfterClose ? issueAfterClose : issue);
    }
    if (args[0] === 'run' && args[1] === 'view') return JSON.stringify({ jobs });
    return '';
  };
  return { gh, calls, writes: () => calls.filter((c) => c.args[0] !== 'api' && !['list', 'view'].includes(c.args[1])) };
}

describe('issueTitle', () => {
  it('is "Nightly red: " and the workflow name, one issue per workflow', () => {
    expect(issueTitle('Runtime suite')).toBe('Nightly red: Runtime suite');
    expect(issueTitle('Windows full suite')).toBe('Nightly red: Windows full suite');
  });

  it('refuses a missing workflow name', () => {
    expect(() => issueTitle('')).toThrow(/GITHUB_WORKFLOW/);
    expect(() => issueTitle(undefined)).toThrow(/GITHUB_WORKFLOW/);
  });
});

describe('runUrl', () => {
  it('builds the run page from the GITHUB_* variables', () => {
    expect(runUrl(ENV)).toBe(RUN_URL);
  });
});

describe('failedJobNames', () => {
  it('keeps finished jobs that failed or timed out, drops the rest', () => {
    const jobs = {
      jobs: [
        job('windows (2/2)', 'completed', 'failure'),
        job('windows (1/2)', 'completed', 'success'),
        job('slow', 'completed', 'timed_out'),
        REPORT,
      ],
    };
    expect(failedJobNames(jobs)).toEqual(['slow', 'windows (2/2)']);
  });
});

describe('runOutcome', () => {
  it('is failure when a finished job failed or timed out', () => {
    expect(runOutcome({ jobs: [GREEN, job('b', 'completed', 'failure'), REPORT] })).toBe('failure');
    expect(runOutcome({ jobs: [job('b', 'completed', 'timed_out'), REPORT] })).toBe('failure');
  });

  it('is cancelled when a job was cancelled and none failed, or nothing finished', () => {
    expect(runOutcome({ jobs: [GREEN, job('b', 'completed', 'cancelled'), REPORT] })).toBe('cancelled');
    expect(runOutcome({ jobs: [REPORT] })).toBe('cancelled');
  });

  it('is success when every finished job is green or skipped', () => {
    expect(runOutcome({ jobs: [GREEN, job('b', 'completed', 'skipped'), REPORT] })).toBe('success');
  });
});

describe('renderFailureBody', () => {
  it('is fixed-template data: run, event, commit, job names, nothing else', () => {
    const body = renderFailureBody({ url: RUN_URL, event: 'push', sha: 'b'.repeat(40), jobs: ['windows (1/2)'] });
    expect(body).toBe([
      `Run: ${RUN_URL}`,
      'Event: `push`',
      `Commit: \`${'b'.repeat(40)}\``,
      '',
      'Failed jobs:',
      '- `windows (1/2)`',
      '',
      'Opened by scripts/ci-failure-issue.mjs. The logs are on the run page.',
    ].join('\n'));
  });

  it('cannot break out of its code spans or mention anyone', () => {
    const body = renderFailureBody({ url: RUN_URL, event: 'push', sha: 'x', jobs: ['a`b\n@team'] });
    expect(body).toContain('- `a b  team`');
    expect(body).not.toContain('@');
  });
});

describe('report --state failure', () => {
  it('creates the issue, label first, when none is open', () => {
    const fake = fakeGh({ issues: [{ number: 7, title: 'Nightly red: Windows full suite' }], jobs: [RED, REPORT] });
    expect(report({ state: 'failure', env: ENV, gh: fake.gh })).toBe('created');

    expect(fake.calls.find((c) => c.args[1] === 'list').args).toEqual([
      'issue', 'list', '-R', 'acme/app', '--state', 'open', '--label', 'ci-nightly',
      '--limit', '100', '--json', 'number,title',
    ]);
    const writes = fake.writes();
    expect(writes).toHaveLength(2);
    expect(writes[0].args.slice(0, 5)).toEqual(['label', 'create', 'ci-nightly', '-R', 'acme/app']);
    expect(writes[0].options).toEqual({ allowFailure: true });
    const create = writes[1].args;
    expect(create.slice(0, 10)).toEqual([
      'issue', 'create', '-R', 'acme/app', '--title', 'Nightly red: Runtime suite',
      '--label', 'bug', '--label', 'ci-nightly',
    ]);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain(`Run: ${RUN_URL}`);
    expect(body).toContain('Event: `schedule`');
    expect(body).toContain(`Commit: \`${'a'.repeat(40)}\``);
    expect(body).toContain('- `validate-runtime`');
  });

  it('comments on the open issue instead of opening a second one', () => {
    const fake = fakeGh({
      issues: [{ number: 12, title: 'Nightly red: Runtime suite' }, { number: 9, title: 'Nightly red: Runtime' }],
      jobs: [RED, REPORT],
    });
    expect(report({ state: 'failure', env: ENV, gh: fake.gh })).toBe('commented');

    const writes = fake.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].args.slice(0, 5)).toEqual(['issue', 'comment', '12', '-R', 'acme/app']);
    expect(writes[0].args[6]).toContain('- `validate-runtime`');
  });
});

describe('report --state success', () => {
  it('closes the open issue with "green again at <run url>"', () => {
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [GREEN, REPORT] });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('closed');

    expect(fake.writes().map((c) => c.args)).toEqual([
      ['issue', 'close', '12', '-R', 'acme/app', '--comment', `green again at ${RUN_URL}`],
    ]);
  });

  it('does nothing when no issue is open', () => {
    const fake = fakeGh({ issues: [], jobs: [GREEN, REPORT] });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });

  it('leaves the issue open when a newer red run reported after this green one started', () => {
    // This run is 42; the issue's newest red report is run 57 (a push run
    // that started later and finished first).
    const issue = {
      body: 'Run: https://github.com/acme/app/actions/runs/40',
      comments: [{ body: 'Run: https://github.com/acme/app/actions/runs/57' }],
    };
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [GREEN, REPORT], issue });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });

  it('lets a green rerun of the red run itself close the issue (same run id, later attempt)', () => {
    const issue = { body: 'Run: https://github.com/acme/app/actions/runs/42', comments: [] };
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [GREEN, REPORT], issue });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('closed');
  });

  it('reads the newest red run from the `Run:` lines of the body and every comment', () => {
    const issue = {
      body: 'Run: https://github.com/acme/app/actions/runs/31\nEvent: `push`',
      comments: [
        { body: 'Run: https://github.com/acme/app/actions/runs/12' },
        { body: 'see https://github.com/acme/app/actions/runs/99 for context' },
        { body: 'green again at https://github.com/acme/app/actions/runs/98' },
      ],
    };
    expect(newestReportedRun(issue)).toBe(31);
    expect(newestReportedRun({})).toBe(0);
  });
});

describe('report --state auto (the report job)', () => {
  it('reports a red run from the finished jobs', () => {
    const fake = fakeGh({ issues: [], jobs: [RED, REPORT] });
    expect(report({ env: ENV, gh: fake.gh })).toBe('created');
  });

  it('closes on a green run', () => {
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [GREEN, REPORT] });
    expect(report({ env: ENV, gh: fake.gh })).toBe('closed');
  });

  it('reports a job that hit its timeout (the API says cancelled; the annotation says why)', () => {
    // As seen on a real run: conclusion `cancelled`, annotations
    // "The job has exceeded the maximum execution time of 1m0s" and
    // "The operation was canceled."
    const timedOut = { ...job('validate-runtime', 'completed', 'cancelled'), databaseId: 117596085033 };
    const fake = fakeGh({
      issues: [],
      jobs: [timedOut, REPORT],
      annotations: { 117596085033: ['The job has exceeded the maximum execution time of 1m0s', 'The operation was canceled.'] },
    });
    expect(report({ env: ENV, gh: fake.gh })).toBe('created');
    const create = fake.writes().find((c) => c.args[0] === 'issue' && c.args[1] === 'create').args;
    expect(create[create.indexOf('--body') + 1]).toContain('- `validate-runtime`');
  });

  it('does nothing for a run a newer push superseded (cancelled, no timeout annotation)', () => {
    const superseded = { ...job('validate-runtime', 'completed', 'cancelled'), databaseId: 7 };
    const fake = fakeGh({
      issues: [{ number: 12, title: 'Nightly red: Runtime suite' }],
      jobs: [superseded, REPORT],
      annotations: { 7: ['Canceling since a higher priority waiting request for runtime-push-refs/heads/main exists'] },
    });
    expect(report({ env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });

  it('does not report a red run older than the newest green run on the branch', () => {
    const fake = fakeGh({ issues: [], jobs: [RED, REPORT], greenRuns: [57] });
    expect(report({ env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
    expect(fake.calls.find((c) => c.args[1] === 'list' && c.args[0] === 'run').args).toEqual([
      'run', 'list', '-R', 'acme/app', '--workflow', 'Runtime suite', '--branch', 'main',
      '--status', 'success', '--limit', '1', '--json', 'databaseId',
    ]);
  });

  it('reports a red run newer than the last green one', () => {
    const fake = fakeGh({ issues: [], jobs: [RED, REPORT], greenRuns: [40] });
    expect(report({ env: ENV, gh: fake.gh })).toBe('created');
  });

  it('a red run reopens the issue an older green run closed while it commented', () => {
    const closedByOlderGreen = { state: 'CLOSED', body: '', comments: [{ body: 'green again at https://github.com/acme/app/actions/runs/40' }] };
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [RED, REPORT], issue: closedByOlderGreen });
    expect(report({ env: ENV, gh: fake.gh })).toBe('commented');
    expect(fake.writes().map((c) => c.args.slice(0, 3))).toEqual([
      ['issue', 'comment', '12'],
      ['issue', 'reopen', '12'],
    ]);
  });

  it('a red run leaves the issue closed when a newer green run closed it', () => {
    const closedByNewerGreen = { state: 'CLOSED', body: '', comments: [{ body: 'green again at https://github.com/acme/app/actions/runs/57' }] };
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [RED, REPORT], issue: closedByNewerGreen });
    expect(report({ env: ENV, gh: fake.gh })).toBe('commented');
    expect(fake.writes().map((c) => c.args[1])).toEqual(['comment']);
  });

  it('reopens the issue when a newer red run reported while it was closing', () => {
    const fake = fakeGh({
      issues: [{ number: 12, title: 'Nightly red: Runtime suite' }],
      jobs: [GREEN, REPORT],
      issue: { body: 'Run: https://github.com/acme/app/actions/runs/40', comments: [] },
      issueAfterClose: { body: 'Run: https://github.com/acme/app/actions/runs/40', comments: [{ body: 'Run: https://github.com/acme/app/actions/runs/70' }] },
    });
    expect(report({ env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes().map((c) => c.args.slice(0, 3))).toEqual([
      ['issue', 'close', '12'],
      ['issue', 'reopen', '12'],
    ]);
  });

  it('converges when another report job opened the same issue meanwhile: the older one stays', () => {
    const fake = fakeGh({
      issues: [],
      jobs: [RED, REPORT],
      createdUrl: 'https://github.com/acme/app/issues/31\n',
      issuesAfterCreate: [{ number: 30, title: 'Nightly red: Runtime suite' }, { number: 31, title: 'Nightly red: Runtime suite' }],
    });
    expect(report({ env: ENV, gh: fake.gh })).toBe('commented');
    const writes = fake.writes().map((c) => c.args.slice(0, 3));
    expect(writes).toEqual([
      ['label', 'create', 'ci-nightly'],
      ['issue', 'create', '-R'],
      ['issue', 'comment', '30'],
      ['issue', 'close', '31'],
    ]);
  });

  it('keeps its issue when it is the oldest open one', () => {
    const fake = fakeGh({
      issues: [],
      jobs: [RED, REPORT],
      createdUrl: 'https://github.com/acme/app/issues/30\n',
      issuesAfterCreate: [{ number: 30, title: 'Nightly red: Runtime suite' }, { number: 31, title: 'Nightly red: Runtime suite' }],
    });
    expect(report({ env: ENV, gh: fake.gh })).toBe('created');
    expect(fake.writes().map((c) => c.args[1])).toEqual(['create', 'create']);
  });

  it('does nothing for a cancelled run', () => {
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [job('validate-runtime', 'completed', 'cancelled'), REPORT] });
    expect(report({ env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });
});

describe('report arguments', () => {
  it('refuses an unknown state', () => {
    expect(() => report({ state: 'red', env: ENV, gh: fakeGh().gh })).toThrow(/--state/);
  });
});
