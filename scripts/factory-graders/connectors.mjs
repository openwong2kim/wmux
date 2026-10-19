// Bot connections: what a worker's launch loads, and what a bot may name.

import { arr, botId, criterion } from './common.mjs';
import { taintLaneRefused } from './approvals.mjs';

function leadRows(snap, key) {
  const id = botId(snap, key);
  return arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === id);
}

function savedConnector(snap) {
  return arr(snap.records).find((r) => r.label === 'connector')?.result;
}

/** connector-worker-launch. */
export function connectorWorkerLaunch(snap, expect) {
  const name = expect.connector ?? 'probe';
  const saved = savedConnector(snap);
  const rows = leadRows(snap, expect.lead);
  const starts = arr(snap.workers).filter((e) => e.event === 'start');
  const start = starts[0];
  return [
    criterion('connector_saved', saved?.ok === true && saved.connector?.name === name && String(saved.connector?.stdio?.command ?? '').startsWith('/'),
      JSON.stringify(saved ?? null).slice(0, 200)),
    criterion('task_names_connection', rows.length === 1 && JSON.stringify(rows[0].dispatch?.connectors) === JSON.stringify([name]),
      rows.map((e) => JSON.stringify(e.dispatch?.connectors)).join(', ') || 'no lead task'),
    criterion('task_tainted', rows.length === 1 && rows[0].dispatch?.origin?.tainted === true, rows.map((e) => String(e.dispatch?.origin?.tainted)).join(', ') || 'no lead task'),
    criterion('worker_strict', starts.length === 1 && start.strict === true, start ? `strict=${start.strict}` : 'no worker start'),
    criterion('worker_servers', JSON.stringify(start?.mcpServers) === JSON.stringify(['wmux', name]), JSON.stringify(start?.mcpServers ?? null)),
    criterion('worker_listed_tools_only', arr(start?.allow).includes(`mcp__${name}__probe_read`) && !arr(start?.allow).includes(`mcp__${name}`),
      JSON.stringify(start?.allow ?? null)),
  ];
}

/** connector-off-for-bot-refused. */
export function connectorOffForBotRefused(snap, expect) {
  const name = expect.connector ?? 'probe';
  const calls = arr(snap.stub?.lead).filter((e) => e.event === 'tool' && e.name === 'fanout_start');
  const off = arr(snap.records).find((r) => r.label === 'off for lead')?.result;
  return [
    criterion('switched_off', off?.ok === true && arr(off.connector?.offFor).includes(botId(snap, expect.lead)), JSON.stringify(off ?? null).slice(0, 200)),
    criterion('fanout_refused', calls.length >= 1 && calls.every((c) => c.ok === false || /not one of your connections/.test(String(c.text))) && calls.some((c) => String(c.text).includes(`not one of your connections: ${name}`)),
      calls.map((c) => String(c.text).slice(0, 160)).join(' | ') || 'no fanout_start call'),
    criterion('nothing_started', leadRows(snap, expect.lead).length === 0 && arr(snap.workers).filter((e) => e.event === 'start').length === 0,
      `${leadRows(snap, expect.lead).length} task row(s), ${arr(snap.workers).length} worker event(s)`),
  ];
}

/** connector-task-lane-refused. */
export function connectorTaskLaneRefused(snap, expect) {
  const rows = leadRows(snap, expect.lead);
  return [
    criterion('task_names_connection', rows.length >= 1 && rows.every((e) => arr(e.dispatch?.connectors).includes(expect.connector ?? 'probe')),
      rows.map((e) => JSON.stringify(e.dispatch?.connectors)).join(', ') || 'no lead task'),
    ...taintLaneRefused(snap, expect),
  ];
}

/** connector-codex-worker-launch. */
export function connectorCodexWorkerLaunch(snap, expect) {
  const name = expect.connector ?? 'probe';
  const rows = leadRows(snap, expect.lead);
  const starts = arr(snap.workers).filter((e) => e.event === 'start');
  const start = starts[0];
  const m = start?.codexMcp;
  return [
    criterion('task_names_connection', rows.length === 1 && JSON.stringify(rows[0].dispatch?.connectors) === JSON.stringify([name]),
      rows.map((e) => JSON.stringify(e.dispatch?.connectors)).join(', ') || 'no lead task'),
    criterion('task_tainted', rows.length === 1 && rows[0].dispatch?.origin?.tainted === true, rows.map((e) => String(e.dispatch?.origin?.tainted)).join(', ') || 'no lead task'),
    criterion('worker_ran_codex', starts.length === 1 && start.agent === 'codex', starts.map((s) => s.agent).join(', ') || 'no worker start'),
    criterion('apps_and_plugins_off', arr(m?.featuresOff).includes('apps') && arr(m?.featuresOff).includes('plugins'), JSON.stringify(m?.featuresOff ?? null)),
    criterion('wmux_kept', !arr(m?.serversOff).includes('wmux'), JSON.stringify(m?.serversOff ?? null)),
    criterion('connection_listed_tools_only', JSON.stringify(m?.tables) === JSON.stringify([{ name, enabledTools: '"probe_read"' }]), JSON.stringify(m?.tables ?? null)),
  ];
}
