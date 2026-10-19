#!/usr/bin/env node
// fake-gh: a `gh` stand-in for factory smoke instances (scripts/factory-smoke.mjs).
//
// The smoke runner puts a `gh` wrapper that runs this file first on the
// isolated instance's PATH, so wmux main's GitHub reads and writes (repo
// watch, lane reads, pr_read, the squash merge) hit a scripted GitHub held
// in one JSON file instead of the network. Nothing else on the machine sees
// it. Every call is appended to a log the runner exports as evidence.
//
//   FACTORY_E2E_GH_STATE   the state file (read on every call, written on a merge)
//   FACTORY_E2E_GH_LOG     the call log (one JSON line per call)
//
// State shape:
//   { "login": "octo",
//     "repos": { "github.com/acme/app": {
//        "prs":    [{ number, title, state: OPEN|CLOSED|MERGED, isDraft, headSha,
//                     headRefName, baseRefName, author, labels: [], createdAt (ISO),
//                     checks: SUCCESS|FAILURE|PENDING|null,
//                     requiredChecks: ["build"], files: ["src/a.ts"],
//                     mergeStateStatus, mergeable, mergedAt?, mergeCommit? }],
//        "issues": [{ number, title, state, author, labels: [], createdAt, body }],
//        "mainChecks": SUCCESS|FAILURE|PENDING (the default branch head's rollup) } } }
//
// An argv shape this file does not know exits 1 with `fake-gh: unsupported`
// (logged with handled:false), never a rate-limit-shaped error: the app's
// breaker would back off for 15 minutes.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lockGhState, writeGhStateFile } from './gh-state-lock.mjs';

const STATE = process.env.FACTORY_E2E_GH_STATE;
const LOG = process.env.FACTORY_E2E_GH_LOG;
const argv = process.argv.slice(2);

function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), argv: argv.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…` : a)), cwd: process.cwd(), ...entry })}\n`);
  } catch {
    /* the log is evidence, never a reason to fail the call */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { login: 'octo', repos: {} };
  }
}

/** The calls that change the state hold the state lock (gh-state-lock.mjs)
 *  from their read to their write, until this process exits. */
function lockState() {
  if (!STATE) return;
  const release = lockGhState(STATE);
  if (!release) fail('fake-gh: the state lock was not released', true);
  process.on('exit', release);
}

function writeState(state) {
  writeGhStateFile(STATE, state);
}

function out(value, handled = true) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  log({ handled, exit: 0 });
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(0);
}

function fail(message, handled = true, code = 1) {
  log({ handled, exit: code, error: message });
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** gh flags that take no value (so they never swallow a positional). */
const BOOLEAN_FLAGS = new Set(['paginate', 'required', 'web', 'draft', 'squash', 'merge', 'rebase', 'delete-branch', 'auto', 'admin', 'silent', 'include', 'fill', 'watch']);
/** Short aliases gh accepts. */
const ALIASES = { R: 'repo', q: 'jq', t: 'title', b: 'body', H: 'head', B: 'base', d: 'draft' };

/** `-f k=v` / `-F k=v` / `--k=v` / `--k v` flags. */
function flags(args) {
  const fields = {};
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      const kv = args[++i] ?? '';
      const eq = kv.indexOf('=');
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      fields[k] = a === '-F' || a === '--field' ? (/^-?\d+$/.test(v) ? Number(v) : v) : v;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) named[name] = a.slice(eq + 1);
      else if (!BOOLEAN_FLAGS.has(name) && i + 1 < args.length && !args[i + 1].startsWith('-')) named[name] = args[++i];
      else named[name] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      const name = ALIASES[a.slice(1)] ?? a.slice(1);
      if (BOOLEAN_FLAGS.has(name)) named[name] = true;
      else named[name] = args[++i];
    } else positional.push(a);
  }
  return { fields, named, positional };
}

function repoOf(state, key) {
  const k = String(key ?? '').toLowerCase().replace(/\.git$/, '');
  const full = k.split('/').length === 2 ? `github.com/${k}` : k;
  return state.repos?.[full] ?? null;
}

/** The repo a call is about: --repo, the graphql owner/repo, else the only one. */
function repoKeyFor(state, f) {
  if (typeof f.named.repo === 'string') return f.named.repo;
  if (typeof f.fields.owner === 'string' && typeof f.fields.repo === 'string') return `${f.named.hostname ?? 'github.com'}/${f.fields.owner}/${f.fields.repo}`;
  const keys = Object.keys(state.repos ?? {});
  return keys.length === 1 ? keys[0] : null;
}

const rollup = (pr) => (pr.checks ? { state: pr.checks } : null);

function checkNodes(pr) {
  const names = new Set([...(pr.requiredChecks ?? []), ...(pr.checkNames ?? (pr.checks ? ['build'] : []))]);
  const conclusion = pr.checks === 'SUCCESS' ? 'SUCCESS' : pr.checks === 'FAILURE' ? 'FAILURE' : null;
  return [...names].map((name) => ({
    __typename: 'CheckRun',
    name,
    status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion,
    detailsUrl: `https://github.com/checks/${name}`,
    startedAt: pr.createdAt,
    completedAt: conclusion ? pr.createdAt : null,
    isRequired: (pr.requiredChecks ?? []).includes(name),
  }));
}

function watchPrNode(pr) {
  return {
    number: pr.number,
    title: pr.title,
    createdAt: pr.createdAt,
    state: pr.state,
    isDraft: !!pr.isDraft,
    headRefOid: pr.headSha,
    headRefName: pr.headRefName,
    isCrossRepository: false,
    mergeStateStatus: pr.mergeStateStatus ?? 'CLEAN',
    author: { login: pr.author },
    labels: { totalCount: (pr.labels ?? []).length, nodes: (pr.labels ?? []).map((name) => ({ name })) },
    commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: rollup(pr) } }] },
  };
}

function lanePrNode(pr, key) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: !!pr.isDraft,
    isCrossRepository: false,
    mergeable: pr.mergeable ?? 'MERGEABLE',
    mergeStateStatus: pr.mergeStateStatus ?? 'CLEAN',
    headRefOid: pr.headSha,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName ?? 'main',
    mergedAt: pr.mergedAt ?? null,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    author: { login: pr.author },
    url: `https://${key}/pull/${pr.number}`,
    labels: { totalCount: (pr.labels ?? []).length, nodes: (pr.labels ?? []).map((name) => ({ name })) },
    files: { totalCount: (pr.files ?? []).length, nodes: (pr.files ?? []).map((p) => ({ path: p })) },
    commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: { contexts: { totalCount: checkNodes(pr).length, nodes: checkNodes(pr) } } } }] },
  };
}

/** `gh pr view --json` fields (all of them; callers pick what they asked for). */
function prViewJson(pr, key) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    isDraft: !!pr.isDraft,
    url: `https://${key}/pull/${pr.number}`,
    headRefOid: pr.headSha,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName ?? 'main',
    author: { login: pr.author },
    mergeable: pr.mergeable ?? 'MERGEABLE',
    mergeStateStatus: pr.mergeStateStatus ?? 'CLEAN',
    reviewDecision: '',
    createdAt: pr.createdAt,
    updatedAt: pr.createdAt,
    mergedAt: pr.mergedAt ?? null,
    labels: (pr.labels ?? []).map((name) => ({ name })),
    files: (pr.files ?? []).map((p) => ({ path: p, additions: 1, deletions: 0 })),
    additions: (pr.files ?? []).length,
    deletions: 0,
    changedFiles: (pr.files ?? []).length,
    commits: [{ oid: pr.headSha }],
    statusCheckRollup: checkNodes(pr),
  };
}

function graphql(state, f) {
  const query = String(f.fields.query ?? '');
  const key = repoKeyFor(state, f);
  const repo = repoOf(state, key);
  if (!repo) return out({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a Repository ${key}` }] });
  const prs = repo.prs ?? [];
  if (/open:\s*pullRequests/.test(query)) {
    const open = prs.filter((p) => p.state === 'OPEN');
    const closed = prs.filter((p) => p.state !== 'OPEN');
    const issues = (repo.issues ?? []).filter((i) => i.state === 'OPEN');
    const data = {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        open: { totalCount: open.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(watchPrNode) },
        recent: { nodes: closed.map((p) => ({ number: p.number, state: p.state })) },
        issues: {
          totalCount: issues.length,
          nodes: issues.map((i) => ({
            number: i.number,
            title: i.title,
            createdAt: i.createdAt,
            state: i.state,
            author: { login: i.author },
            labels: { totalCount: (i.labels ?? []).length, nodes: (i.labels ?? []).map((name) => ({ name })) },
          })),
        },
      },
    };
    if (/\$after/.test(query)) delete data.repository.recent;
    return out({ data });
  }
  if (/defaultBranchRef/.test(query)) {
    const state = repo.mainChecks ?? 'SUCCESS';
    const nodes = state ? [{ __typename: 'CheckRun', name: 'build', conclusion: state === 'SUCCESS' ? 'SUCCESS' : state === 'FAILURE' ? 'FAILURE' : null, status: state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED' }] : [];
    return out({ data: { repository: { defaultBranchRef: { name: 'main', target: { oid: repo.mainSha ?? '0'.repeat(40), committedDate: new Date().toISOString(), statusCheckRollup: state ? { state, contexts: { totalCount: nodes.length, nodes } } : null } } } } });
  }
  if (/pullRequest\(number:/.test(query)) {
    const pr = prs.find((p) => p.number === Number(f.fields.number));
    if (!pr) return out({ data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }] });
    const node = lanePrNode(pr, key);
    if (/reviewThreads/.test(query)) node.reviewThreads = { nodes: [] };
    return out({ data: { repository: { pullRequest: node } } });
  }
  return fail('fake-gh: unsupported graphql query', false);
}

/** An issue as the REST API answers it. */
function issueRest(i, owner, repo) {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: String(i.state).toLowerCase(),
    user: { login: i.author },
    labels: (i.labels ?? []).map((name) => ({ name })),
    comments: 0,
    created_at: i.createdAt,
    updated_at: i.createdAt,
    html_url: `https://github.com/${owner}/${repo}/issues/${i.number}`,
  };
}

function api(state, f) {
  const [endpoint] = f.positional;
  if (endpoint === 'graphql') return graphql(state, f);
  if (endpoint === 'user') {
    if (f.named.jq === '.login') return out(state.login ?? 'octo');
    return out({ login: state.login ?? 'octo', id: 1 });
  }
  const bare = String(endpoint ?? '').split('?')[0];
  const list = /^repos\/([^/]+)\/([^/]+)\/issues$/.exec(bare);
  if (list) {
    const repo = repoOf(state, `${list[1]}/${list[2]}`);
    return out((repo?.issues ?? []).filter((i) => i.state === 'OPEN').map((i) => issueRest(i, list[1], list[2])));
  }
  if (/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(bare)) return out([]);
  const m = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/.exec(bare);
  if (m) {
    const repo = repoOf(state, `${m[1]}/${m[2]}`);
    const n = Number(m[4]);
    if (m[3] === 'issues') {
      const issue = repo?.issues?.find((i) => i.number === n);
      if (!issue) return fail('gh: Not Found (HTTP 404)');
      return out(issueRest(issue, m[1], m[2]));
    }
    const pr = repo?.prs?.find((p) => p.number === n);
    if (!pr) return fail('gh: Not Found (HTTP 404)');
    return out({ number: n, title: pr.title, state: String(pr.state).toLowerCase(), head: { sha: pr.headSha, ref: pr.headRefName }, base: { ref: pr.baseRefName ?? 'main' }, user: { login: pr.author } });
  }
  return fail(`fake-gh: unsupported api ${endpoint}`, false);
}

function pr(state, f) {
  const [sub, num] = f.positional;
  const key = repoKeyFor(state, f);
  const repo = repoOf(state, key);
  if (!repo) return fail(`GraphQL: Could not resolve to a Repository with the name '${key}'.`);
  if (sub === 'create') {
    const head = typeof f.named.head === 'string' ? f.named.head : spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
    const number = Math.max(0, ...(repo.prs ?? []).map((x) => x.number), ...(repo.issues ?? []).map((x) => x.number)) + 1;
    repo.prs = repo.prs ?? [];
    repo.prs.push({ number, title: String(f.named.title ?? head), body: String(f.named.body ?? ''), state: 'OPEN', isDraft: f.named.draft === true, headSha: sha, headRefName: head, baseRefName: String(f.named.base ?? 'main'), author: state.login ?? 'octo', labels: [], createdAt: new Date().toISOString(), checks: 'SUCCESS', requiredChecks: [], files: [] });
    writeState(state);
    return out(`https://${key}/pull/${number}`);
  }
  if (sub === 'list') {
    const want = String(f.named.state ?? 'open').toUpperCase();
    const rows = (repo.prs ?? []).filter((p) => want === 'ALL' || p.state === want);
    return out(rows.map((p) => prViewJson(p, key)));
  }
  // No number: the PR of the current branch (what `gh pr view` does in a checkout).
  let p;
  if (num === undefined) {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
    p = (repo.prs ?? []).find((x) => x.headRefName === branch && x.state === 'OPEN');
    if (!p) return fail(`no pull requests found for branch "${branch}"`);
  } else p = (repo.prs ?? []).find((x) => x.number === Number(num));
  if (!p) return fail(`GraphQL: Could not resolve to a PullRequest with the number of ${num}.`);
  if (sub === 'view') return out(prViewJson(p, key));
  if (sub === 'ready') {
    if (p.state !== 'OPEN') return fail(`pull request #${p.number} is not open`);
    p.isDraft = false;
    writeState(state);
    return out(`✓ Pull request #${p.number} is marked as "ready for review"`);
  }
  if (sub === 'checks') {
    if (f.named.json) return out(checkNodes(p).map((c) => ({ name: c.name, state: c.conclusion ?? 'PENDING', bucket: c.conclusion === 'SUCCESS' ? 'pass' : c.conclusion ? 'fail' : 'pending' })));
    return out(checkNodes(p).map((c) => `${c.name}\t${c.conclusion === 'SUCCESS' ? 'pass' : 'pending'}`).join('\n'));
  }
  if (sub === 'merge') {
    const expect = f.named['match-head-commit'];
    if (p.state !== 'OPEN') return fail('GraphQL: Pull request is not open (mergePullRequest)');
    if (expect && expect !== p.headSha) return fail('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
    p.state = 'MERGED';
    p.mergedAt = new Date().toISOString();
    p.mergeCommit = crypto.createHash('sha1').update(`${p.headSha}:merge`).digest('hex');
    writeState(state);
    return out(`✓ Squashed and merged pull request #${p.number} (${p.title})`);
  }
  return fail(`fake-gh: unsupported pr ${sub}`, false);
}

function issue(state, f) {
  const [sub, num] = f.positional;
  const key = repoKeyFor(state, f);
  const repo = repoOf(state, key);
  if (!repo) return fail(`GraphQL: Could not resolve to a Repository with the name '${key}'.`);
  if (sub === 'list') return out((repo.issues ?? []).filter((i) => i.state === 'OPEN').map((i) => ({ number: i.number, title: i.title, state: i.state, author: { login: i.author }, labels: (i.labels ?? []).map((name) => ({ name })), createdAt: i.createdAt })));
  const i = (repo.issues ?? []).find((x) => x.number === Number(num));
  if (!i) return fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${num}.`);
  if (sub === 'view') return out({ number: i.number, title: i.title, body: i.body ?? '', state: i.state, author: { login: i.author }, labels: (i.labels ?? []).map((name) => ({ name })), createdAt: i.createdAt, url: `https://${key}/issues/${i.number}`, comments: [] });
  return fail(`fake-gh: unsupported issue ${sub}`, false);
}

const [cmd, ...rest] = argv;
const f = flags(rest);
if (cmd === 'pr' && (f.positional[0] === 'create' || f.positional[0] === 'merge')) lockState();
const state = readState();
switch (cmd) {
  case '--version':
  case 'version':
    out('gh version 2.99.0 (fake)');
    break;
  case 'auth':
    if (f.positional[0] === 'status') {
      process.stderr.write(`github.com\n  ✓ Logged in to github.com account ${state.login ?? 'octo'} (fake)\n`);
      log({ handled: true, exit: 0 });
      process.exit(0);
    }
    if (f.positional[0] === 'token') fail('fake-gh: no token', true);
    fail(`fake-gh: unsupported auth ${f.positional[0]}`, false);
    break;
  case 'api':
    api(state, f);
    break;
  case 'pr':
    pr(state, f);
    break;
  case 'issue':
    issue(state, f);
    break;
  default:
    fail(`fake-gh: unsupported ${cmd}`, false);
}
