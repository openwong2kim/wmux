// Fan-out cost baseline (PRD E0 R0-2), end to end in the real Electron app.
//
// An ordinary agent pane fans out three tasks and follows them to
// review_requested: e2e/fanout-parent.mjs plays that parent inside the pane
// (the fake claude's parent mode), talking to the bundled MCP server exactly
// as an agent CLI does, and counts every tool call and every character that
// comes back. Workers are the fake claude running e2e/fanout-worker.mjs: a
// commit, a completion post in the mission channel, then ledger_update.
//
// The parent follows the protocol minimum, so its counts are lower bounds for
// a real agent. The report is printed and saved as e2e/artifacts/fanout-cost.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ARTIFACTS, ROOT, killRun, launchApp, makeSandbox, setWorkerScript, shot, sleep, waitFor } from './lib.mjs';

/** What each fake worker writes: its channel post, and its ledger summary at the tool's 2000 cap. */
const REPORT_CHARS = 1500;
const SUMMARY_CHARS = 2000;
/** The ledger summary as the mission channel echoes it (formatLedgerTransition). */
const LEDGER_ECHO_CHARS = 500;

const sb = makeSandbox('fanout');
let app;
let win;
let logs = [];

function format(r) {
  const tools = Object.entries(r.calls.byTool).map(([t, n]) => `${t} ${n}`).join(', ');
  return [
    `fan-out cost: ${r.tasks} tasks, ordinary pane parent, poll every ${r.pollIntervalMs}ms`,
    `  MCP calls        ${r.calls.total} (${tools}; fanout_start re-sends ${r.calls.fanoutPolls}, rereads ${r.calls.rereads})`,
    `  result chars     ${r.resultChars} (${Object.entries(r.charsByTool).map(([t, n]) => `${t} ${n}`).join(', ')})`,
    `  worker chars     ${r.workerChars.total} (per task ${r.workerChars.perTask.join(' / ')})`,
    `  nudges           ${r.nudges.count} (${r.nudges.chars} chars)`,
    `  adopt via MCP    ${r.adoptAvailableViaMcp ? 'available' : 'unavailable (no task_adopt in the pane profile)'}`,
    `  wall time        ${(r.wallMs / 1000).toFixed(1)}s`,
  ].join('\n');
}

before(async () => {
  setWorkerScript(sb, [
    'echo done > feature.txt',
    'git add feature.txt',
    'git -c user.name=fake-worker -c user.email=w@wmux.invalid commit -q -m "e2e worker: change"',
    `node ${JSON.stringify(path.join(ROOT, 'e2e', 'fanout-worker.mjs'))} ${REPORT_CHARS} ${SUMMARY_CHARS}`,
  ].join('\n'));
  // The entry is named claude.mjs: wmux attributes a `node …/claude.mjs` process
  // to Claude Code (AgentProcessTracker.resolveAgentSlug), and only a verified
  // live agent process is ever sent a nudge.
  const shim = path.join(sb.home, '.e2e-parent', 'claude.mjs');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, `import ${JSON.stringify(pathToFileURL(path.join(ROOT, 'e2e', 'fanout-parent.mjs')).href)};\n`);
  fs.writeFileSync(path.join(sb.home, '.e2e-parent.sh'), `exec node ${JSON.stringify(shim)}\n`);
  ({ app, win, logs } = await launchApp(sb));
  await win.locator('text=Workspaces').first().waitFor({ timeout: 60_000 });
  // The welcome dialog arrives a few seconds after the window does.
  await win.getByText('Skip for now', { exact: true }).first().click({ timeout: 30_000 }).catch(() => {});
  // eslint-disable-next-line no-restricted-syntax -- the welcome dialog closes with no signal to wait on
  await sleep(500);
  const dontAsk = win.getByText("Don't ask again", { exact: true });
  if (await dontAsk.count()) await dontAsk.first().click();
});

after(async () => {
  try {
    if (win) await shot(win, 'fanout-cost-99-final');
  } catch {
    /* the window may be gone */
  }
  try {
    await app?.close();
  } catch {
    /* already gone */
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'fanout-cost-app.log'), logs.join(''));
  killRun(sb);
  if (process.env.WMUX_E2E_KEEP !== '1') fs.rmSync(sb.home, { recursive: true, force: true });
});

describe('fan-out cost baseline (Electron e2e)', () => {
  it('counts what an ordinary pane parent pays to follow a 3-task fan-out', async () => {
    const term = win.locator('.xterm').first();
    await term.waitFor({ timeout: 30_000 });
    // eslint-disable-next-line no-restricted-syntax -- the shell prompt has no DOM signal to wait on
    await sleep(1_000);
    await term.click();
    await win.keyboard.type(`cd ${sb.project} && claude\n`);

    const file = path.join(sb.home, '.e2e-fanout-cost.json');
    await waitFor(() => fs.existsSync(file), { timeout: 5 * 60_000, interval: 1_000, what: 'the parent report' });
    await shot(win, 'fanout-cost-01-done');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'fanout-cost.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(format(report));

    // Today's protocol. A change that moves these (PRD E1: fanout_wait, adopt
    // for panes, capped reports) should update the baseline with them.
    assert.equal(report.spawned, 3, JSON.stringify(report));
    assert.equal(report.completed, true, JSON.stringify(report));
    assert.equal(report.adoptAvailableViaMcp, false);
    // Every task's whole channel post reached the parent, plus its summary as the ledger echo cut it.
    assert.deepEqual(report.workerChars.perTask, [1, 2, 3].map(() => REPORT_CHARS + LEDGER_ECHO_CHARS));
  });
});
