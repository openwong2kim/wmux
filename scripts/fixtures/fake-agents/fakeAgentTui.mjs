// Shared terminal UI for the fake agent CLIs in this folder (claude.mjs,
// codex.mjs). Live-dogfood fixtures for #1680 (fresh context per task): they
// draw the chrome wmux's detectors recognise, take typed and bracketed-paste
// input, run `/clear` / `/new` and `work N` turns, and fire the pane's hook
// commands, so the fresh-context engine can be driven end to end without a
// real model, a login, or the operator's own agent configuration.
//
// Not a product surface: nothing in src/ imports this. Written for wmux; no
// code from any other product.
//
// Environment knobs (all optional):
//   FAKE_CLEAR_MS             delay before the fresh-context command lands (300)
//   FAKE_CLEAR_NEVER_SETTLES  1 = the command leaves the composer but a spinner
//                             keeps redrawing forever, and no hook fires
//   FAKE_TURN_MS              length of an ordinary turn (400); `work N` runs N s
//   FAKE_NO_HOOKS             1 = never run a hook command
//   FAKE_MOUSE                1 = turn on any-motion mouse and focus reporting
//                             (as the real TUIs do); the reports are consumed
//   FAKE_AGENT_LOG            append one JSON line per event to this file,
//                             every raw input read included

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export function envFlag(name) {
  return process.env[name] === '1' || process.env[name] === 'true';
}

export function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function makeLogger(agent) {
  const path = process.env.FAKE_AGENT_LOG;
  return (event, fields = {}) => {
    if (!path) return;
    try {
      appendFileSync(path, `${JSON.stringify({ t: Date.now(), agent, pid: process.pid, event, ...fields })}\n`);
    } catch {
      // A log that cannot be written must not take the fake down.
    }
  };
}

/**
 * The fake TUI.
 *
 * spec:
 *   agent            'claude' | 'codex' (log label)
 *   title            OSC 0 window title, or undefined
 *   header()         rows drawn at the top of a conversation (banner/splash)
 *   promptGlyph      composer prompt glyph (`❯`, `›`)
 *   footer           rows drawn under the composer
 *   freshCommands    composer lines that start a new conversation
 *   fullScreen       draw on the alternate screen with the composer pinned to
 *                    the bottom row block (Codex); inline otherwise (Claude)
 *   onSessionStart(source)          a conversation started
 *   onFreshCommand()                the fresh-context command landed; returns
 *                                   nothing
 *   onPrompt(text, conversation)    a prompt was submitted
 *   onTurnEnd(text, conversation)   its turn ended
 */
export function runFakeTui(spec) {
  const log = makeLogger(spec.agent);
  const clearMs = envMs('FAKE_CLEAR_MS', 300);
  const turnMs = envMs('FAKE_TURN_MS', 400);
  const neverSettles = envFlag('FAKE_CLEAR_NEVER_SETTLES');
  const mouse = envFlag('FAKE_MOUSE');

  const state = {
    transcript: [],
    composer: '',
    showHeader: true,
    busy: null, // { text, until, timer, frame }
    queue: [],
    clearing: null, // { timer, frame }
    conversation: { id: randomUUID(), prompts: [] },
    lastCtrlC: 0,
    pasting: false,
    pending: '',
  };

  const out = (s) => process.stdout.write(s);
  const rows = () => process.stdout.rows || 30;
  const SPINNER = ['✻', '✶', '✳', '✢', '·'];

  function render() {
    const lines = [];
    if (state.showHeader) lines.push(...spec.header(), '');
    lines.push(...state.transcript);
    if (state.busy) {
      const left = Math.max(0, Math.ceil((state.busy.until - Date.now()) / 1000));
      lines.push(`${SPINNER[state.busy.frame % SPINNER.length]} Working… (${left}s · esc to interrupt)`);
    }
    if (state.clearing) {
      lines.push(`${SPINNER[state.clearing.frame % SPINNER.length]} Starting a new conversation… (frame ${state.clearing.frame})`);
    }
    lines.push('');
    // A full-screen TUI (Codex) keeps its composer at the bottom of the
    // terminal, so the banner can sit far above the cursor row.
    if (spec.fullScreen) {
      const below = 3 + spec.footer.length;
      while (lines.length + below < rows()) lines.push('');
    }
    const rule = '─'.repeat(Math.min(100, (process.stdout.columns || 100) - 1));
    lines.push(rule);
    const composerIndex = lines.length;
    lines.push(`${spec.promptGlyph} ${state.composer}`);
    lines.push(rule);
    lines.push(...spec.footer);
    // Keep the bottom of the screen; the header scrolls off like a real TUI.
    const visible = lines.slice(Math.max(0, lines.length - rows()));
    const composerRow = composerIndex - (lines.length - visible.length);
    let frame = `${ESC}[H${ESC}[2J`;
    if (spec.title) frame += `${ESC}]0;${spec.title}\x07`;
    frame += visible.join('\r\n');
    // The cursor rests on the composer row, after the typed text — wmux reads
    // the composer as the cursor row.
    frame += `${ESC}[${composerRow + 1};${spec.promptGlyph.length + 2 + [...state.composer].length}H`;
    out(frame);
  }

  function startConversation(source) {
    state.conversation = { id: randomUUID(), prompts: [] };
    log('session_start', { source, session: state.conversation.id });
    spec.onSessionStart?.(source, state.conversation);
  }

  function runFreshCommand(command) {
    log('fresh_command', { command, neverSettles });
    if (neverSettles) {
      state.clearing = { frame: 0, timer: setInterval(() => { state.clearing.frame++; render(); }, 150) };
      render();
      return;
    }
    setTimeout(() => {
      state.transcript = [];
      state.showHeader = spec.headerOnFresh !== false;
      spec.onFreshCommand?.(command);
      startConversation(spec.freshSource ?? 'clear');
      render();
    }, clearMs);
  }

  function submit(text) {
    const conv = state.conversation;
    const earlier = conv.prompts.length;
    conv.prompts.push(text);
    state.transcript.push(`${spec.promptGlyph} ${text}`);
    log('prompt', { text: text.slice(0, 200), earlierPrompts: earlier, session: conv.id });
    spec.onPrompt?.(text, conv);
    const m = /^work (\d+(?:\.\d+)?)\b/.exec(text.trim());
    const ms = m ? Number(m[1]) * 1000 : turnMs;
    state.busy = { text, until: Date.now() + ms, frame: 0 };
    state.busy.ticker = setInterval(() => {
      if (!state.busy) return;
      state.busy.frame++;
      render();
    }, 200);
    state.busy.timer = setTimeout(() => finishTurn(false), ms);
    render();
  }

  function finishTurn(interrupted) {
    const busy = state.busy;
    if (!busy) return;
    clearInterval(busy.ticker);
    clearTimeout(busy.timer);
    state.busy = null;
    const conv = state.conversation;
    const earlier = Math.max(0, conv.prompts.length - 1);
    state.transcript.push(
      interrupted
        ? '  ⎿  Interrupted'
        : `● done: ${busy.text.slice(0, 80)} (context: ${earlier} earlier prompt${earlier === 1 ? '' : 's'} in this conversation)`,
      '',
    );
    log(interrupted ? 'interrupted' : 'turn_end', { text: busy.text.slice(0, 200), earlierPrompts: earlier, session: conv.id });
    if (!interrupted) spec.onTurnEnd?.(busy.text, conv);
    const next = state.queue.shift();
    if (next !== undefined) submit(next);
    else render();
  }

  function enter() {
    const text = state.composer;
    state.composer = '';
    const trimmed = text.trim();
    if (!trimmed) {
      render();
      return;
    }
    if (trimmed === '/exit' || trimmed === '/quit') {
      quit('exit-command');
      return;
    }
    if (spec.freshCommands.includes(trimmed)) {
      render();
      runFreshCommand(trimmed);
      return;
    }
    if (state.busy) {
      state.queue.push(text);
      log('queued', { text: text.slice(0, 200) });
      render();
      return;
    }
    submit(text);
  }

  function quit(reason) {
    log('exit', { reason });
    out(`${mouse ? `${ESC}[?1004l${ESC}[?1006l${ESC}[?1003l` : ''}${ESC}[?2004l${spec.fullScreen ? `${ESC}[?1049l` : ''}\r\n`);
    process.exit(0);
  }

  function key(ch) {
    if (ch === '\r' || ch === '\n') return enter();
    if (ch === '\x7f' || ch === '\b') {
      state.composer = [...state.composer].slice(0, -1).join('');
      return render();
    }
    if (ch === '\x03') {
      const now = Date.now();
      if (state.busy) {
        finishTurn(true);
      } else if (state.clearing) {
        clearInterval(state.clearing.timer);
        state.clearing = null;
        render();
      } else if (state.composer) {
        state.composer = '';
        render();
      } else if (now - state.lastCtrlC < 1000) {
        quit('ctrl-c');
      }
      state.lastCtrlC = now;
      return undefined;
    }
    if (ch === '\x04') {
      if (!state.composer) quit('ctrl-d');
      return undefined;
    }
    if (ch < ' ') return undefined;
    state.composer += ch;
    return render();
  }

  /** Feed raw input: bracketed pastes go into the composer whole (a newline
   *  inside one is text, not Enter); escape sequences are dropped. */
  function feed(data) {
    // Every raw read, JSON-escaped: a dogfood run can see focus, mouse and
    // terminal query replies arriving next to the keys wmux typed.
    log('input', { data: data.slice(0, 200), bytes: data.length });
    let s = state.pending + data;
    state.pending = '';
    while (s.length > 0) {
      if (state.pasting) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          state.composer += s.replace(/\r\n?/g, '\n');
          s = '';
          break;
        }
        state.composer += s.slice(0, end).replace(/\r\n?/g, '\n');
        state.pasting = false;
        s = s.slice(end + PASTE_END.length);
        log('paste', { chars: state.composer.length });
        render();
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        state.pasting = true;
        s = s.slice(PASTE_START.length);
        continue;
      }
      if (s[0] === ESC) {
        // Parameter bytes are the full CSI range 0x30-0x3F, so SGR mouse
        // reports (`ESC[<35;10;5M`) are consumed whole, not typed.
        // eslint-disable-next-line no-control-regex -- ESC is the byte being parsed
        const m = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/.exec(s);
        if (m) {
          s = s.slice(m[0].length);
          continue;
        }
        // A CSI cut off at the end of a read waits for the rest; anything else
        // after ESC is a lone Escape key, which is dropped.
        // eslint-disable-next-line no-control-regex -- ESC is the byte being parsed
        if (/^\x1b(?:\[[0-?]*[ -/]*|O)?$/.test(s) && s.length < 16) {
          state.pending = s;
          break;
        }
        s = s.slice(1);
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(0));
      s = s.slice(ch.length);
      key(ch);
    }
  }

  // Bracketed paste on, so wmux pastes multi-line text as one block; a
  // full-screen TUI also switches to the alternate screen, as Codex does.
  // FAKE_MOUSE: also turn on any-motion mouse (SGR) and focus reporting, as
  // the real Claude and Codex TUIs do, so pointer movement over the pane sends
  // input the agent must ignore (the #1680 key-only interleave check).
  out(`${spec.fullScreen ? `${ESC}[?1049h` : ''}${ESC}[?2004h${mouse ? `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h` : ''}`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdin.on('end', () => quit('stdin-end'));
  process.stdout.on('resize', render);
  log('start', { argv: process.argv.slice(1), cwd: process.cwd(), tty: !!process.stdin.isTTY });
  startConversation('startup');
  render();
}
