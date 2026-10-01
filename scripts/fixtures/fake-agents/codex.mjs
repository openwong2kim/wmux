#!/usr/bin/env node
// Fake Codex CLI — live-dogfood fixture for #1680 (fresh context per task).
//
// LAUNCH IT BY PATH, e.g. in a wmux pane:
//   node D:\wmux-work\w1680\scripts\fixtures\fake-agents\codex.mjs
// wmux's daemon attributes a `node <script>` process to an agent only when the
// script token is a PATH whose basename (extension stripped) is the agent slug
// (src/daemon/AgentProcessTracker.ts resolveAgentSlug). `node codex.mjs`
// without a directory is NOT attributed. The screen gate opens on the boxed
// `>_ OpenAI Codex` banner row.
//
// What it does:
//   - draws the boxed banner, a `›` composer between rules and a key-hint row;
//   - `/new` (also `/clear`): after FAKE_CLEAR_MS the conversation and screen
//     are cleared and the banner is drawn again — the screen evidence wmux
//     waits for on Codex (#1610);
//   - any other line is a turn (FAKE_TURN_MS, or N s for `work N`) ending in
//     `● done: … (context: K earlier prompts …)`;
//   - `/exit`, Ctrl+D on an empty composer, or Ctrl+C twice exits.
//
// Hooks, ONLY when pointed at explicitly (never from the home directory):
//   FAKE_CODEX_HOOKS_BRIDGE   path to wmux-codex-hooks-bridge.mjs; run with the
//                             hook JSON on stdin, like Codex's [[hooks.*]]:
//                             SessionStart, UserPromptSubmit, Stop
//   FAKE_CODEX_NOTIFY         path to wmux-codex-notify.mjs; run at each turn
//                             end with the agent-turn-complete JSON as its last
//                             argument, like Codex's `notify`
//   FAKE_CODEX_NEW_SOURCE     what `/new` does about SessionStart, since real
//                             Codex's behaviour there is not measured yet:
//                             `none` (default) — SessionStart(startup) fires
//                             with the next prompt, the way a fresh Codex
//                             session reports it inside its first turn;
//                             `startup` / `clear` — fire it at once with that
//                             source
//   FAKE_NO_HOOKS=1           run none
// See fakeAgentTui.mjs for FAKE_CLEAR_MS, FAKE_CLEAR_NEVER_SETTLES,
// FAKE_TURN_MS and FAKE_AGENT_LOG.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { envFlag, makeLogger, runFakeTui } from './fakeAgentTui.mjs';

const log = makeLogger('codex');
const HOOKS_OFF = envFlag('FAKE_NO_HOOKS');
const BRIDGE = HOOKS_OFF ? undefined : process.env.FAKE_CODEX_HOOKS_BRIDGE;
const NOTIFY = HOOKS_OFF ? undefined : process.env.FAKE_CODEX_NOTIFY;
const NEW_SOURCE = process.env.FAKE_CODEX_NEW_SOURCE || 'none';

function run(label, args, stdin) {
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: process.env,
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  child.on('error', (err) => log('hook_error', { label, error: String(err) }));
  child.on('exit', (code) => {
    clearTimeout(timer);
    log('hook', { label, code, ms: Date.now() - started });
  });
  child.stdin.end(stdin ?? '');
}

function fireHook(event, conversation, extra = {}) {
  if (!BRIDGE) return;
  run(event, [BRIDGE], JSON.stringify({
    session_id: conversation.id,
    cwd: process.cwd(),
    hook_event_name: event,
    model: 'fake',
    permission_mode: 'default',
    ...extra,
  }));
}

function notifyTurnEnd(text, conversation) {
  if (!NOTIFY) return;
  run('notify', [NOTIFY, JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': conversation.id,
    'turn-id': conversation.turnId,
    cwd: process.cwd(),
    'input-messages': [text],
    'last-assistant-message': 'done',
  })]);
}

const banner = () => {
  const width = 44;
  const row = (s) => `│ ${s.padEnd(width - 4)} │`;
  return [
    `╭${'─'.repeat(width - 2)}╮`,
    row('>_ OpenAI Codex (v0.0.0-fake)'),
    row(''),
    row('model:     fake   /model to change'),
    row(`directory: ${process.cwd().slice(-24)}`),
    `╰${'─'.repeat(width - 2)}╯`,
  ];
};

runFakeTui({
  agent: 'codex',
  header: banner,
  promptGlyph: '›',
  footer: ['  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit'],
  freshCommands: ['/new', '/clear'],
  headerOnFresh: true,
  freshSource: 'new',
  onSessionStart: (source, conversation) => {
    // Launch, and `/new` with the default knob: reported with the first turn.
    if (source === 'startup' || NEW_SOURCE === 'none') {
      conversation.lazySessionStart = 'startup';
      return;
    }
    fireHook('SessionStart', conversation, { source: NEW_SOURCE });
  },
  onPrompt: (text, conversation) => {
    conversation.turnId = randomUUID();
    if (conversation.lazySessionStart) {
      fireHook('SessionStart', conversation, { source: conversation.lazySessionStart });
      delete conversation.lazySessionStart;
    }
    fireHook('UserPromptSubmit', conversation, { turn_id: conversation.turnId });
  },
  onTurnEnd: (text, conversation) => {
    fireHook('Stop', conversation, { turn_id: conversation.turnId, stop_hook_active: false });
    notifyTurnEnd(text, conversation);
  },
});
