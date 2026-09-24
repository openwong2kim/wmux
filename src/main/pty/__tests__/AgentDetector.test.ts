import { describe, it, expect, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';

describe('AgentDetector', () => {
  // Helper: feed both banner AND prompt to open the Claude compound gate (#850).
  // Uses `bypass permissions on` as the gate-opening prompt so that
  // `shift+tab to cycle` tests can still emit without dedup collision.
  // Resets emission state after gate open so all patterns are fresh.
  function claudeGated() {
    const det = new AgentDetector();
    const cb = vi.fn();
    det.onEvent(cb);
    det.feed('Claude Code v2.1.172\n');        // banner signal
    det.feed('  bypass permissions on\n');     // prompt signal → gate opens
    det.resetEmissionState();
    cb.mockClear();
    return { det, cb };
  }

  describe('#1392 — versioned splash opens the gate without a permission footer', () => {
    // `claude --permission-mode default` draws no `bypass permissions on` /
    // `shift+tab to cycle` footer, so the compound gate's prompt signal never
    // arrives. The launch splash (logo glyphs + `Claude Code v…` on one row)
    // is product chrome that stands in for both signals.
    // The row as Claude Code 2.1.274 actually paints it (captured from a live
    // pane's PTY buffer): OSC title, cursor-home, colour, the logo glyphs, a
    // CHA move (`ESC[12G`) instead of spaces, bold, the name, another CHA,
    // then the version. No whitespace survives the ANSI strip.
    const SPLASH = "\r\n\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\u001b[>0q\u001b[?u\u001b[c\u001b[>4m\u001b[<u\u001b[?1004l\u001b[?2031l\u001b[?2004l\u001b[?2004h\u001b[?2031h\u001b[?1004h\u001b[?1049h\u001b[2J\u001b[H\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b]0;\u2733 Claude Code\u0007\u001b[H\r\u001b[1B\u001b[38;2;215;119;87m \u2590\u001b[48;2;0;0;0m\u259b\u2588\u2588\u2588\u259b\u2588\u001b[12G\u001b[39m\u001b[49m\u001b[1mClaude Code\u001b[24G\u001b[22m\u001b[38;2;153;153;153mv2.1.274" + '\n';

    it('splash line alone activates Claude Code', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed(SPLASH);
      expect(det.getLastAgent()).toBe('Claude Code');
      expect(cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status)).toContain('running');
    });

    it('a plainly spaced splash (older builds / other terminals) counts too', () => {
      const det = new AgentDetector();
      det.feed(' \u2590\u259b\u2588\u2588\u2588\u259b\u2588   Claude Code v2.1.172\n');
      expect(det.getLastAgent()).toBe('Claude Code');
    });

    it('a versioned banner WITHOUT the logo glyphs stays banner-only (#850 contract)', () => {
      const det = new AgentDetector();
      det.feed('Claude Code v2.1.274\n');          // a README / changelog / cat line
      det.feed('# Claude Code v2.1.274 release\n');
      expect(det.getLastAgent()).toBeNull();
    });

    it('a source line quoting the splash does not open the gate', () => {
      const det = new AgentDetector();
      det.feed("const SPLASH = ' \u2590\u259b\u2588 Claude Code v2.1.274';\n");
      expect(det.getLastAgent()).toBeNull();
    });
  });

  describe('agent status emission', () => {
    it('compound gate: banner + prompt together emit running then waiting', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.172\n');        // banner only — no emit
      expect(cb).not.toHaveBeenCalled();
      det.feed('  shift+tab to cycle modes\n');  // prompt → gate opens
      expect(det.getLastAgent()).toBe('Claude Code');
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
      // re-feeding the banner does not re-fire (activeAgents guard)
      cb.mockClear();
      det.feed('Claude Code v2.1.172\n');
      expect(cb).not.toHaveBeenCalled();
    });

    it('compound gate: incomplete banner line (no newline) collects evidence', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.172'); // no newline — banner seen via tail check
      expect(cb).not.toHaveBeenCalled(); // no prompt yet
      det.feed('\n  shift+tab to cycle\n');
      expect(det.getLastAgent()).toBe('Claude Code');
    });

    // ── #935: the gate against the wire, not against a hand-typed fixture ──
    //
    // Every fixture above spells the footer with literal spaces on its own
    // line. Claude Code does neither. Captured from a live pane (v2.1.235):
    // spaces are cursor advances, and the whole bottom region arrives as one
    // newline-free run whose rows are placed with CUP escapes. Both of those
    // kept the compound gate shut on every real Claude pane, which made the
    // detector's entire Claude block — waiting AND the approval awaiting_input
    // regexes — dead code against the shipping product.
    const ESC = String.fromCharCode(27);
    /** Join with cursor-forward-1 where the TUI would have written a space. */
    const cuf = (...words: string[]) => words.join(`${ESC}[1C`);
    /** Position the following text at a screen row, as a full-screen TUI does. */
    const at = (row: number) => `${ESC}[${row};3H`;
    const FOOTER_WIRE = `⏵⏵${ESC}[1C${cuf('bypass', 'permissions', 'on', '(shift+tab', 'to', 'cycle)')}`;

    it('#935 opens the gate on the wire form Claude emits (cursor-drawn spaces)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.235\n');
      expect(cb).not.toHaveBeenCalled();
      det.feed(`${FOOTER_WIRE}\n`);
      expect(det.getLastAgent()).toBe('Claude Code');
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
    });

    it('#935 opens the gate when the footer shares one cursor-addressed blob', () => {
      // The real bottom region: a Claude warning carrying `=`, the mode footer,
      // and the user's own echoed prompt carrying `;`. No newline anywhere in
      // it. Split on newlines alone this is ONE ~900-char "line", and
      // SOURCE_LINE_RE rejects it as source because of characters that belong
      // to neither the footer nor any code.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.235\n');
      const blob = [
        at(44) + cuf('Transcript', 'saving', 'is', 'off', '-', 'restart', 'with', 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1'),
        at(46) + FOOTER_WIRE,
        at(48) + cuf('Opus', '5', '(high)'),
        at(50) + '> Run `sleep 8; echo s1`, then `sleep 8; echo s2`.',
      ].join('');
      det.feed(`${blob}\n`);
      expect(det.getLastAgent()).toBe('Claude Code');
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('waiting');
    });

    it('emits "waiting" for "shift+tab to cycle" Claude prompt', () => {
      const { det, cb } = claudeGated();
      det.feed('  shift+tab to cycle modes\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'waiting' });
    });

    it('REGRESSION (R3): does NOT match "esc to interrupt" — Claude in-flight hint, not idle', () => {
      const { det, cb } = claudeGated();
      det.feed('press esc to interrupt\n');
      expect(cb).not.toHaveBeenCalled();
    });

    it('REGRESSION (R2): Aider "Applied edit to" emits "complete" (was "completed")', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('aider v0.50.0\n');
      det.feed('Applied edit to src/foo.ts\n');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({
        agent: 'Aider',
        status: 'complete',
      }));
    });
  });

  describe('OSC-title gate (live incident 2026-07-17, Fable-era Claude Code)', () => {
    it('OSC title serves as banner evidence; gate opens on first Claude-specific prompt', () => {
      // The current TUI renders no visible "Claude Code" text — the name only
      // appears in the window title escape. The OSC title is banner evidence;
      // the waiting prompt provides prompt evidence, opening the compound gate.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b]0;✳ Claude Code\x07\n');
      expect(cb).not.toHaveBeenCalled(); // banner only — no prompt yet
      det.feed('  bypass permissions on\n');
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
    });

    it('OSC title in an incomplete line (no newline) collects banner evidence', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b]0;⠂ Claude Code\x07'); // no newline — tail path
      expect(cb).not.toHaveBeenCalled(); // banner only
      det.feed('\n  bypass permissions on\n');
      expect(det.getLastAgent()).toBe('Claude Code');
    });
  });

  describe('Claude file-edit approval prompts (live incident 2026-07-17)', () => {
    // Uses the top-level claudeGated() helper (banner + prompt → gate open).
    // #1506: each question is followed by the dialog's first option row. A
    // question on its own can be transcript text, which a redraw prints again.

    it('emits awaiting_input for a one-line overwrite prompt with filename', () => {
      const { det, cb } = claudeGated();
      det.feed('│ Do you want to overwrite calculator.html? │\n│ ❯ 1. Yes │\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Claude Code', status: 'awaiting_input', message: 'Edit approval requested',
      });
    });

    it('emits awaiting_input for create and make-this-edit variants', () => {
      const { det, cb } = claudeGated();
      det.feed('  Do you want to create src/app.ts?\n ❯ 1. Yes\n');
      det.feed('  Do you want to make this edit to src/app.ts?\n ❯ 1. Yes\n');
      const statuses = cb.mock.calls.map((c) => c[0].status);
      expect(statuses).toEqual(['awaiting_input', 'awaiting_input']);
    });

    it('space-collapsed rendering still matches (cursor-move drawing eats spaces)', () => {
      // Observed in the 2026-07-17 pane buffer: after ANSI strip the prompt
      // read `Doyouwanttooverwrite` — same phenomenon as the `ClaudeCode`
      // banner gate note.
      const { det, cb } = claudeGated();
      det.feed('Doyouwanttooverwrite calculator.html?\n❯1.Yes\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('narrow-pane wrap (verb ends the line, filename on next line) still matches', () => {
      const { det, cb } = claudeGated();
      det.feed('╌╌ Do you want to overwrite\n');
      det.feed(' calculator.html?\n');
      det.feed(' ❯ 1. Yes\n');
      // The verb-terminated first line, its wrapped filename and the option
      // row read as one dialog.
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('does NOT match conversational mentions (whole-line anchored)', () => {
      const { det, cb } = claudeGated();
      det.feed('  If it asks "Do you want to overwrite calculator.html?" pick no and stop.\n');
      det.feed('  Do you want to overwrite it, or should I keep the old file around instead\n');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('Codex approval prompts (Phase 2 — clean-room transcribed from Codex CLI 0.145.0)', () => {
    const gated = () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('│ >_ OpenAI Codex (v0.145.0)\n');
      cb.mockClear();
      return { det, cb };
    };

    it('emits awaiting_input for the command-approval prompt', () => {
      const { det, cb } = gated();
      det.feed('  Would you like to run the following command?\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Codex CLI', status: 'awaiting_input', message: 'Command approval requested',
      });
    });

    it('emits awaiting_input for the edit-approval prompt', () => {
      const { det, cb } = gated();
      det.feed('  Would you like to make the following edits?\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Codex CLI', status: 'awaiting_input', message: 'Edit approval requested',
      });
    });

    it('trust prompt fires even on first boot BEFORE the banner (gate opens on the same line)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // First boot in an untrusted dir: no banner yet. The line is wrapped
      // by the TUI, so text continues after the question mark.
      det.feed('  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt\n');
      // gate 'running' + awaiting_input, in that order
      const statuses = cb.mock.calls.map((c) => c[0].status);
      expect(statuses).toContain('awaiting_input');
      const ev = cb.mock.calls.find((c) => c[0].status === 'awaiting_input')![0];
      expect(ev).toMatchObject({ agent: 'Codex CLI', message: 'Directory trust prompt' });
    });

    it('does NOT match conversational mentions (end-anchored whole line)', () => {
      const { det, cb } = gated();
      det.feed('  If Codex prints "Would you like to run the following command?" then pick no.\n');
      det.feed('  I asked: would you like to make the following edits? and it said yes\n');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('REGRESSION (R1): subscribe/unsubscribe lifecycle', () => {
    it('onEvent returns an unsubscribe function', () => {
      const det = new AgentDetector();
      const unsub = det.onEvent(() => {});
      expect(typeof unsub).toBe('function');
    });

    it('onCritical returns an unsubscribe function', () => {
      const det = new AgentDetector();
      const unsub = det.onCritical(() => {});
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe stops the callback from receiving further events', () => {
      const { det, cb } = claudeGated();
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);

      // claudeGated registered cb — find and unsubscribe it
      // Re-register a fresh cb to test unsubscribe
      const cb2 = vi.fn();
      const unsub = det.onEvent(cb2);
      det.resetEmissionState();
      det.feed('  shift+tab to cycle\n');
      expect(cb2).toHaveBeenCalledTimes(1);

      unsub();
      det.resetEmissionState();
      det.feed('  shift+tab to cycle\n');
      expect(cb2).toHaveBeenCalledTimes(1); // no new calls
    });

    it('unsubscribe leaves OTHER callbacks intact', () => {
      const det = new AgentDetector();
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = det.onEvent(a);
      det.onEvent(b);
      unsubA();
      // open compound gate with both signals
      det.feed('Claude Code\n  shift+tab to cycle\n');
      b.mockClear();
      det.resetEmissionState();
      det.feed('  shift+tab to cycle\n');
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe('emission dedup with cycle reset', () => {
    it('dedups consecutive identical "waiting" matches', () => {
      const { det, cb } = claudeGated();
      det.feed('  shift+tab to cycle\n');
      det.feed('  shift+tab to cycle\n');
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('after resetEmissionState(), the same prompt fires again (turn N+1)', () => {
      const { det, cb } = claudeGated();
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);

      det.resetEmissionState();
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('different status fires even without reset (e.g. waiting → complete)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('aider v0.50.0\n');
      cb.mockClear();
      det.feed('aider>\n');
      det.feed('Applied edit to src/foo.ts\n');
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0][0].status).toBe('waiting');
      expect(cb.mock.calls[1][0].status).toBe('complete');
    });
  });

  describe('Grok CLI (live capture 2026-08-16)', () => {
    it('opens the gate on the version banner and reports waiting on the footer', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Grok 4.6 is here!\n');
      expect(det.getLastAgent()).toBe('Grok');
      const agents = cb.mock.calls.map((c) => (c[0] as { agent: string }).agent);
      expect(agents).toContain('Grok');
      const statuses = cb.mock.calls.map((c) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
    });

    it('opens the gate on Help improve Grok (startup menu footer)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Help improve Grok                    [Opt out] [Opt in]\n');
      expect(det.getLastAgent()).toBe('Grok');
    });

    it('does not open the gate on a bare Grok mention', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('we should compare this against Grok later\n');
      expect(det.getLastAgent()).toBeNull();
      expect(cb).not.toHaveBeenCalled();
    });

    it('opens the gate on the live composer footer (Grok N.N (high) always-approve)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('  ╰───────────────────────────── Grok 4.6 (high) · always-approve ─╯  \n');
      expect(det.getLastAgent()).toBe('Grok');
    });

    it('does not flip to Claude when the Grok pane dumps this repo\'s detector source', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('  Help improve Grok                               [Opt out] [Opt in]  \n');
      expect(det.getLastAgent()).toBe('Grok');
      cb.mockClear();
      // Exact shapes that live in AgentDetector.ts — a coding agent reading
      // this file used to open Claude's compound gate and steal the pane.
      det.feed("    agent: 'Claude Code',\n");
      det.feed('const CLAUDE_PROMPT_RE = /bypass permissions on|shift\\+tab to cycle/;\n');
      det.feed('      det.feed(\'  shift+tab to cycle\\n\');\n');
      expect(det.getLastAgent()).toBe('Grok');
      expect(det.getActiveAgents()).not.toContain('Claude Code');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('feed() line splitting', () => {
    it('splits on \\n', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // banner + prompt in one feed — compound gate opens on the prompt line
      det.feed('Claude Code\n  shift+tab to cycle\n');
      // running (gate open) + waiting (prompt replay) = 2 emit
      expect(cb).toHaveBeenCalledTimes(2);
    });

    // The gate replay stores a match to dedup against the ordinary pattern
    // pass. CLAUDE_PROMPT_RE is an alternation (earliest POSITION wins) while
    // the pattern pass tries the waiting patterns in ARRAY order — so a footer
    // carrying both fragments with "shift+tab to cycle" FIRST used to store a
    // different text than the pass produced, and the same prompt emitted
    // 'waiting' twice.
    it('emits waiting exactly once when the footer carries BOTH prompt fragments', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\n  shift+tab to cycle | bypass permissions on\n');
      expect(cb).toHaveBeenCalledTimes(2); // running + waiting, not 3
      expect(cb.mock.calls.filter(([e]) => e.status === 'waiting')).toHaveLength(1);
    });

    it('emits waiting exactly once for bypass permissions on alone', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\n  bypass permissions on\n');
      expect(cb).toHaveBeenCalledTimes(2); // running + waiting
      expect(cb.mock.calls.filter(([e]) => e.status === 'waiting')).toHaveLength(1);
    });

    it('splits on lone \\r (carriage return redraw)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r  shift+tab to cycle\r');
      expect(cb).toHaveBeenCalledTimes(2); // running + waiting
    });

    it('keeps \\r\\n intact (no double-split)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r\n  shift+tab to cycle\r\n');
      expect(cb).toHaveBeenCalledTimes(2); // running + waiting
    });
  });

  describe('ANSI strip', () => {
    it('handles private-mode prefix sequences like \\x1b[?25h', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // banner + prompt with ANSI escapes
      det.feed('\x1b[?25hClaude Code starting\n');
      det.feed('\x1b[?25l  shift+tab to cycle\n');
      // compound gate opens on the prompt → running + waiting (replay)
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
    });
  });

  describe('getters', () => {
    it('getActiveAgents() returns gates that matched in this session', () => {
      const det = new AgentDetector();
      // Claude compound gate needs both signals
      det.feed('Claude Code\n  shift+tab to cycle\n');
      // Claude exits: the shell draws its prompt (OSC 133) and aider starts.
      det.feed('\u001b]133;A\u0007% aider\n');
      det.feed('aider v0.50.0\n');
      expect(det.getActiveAgents().sort()).toEqual(['Aider', 'Claude Code'].sort());
    });

    it('getLastAgent() returns the most recently emitted agent name', () => {
      const det = new AgentDetector();
      det.feed('aider v0.50.0\n');
      det.feed('aider>\n');
      expect(det.getLastAgent()).toBe('Aider');
    });

    it('getLastAgent() returns null before any event has fired', () => {
      const det = new AgentDetector();
      expect(det.getLastAgent()).toBeNull();
    });
  });

  describe('critical action detection (unchanged behaviour, regression guard)', () => {
    it('fires onCritical for "rm -rf /" patterns', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onCritical(cb);
      det.feed('$ rm -rf /tmp/junk\n');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({
        action: 'rm -rf',
        riskLevel: 'critical',
      }));
    });

    // #605 — `action` is a label, so two very different force-pushes used to
    // produce byte-identical events. The matched line is what a heads-up needs.
    it('carries the matched line, so two hits of one label are distinguishable', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onCritical(cb);

      det.feed('$ git push --force origin main\n');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({
        action: 'git push --force',
        matchedLine: '$ git push --force origin main',
      }));

      det.feed('$ git push -f scratch\n');
      expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'git push --force',
        matchedLine: '$ git push -f scratch',
      }));
    });

    it('strips ANSI and control bytes out of the matched line', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onCritical(cb);

      det.feed('\x1b[31m$ rm -rf\t/tmp/junk\x07\x1b[0m\n');
      expect(cb.mock.calls[0][0].matchedLine).toBe('$ rm -rf /tmp/junk');
    });

    it('caps the matched line at the 80 chars the dedup key uses', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onCritical(cb);

      det.feed(`$ rm -rf /tmp/${'x'.repeat(200)}\n`);
      expect(cb.mock.calls[0][0].matchedLine).toHaveLength(80);
    });

    it('dedups lines that differ only by a control byte', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onCritical(cb);

      // Same visible command, one with a stray tab: they normalize to the same
      // matchedLine, so the dedup key must match and only one emission fires.
      det.feed('$ rm -rf /tmp/junk\n');
      det.feed('$ rm -rf\t/tmp/junk\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].matchedLine).toBe('$ rm -rf /tmp/junk');
    });
  });

  // ── Kiro CLI ──────────────────────────────────────────────────────────────
  // Kiro has no hook bridge, so its identity comes entirely from PTY chrome.
  // A product-name mention is NOT enough: agents routinely print logs and docs
  // that name other agents. The gate requires an anchored chrome line AND the
  // anchored composer placeholder from the SAME detector (i.e. the same PTY).
  describe('Kiro CLI compound gate', () => {
    const KIRO_BANNER = 'Kiro CLI v0.9.3\n';
    const KIRO_DOCS = 'https://kiro.dev/docs/cli/\n';
    const KIRO_TRUST = 'Trust All Tools active, confirmations are off\n';
    const KIRO_PROMPT = '▸ ask a question or describe a task ↵\n';

    it('opens the gate only after BOTH chrome and prompt evidence arrive', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);

      det.feed(KIRO_BANNER);
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();

      det.feed(KIRO_PROMPT);
      expect(det.getLastAgent()).toBe('Kiro CLI');
      const statuses = cb.mock.calls.map((c) => c[0].status);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Kiro CLI', status: 'running' });
      expect(statuses).toContain('waiting');
    });

    it('accepts the two evidence lines in EITHER order (prompt first)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);

      // The composer placeholder can be painted before the banner scrolls in.
      det.feed(KIRO_PROMPT);
      expect(det.getLastAgent()).toBeNull();

      det.feed(KIRO_BANNER);
      expect(det.getLastAgent()).toBe('Kiro CLI');
      // The saved prompt evidence is replayed exactly once so the pane is not
      // stuck at 'running' while it is really idle and waiting for input.
      const waiting = cb.mock.calls.filter((c) => c[0].status === 'waiting');
      expect(waiting).toHaveLength(1);
      expect(waiting[0][0]).toMatchObject({ agent: 'Kiro CLI', message: 'Ready for input' });
    });

    it('accepts the v3 docs-URL chrome variant as chrome evidence', () => {
      const det = new AgentDetector();
      det.feed(KIRO_DOCS);
      expect(det.getLastAgent()).toBeNull();
      det.feed(KIRO_PROMPT);
      expect(det.getLastAgent()).toBe('Kiro CLI');
    });

    it('accepts the trust-mode footer as chrome evidence', () => {
      const det = new AgentDetector();
      det.feed(KIRO_TRUST);
      det.feed(KIRO_PROMPT);
      expect(det.getLastAgent()).toBe('Kiro CLI');
    });

    it('does NOT activate from a product mention alone (no prompt evidence)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Read the Kiro CLI release notes and compare with KIRO docs\n');
      det.feed('$ grep -R "Kiro CLI" .\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();
    });

    it('does NOT steal a PTY that another agent already owns while merely mentioning Kiro', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // open Claude compound gate (banner + prompt)
      det.feed('Claude Code v2.1.172\n  shift+tab to cycle\n');
      expect(det.getLastAgent()).toBe('Claude Code');
      cb.mockClear();

      // Claude printing Kiro's chrome text as quoted evidence must not hand the
      // pane's identity to Kiro — only real Kiro chrome + composer can.
      det.feed('The other pane printed "Kiro CLI v0.9.3" in its log\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBe('Claude Code');
    });

    it('evidence is per-detector: one PTY cannot satisfy another PTY’s gate', () => {
      const a = new AgentDetector();
      const b = new AgentDetector();
      a.feed(KIRO_BANNER);
      b.feed(KIRO_PROMPT);
      expect(a.getLastAgent()).toBeNull();
      expect(b.getLastAgent()).toBeNull();
    });

    it('maps the display name to the kiro slug in both directions', async () => {
      const { agentDisplayToSlug } = await import('../AgentDetector');
      const { agentSlugToDisplay } = await import('../../../shared/hooks/signal-types');
      expect(agentDisplayToSlug('Kiro CLI')).toBe('kiro');
      expect(agentSlugToDisplay('kiro')).toBe('Kiro CLI');
    });
  });

  // ── Claude Code compound gate (#850) ──────────────────────────────────────
  describe('Claude Code compound gate (#850)', () => {
    it('banner alone does NOT open the gate (btop showing claude in process list)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // A process monitor displays "Claude Code" in its process list
      det.feed('╭─ Processes ─────────────────────╮\n');
      det.feed('│ 3304  Claude Code   43.2%  512M │\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();
    });

    it('prompt alone does NOT open the gate', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('  shift+tab to cycle\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();
    });

    it('banner + prompt together open the gate', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v3.40\n');
      expect(cb).not.toHaveBeenCalled();
      det.feed('  bypass permissions on\n');
      expect(det.getLastAgent()).toBe('Claude Code');
      const statuses = cb.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('waiting');
    });

    it('prompt first, then banner — order-independent', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('  bypass permissions on\n');
      expect(det.getLastAgent()).toBeNull();
      det.feed('Claude Code v3.40\n');
      expect(det.getLastAgent()).toBe('Claude Code');
      const waiting = cb.mock.calls.filter((c: unknown[]) => (c[0] as { status: string }).status === 'waiting');
      expect(waiting).toHaveLength(1);
    });

    it('approval prompt alone is NOT gate evidence (avoids conversational false positives)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b]0;✳ Claude Code\x07\n');     // banner only
      det.feed('│ Do you want to proceed? │\n');   // approval — not a gate signal
      expect(det.getLastAgent()).toBeNull();        // gate still closed
      // A waiting prompt opens it
      det.feed('  shift+tab to cycle\n');
      expect(det.getLastAgent()).toBe('Claude Code');
    });

    it('source quoting both Claude signals does NOT open the gate (Grok-reading-this-repo)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed("    agent: 'Claude Code',\n");
      det.feed('const CLAUDE_PROMPT_RE = /bypass permissions on|shift\\+tab to cycle/;\n');
      det.feed('      { regex: /shift\\+tab to cycle/,            status: \'waiting\' },\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();
    });

    it('a process monitor mentioning "claude-code" without prompts does NOT activate', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('/usr/local/lib/node_modules/claude-code/bin/cli.js\n');
      det.feed('PID 3304: node claude-code --help\n');
      expect(cb).not.toHaveBeenCalled();
      expect(det.getLastAgent()).toBeNull();
    });

    it('evidence is per-detector: one PTY banner + another PTY prompt does not gate', () => {
      const a = new AgentDetector();
      const b = new AgentDetector();
      a.feed('Claude Code v3.40\n');
      b.feed('  shift+tab to cycle\n');
      expect(a.getLastAgent()).toBeNull();
      expect(b.getLastAgent()).toBeNull();
    });
  });

  describe('permission prompt reads as awaiting_input (Claude Code 2.1.281, replayed PTY bytes)', () => {
    // Every row below is copied byte-for-byte from a live pane buffer or a
    // scratch-PTY capture of Claude Code 2.1.281 — not hand-written text.
    // Hand-written fixtures with literal spaces are how these regexes passed
    // their tests while missing 15 of 33 real prompts.

    // #1506: the dialog's first option row, drawn the same way, follows each
    // question row below. The question alone can be transcript text.
    const OPTION_ROW_DRAWN = '\u001b[1C\u001b[1B❯\u001b[4G1.\u001b[7GYes\r';
    // Cursor-drawn prompt row: CHA moves (`ESC[5G`) instead of spaces.
    const PROCEED_CURSOR_DRAWN = '\r\u001b[1C\u001b[2BDo\u001b[5Gyou\u001b[9Gwant\u001b[14Gto\u001b[17Gproceed?\r' + OPTION_ROW_DRAWN;
    // Same row as another frame painted it: the first gap is a CHA, the rest spaces.
    const PROCEED_PARTLY_DRAWN = '\r\u001b[1C\u001b[1BDo\u001b[5Gyou want to proceed?\u001b[K\r' + OPTION_ROW_DRAWN;

    it('emits awaiting_input for a cursor-drawn "Do you want to proceed?" row', () => {
      const { det, cb } = claudeGated();
      det.feed(PROCEED_CURSOR_DRAWN);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested',
      });
    });

    it('emits awaiting_input for a partly cursor-drawn row', () => {
      const { det, cb } = claudeGated();
      det.feed(PROCEED_PARTLY_DRAWN);
      expect(cb.mock.calls.map((c) => c[0].status)).toEqual(['awaiting_input']);
    });

    it('emits awaiting_input for a space-collapsed "Allow tool use for" row', () => {
      const { det, cb } = claudeGated();
      det.feed('│Allowtoolusefor mcp__wmux__channel_post?│\n');
      expect(cb.mock.calls.map((c) => c[0].status)).toEqual(['awaiting_input']);
    });

    it('still ignores the collapsed phrase inside a sentence (whole-line anchor kept)', () => {
      const { det, cb } = claudeGated();
      det.feed('If it asks Doyouwanttoproceed? then answer no\n');
      expect(cb).not.toHaveBeenCalled();
    });

    it('a shell line naming the codex binary does not hand the pane to Codex', () => {
      // The review panel's preamble, echoed by Claude's Bash tool in a Claude
      // pane. The old `codex ` gate alternative opened Codex here, made it the
      // pane's lastAgent, and every later Claude prompt went unread.
      const { det, cb } = claudeGated();
      det.feed('⎿  $ echo "--- PANEL ---"; echo "Claude: available"; command -v codex >/dev/null 2>&1 && echo "Codex: available" || echo "Codex: SKIP";\n');
      expect(det.getActiveAgents()).toEqual(['Claude Code']);
      det.feed(PROCEED_CURSOR_DRAWN);
      expect(cb.mock.calls.map((c) => c[0])).toEqual([
        { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' },
      ]);
    });

    it('rows that merely name another agent do not take a live Claude pane', () => {
      // Replayed from live Claude panes, each of which used to end the session
      // owned by another agent: a `git log -S"…OpenAI Codex"` echo, a status
      // line quoting "Claude/OpenClaude", a test path containing "opencode".
      const { det, cb } = claudeGated();
      det.feed('\r\u001b[2C\u001b[1Bfmzube; gi -C $W log -S"gate: /codex |OpenAI Codex" --oneline --\r');
      det.feed('\r\u001b[1B⏺\u001b[3GDiagnosissettled.Editing:(1)\\s*intheClaude/OpenClaudeproceed+\r');
      det.feed('\r\u001b[1Bcripts/__tests_/opencode-sync-render.runtime.test.mjs 2>&1 | grep -E\r');
      det.feed('\r\u001b[1Bopencode-sync-render, fails because the Playwrightbrowserisn\'tinstalled\r');
      expect(det.getActiveAgents()).toEqual(['Claude Code']);
      det.feed(PROCEED_CURSOR_DRAWN);
      expect(cb.mock.calls.map((c) => c[0])).toEqual([
        { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' },
      ]);
    });

    it('a Claude reply that wraps with the Codex banner text at a row start stays Claude', () => {
      // Seen live: Claude answered "printed two lines: >_ OpenAI Codex (v0.149.1)"
      // and the TUI broke the row right before the quoted text.
      const { det, cb } = claudeGated();
      det.feed('\r\u001b[5C\u001b[1B\u001b[38;2;177;185;249m>_ OpenAI Codex (v0.149.1)\u001b[39m and\r');
      expect(det.getActiveAgents()).toEqual(['Claude Code']);
      det.feed(PROCEED_CURSOR_DRAWN);
      expect(cb.mock.calls.map((c) => c[0].status)).toEqual(['awaiting_input']);
    });

    it('Claude exiting to the shell and Codex starting hands the pane to Codex', () => {
      const { det } = claudeGated();
      det.feed('\u001b]133;D;0\u0007\u001b]133;A\u0007% codex\r\n');
      det.feed('\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n');
      expect(det.getLastAgent()).toBe('Codex CLI');
    });

    it('a substring gate takes the pane once the shell prompt is back (OSC 133)', () => {
      // The owner exited: the shell draws its prompt, and the user starts
      // another agent in the same pane.
      const { det } = claudeGated();
      det.feed('\u001b]133;D;0\u0007\u001b]133;A\u0007% opencode\r\n');
      expect(det.getLastAgent()).toBe('OpenCode');
    });

    it('the real Codex banner row still opens the Codex gate', () => {
      const det = new AgentDetector();
      det.feed('\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n');
      expect(det.getLastAgent()).toBe('Codex CLI');
    });

    describe('#1494 — the live permission dialog, however Ink draws it', () => {
      // Byte shapes from Windows dogfood panes (Claude Code, detector only,
      // no PermissionRequest hook). Commands, descriptions and paths were
      // replaced; the escapes and their order are as recorded.
      const OPTION = '\u001b[38;2;177;185;249m❯\u001b[38;2;153;153;153m\u001b[1C1. \u001b[38;2;177;185;249mYes';
      // First draw: the question row is placed by a CUP and glued to the
      // description row before it and the `❯ 1. Yes` row after it.
      const FIRST_DRAW =
        '\u001b[1m\u001b[23;2HBash command\u001b[m\u001b[25;4Hecho\u001b[1Chi\u001b[1C>\u001b[1Chello.txt'
        + '\u001b[38;2;153;153;153m\u001b[26;4HCreate hello.txt containing "hi"'
        + '\u001b[m\u001b[28;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?'
        + '\u001b[29;2H' + OPTION
        + '\u001b[38;2;153;153;153m\u001b[30;4H2. \u001b[mYes,\u001b[1Cand\u001b[1Calways\u001b[1Callow\u001b[1Caccess\u001b[1Cto'
        + '\u001b[1m\u001b[31;7HC:\\work\u001b[22m\u001b[1Cfrom\u001b[1Cthis\u001b[1Cproject'
        + '\u001b[38;2;153;153;153m\u001b[32;4H3. \u001b[mNo\r\n';
      // Question row after a CR/LF, option row glued on by a CUP.
      const TRAILING_GLUE =
        '\r\n Do you want to proceed?\u001b[K\u001b[35;2H' + OPTION + '\u001b[m\r\n';
      // Question row glued to the row before it; the option row follows the CR/LF.
      const LEADING_GLUE =
        '\u001b[m\u001b[30;2HThis\u001b[1Ccommand\u001b[1Crequires\u001b[1Capproval'
        + '\u001b[32;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?\r\n '
        + OPTION + '\u001b[K\u001b[m\r\n';
      // Full repaint once the transcript outgrows the viewport: no CUP before
      // the question, which is glued after the diff row by width padding and
      // autowrap.
      const PADDED_REPAINT =
        '\u001b[38;2;248;248;242m\u001b[2m 1 \u001b[22mhi' + ' '.repeat(120)
        + '\u001b[38;2;80;80;80m' + '╌'.repeat(64) + '\u001b[m Do you want to create \u001b[1mhello7.txt\u001b[22m?'
        + '\u001b[K\u001b[40;2H' + OPTION + '\u001b[m\r\n';

      const statuses = (cb: ReturnType<typeof vi.fn>) => cb.mock.calls.map((c) => c[0]);
      const APPROVAL = [{ agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' }];
      const EDIT_APPROVAL = [{ agent: 'Claude Code', status: 'awaiting_input', message: 'Edit approval requested' }];

      it('emits awaiting_input for the first-draw frame', () => {
        const { det, cb } = claudeGated();
        det.feed(FIRST_DRAW);
        expect(statuses(cb)).toEqual(APPROVAL);
      });

      it('emits awaiting_input when only the following row is glued on', () => {
        const { det, cb } = claudeGated();
        det.feed(TRAILING_GLUE);
        expect(statuses(cb)).toEqual(APPROVAL);
      });

      it('emits awaiting_input when only the preceding row is glued on', () => {
        const { det, cb } = claudeGated();
        det.feed(LEADING_GLUE);
        expect(statuses(cb)).toEqual(APPROVAL);
      });

      it('emits awaiting_input for the padded full-repaint shape', () => {
        const { det, cb } = claudeGated();
        det.feed(PADDED_REPAINT);
        expect(statuses(cb)).toEqual(EDIT_APPROVAL);
      });

      it('emits awaiting_input when the filename wraps and the option is padded onto its row', () => {
        const { det, cb } = claudeGated();
        det.feed('\u001b[38;2;80;80;80m' + '╌'.repeat(40) + '\u001b[m\u001b[11;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto'
          + '\u001b[1Cmake\u001b[1Cthis\u001b[1Cedit\u001b[1Cto\r\n \u001b[1mcalculator.html\u001b[22m?' + ' '.repeat(40)
          + '\u001b[38;2;177;185;249m❯ \u001b[38;2;153;153;153m1. \u001b[38;2;177;185;249mYes\u001b[K\u001b[m\r\n');
        expect(statuses(cb)).toEqual(EDIT_APPROVAL);
      });

      it('a tool approval on a cursor-positioned row still reads as awaiting_input', () => {
        const { det, cb } = claudeGated();
        det.feed('\u001b[K\u001b[35;2HAllow tool use for mcp__wmux__channel_post?\r\n ' + OPTION + '\u001b[K\u001b[m\r\n');
        expect(statuses(cb)).toEqual([{ agent: 'Claude Code', status: 'awaiting_input', message: 'Tool approval requested' }]);
      });

      it('reads the dialog as soon as its rows are drawn, with no line break yet', () => {
        const { det, cb } = claudeGated();
        det.feed(FIRST_DRAW.slice(0, -2) + '\u001b[35;1H');
        expect(statuses(cb)).toEqual(APPROVAL);
      });

      it('same result when the frame arrives split inside the CUP escape, in 512 B chunks or byte by byte', () => {
        const cut = FIRST_DRAW.indexOf('\u001b[29;2H') + 4;
        const a = claudeGated();
        a.det.feed(FIRST_DRAW.slice(0, cut));
        a.det.feed(FIRST_DRAW.slice(cut));
        expect(statuses(a.cb)).toEqual(APPROVAL);

        const padded = 'x'.repeat(300) + '\r\n' + FIRST_DRAW;
        const b = claudeGated();
        for (let i = 0; i < padded.length; i += 512) b.det.feed(padded.slice(i, i + 512));
        expect(statuses(b.cb)).toEqual(APPROVAL);

        for (const frame of [FIRST_DRAW, PADDED_REPAINT]) {
          const c = claudeGated();
          for (const ch of frame) c.det.feed(ch);
          expect(statuses(c.cb)).toHaveLength(1);
        }
      });

      it('a transcript row that is exactly the question stays silent on a full repaint', () => {
        // Claude asked to print the phrase on a line of its own. Every repaint
        // after the answer draws that row again, placed by a CUP.
        const { det, cb } = claudeGated();
        det.feed('\u001b[38;2;255;255;255m\u001b[29;1H● \u001b[mOK' + ' '.repeat(120)
          + '\u001b[30;3HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?\r\n \u001b[1CEND' + ' '.repeat(80) + '\u001b[32;3H\r\n');
        det.feed('\u001b[38;2;255;255;255m● \u001b[mOK\r\n  Do you want to proceed?' + ' '.repeat(100) + 'END\r\n');
        expect(cb).not.toHaveBeenCalled();
      });

      describe('#1506 — rows separated by CR/LF, with no cursor positioning', () => {
        // A split or resize makes Claude re-emit its transcript as plain CRLF
        // lines. A reply that printed the question on a line of its own then
        // reads as a whole line with nothing else on it.
        const CRLF_TRANSCRIPT =
          '\u001b[38;2;255;255;255m● \u001b[mOK\u001b[K\r\n  Do you want to proceed?\u001b[K\r\n  END\u001b[K\r\n';
        const CRLF_TRANSCRIPT_EDIT =
          '\u001b[38;2;255;255;255m● \u001b[mOK\u001b[K\r\n  Do you want to create hello7.txt?\u001b[K\r\n\u001b[K\r\n  END\u001b[K\r\n';
        // The live dialog drawn with the same CRLF row breaks.
        const CRLF_DIALOG =
          '\r\n Do you want to proceed?\u001b[K\r\n ' + OPTION + '\u001b[K\u001b[m\r\n'
          + '   2. Yes, and don\'t ask again\u001b[K\r\n   3. No\u001b[K\r\n';

        const feedIn = (det: AgentDetector, s: string, size: number) => {
          for (let i = 0; i < s.length; i += size) det.feed(s.slice(i, i + size));
        };
        const splitAtCrLf = (det: AgentDetector, s: string) => {
          for (const part of s.split(/(?<=\r)(?=\n)/)) det.feed(part);
        };

        it('a transcript line that is exactly the question stays silent on every redraw', () => {
          const { det, cb } = claudeGated();
          for (const redraw of [CRLF_TRANSCRIPT, CRLF_TRANSCRIPT_EDIT, CRLF_TRANSCRIPT, CRLF_TRANSCRIPT_EDIT]) {
            det.feed(redraw);
            det.resetEmissionState(); // each redraw starts a new activity cycle
          }
          expect(cb).not.toHaveBeenCalled();
        });

        it('stays silent however the redraw is chunked', () => {
          for (const frame of [CRLF_TRANSCRIPT, CRLF_TRANSCRIPT_EDIT]) {
            for (const size of [1, 2, 7, 64]) {
              const { det, cb } = claudeGated();
              feedIn(det, frame, size);
              expect(cb).not.toHaveBeenCalled();
            }
            const { det, cb } = claudeGated();
            splitAtCrLf(det, frame);
            expect(cb).not.toHaveBeenCalled();
          }
        });

        it('the dialog drawn with CRLF rows still emits once, however it is chunked', () => {
          const whole = claudeGated();
          whole.det.feed(CRLF_DIALOG);
          expect(statuses(whole.cb)).toEqual(APPROVAL);
          for (const size of [1, 2, 7, 64]) {
            const { det, cb } = claudeGated();
            feedIn(det, CRLF_DIALOG, size);
            expect(statuses(cb)).toEqual(APPROVAL);
          }
          const { det, cb } = claudeGated();
          splitAtCrLf(det, CRLF_DIALOG);
          expect(statuses(cb)).toEqual(APPROVAL);
        });

        it('a framed file dialog drawn with CRLF rows still emits', () => {
          const { det, cb } = claudeGated();
          det.feed('│ Do you want to create hello.txt?   │\r\n│ ❯ 1. Yes                        │\r\n');
          expect(statuses(cb)).toEqual(EDIT_APPROVAL);
        });

        it('judges the question when the option row arrives, not before', () => {
          const { det, cb } = claudeGated();
          det.feed('\r\n Do you want to proceed?\u001b[K\r\n');
          expect(cb).not.toHaveBeenCalled();
          det.feed(' ' + OPTION + '\u001b[K\u001b[m\r\n');
          expect(statuses(cb)).toEqual(APPROVAL);
        });

        it('after the answer, a redraw of the transcript does not raise the dialog again', () => {
          const { det, cb } = claudeGated();
          det.feed(CRLF_DIALOG);
          expect(statuses(cb)).toEqual(APPROVAL);
          // The user answers: the daemon resets dedup, and a later split
          // redraws the transcript, which now holds the question as text.
          cb.mockClear();
          det.resetEmissionState();
          det.feed(CRLF_TRANSCRIPT);
          det.resetEmissionState();
          det.feed(CRLF_TRANSCRIPT);
          expect(cb).not.toHaveBeenCalled();
        });

        it('a tool approval line keeps its whole-line match', () => {
          const { det, cb } = claudeGated();
          det.feed('\r\n Allow tool use for Bash?\u001b[K\r\n');
          expect(statuses(cb)).toEqual([{ agent: 'Claude Code', status: 'awaiting_input', message: 'Tool approval requested' }]);
        });

        it('an OpenClaude pane keeps the whole-line approval match', () => {
          const det = new AgentDetector();
          const cb = vi.fn();
          det.onEvent(cb);
          det.feed('OpenClaude\n');
          cb.mockClear();
          det.feed('  Do you want to proceed?\r\n');
          expect(statuses(cb)).toEqual([{ agent: 'OpenClaude', status: 'awaiting_input', message: 'Approval requested' }]);
        });
      });

      it('a dialog row redrawn before the answer does not re-raise the dialog when a clear completes its line', () => {
        const { det, cb } = claudeGated();
        // The dialog is drawn, then laid out again two rows lower (diff redraw
        // skipping unchanged cells). No CR/LF ends that line yet.
        det.feed('\u001b[m\u001b[17;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Ccreate\u001b[1m\u001b[1Chello1.txt\u001b[22m?'
          + '\u001b[18;2H' + OPTION + '\u001b[38;2;153;153;153m\u001b[20;4H3. \u001b[mNo\u001b[35;1H\u001b[K');
        det.feed('\u001b[m\u001b[19;2HDo you want to create \u001b[1mhello1.\u001b[1Cxt\u001b[22m?\u001b[K\u001b[38;2;177;185;249m\u001b[20;2H❯'
          + '\u001b[38;2;153;153;153m\u001b[1C1\u001b[38;2;177;185;249m\u001b[2CYes\u001b[38;2;153;153;153m\u001b[24;2HEsc to cancel · Tab to amend\u001b[m');
        expect(statuses(cb).length).toBeGreaterThan(0);
        // The user answers: the daemon resets dedup, Claude clears the dialog.
        cb.mockClear();
        det.resetEmissionState();
        det.feed('\u001b[13;1H' + ' '.repeat(40) + '\u001b[15;2H\u001b[K\r\n' + ' '.repeat(40) + '\u001b[17;2H\u001b[K\r\n');
        expect(cb).not.toHaveBeenCalled();
      });

      it('a lone question row completed by the post-answer clear stays silent', () => {
        // Same hazard with a partial redraw of the question row alone.
        const { det, cb } = claudeGated();
        det.feed('\u001b[19;2HDo you want to create \u001b[1mhello1.\u001b[1Cxt\u001b[22m?\u001b[K');
        det.feed('\u001b[15;2H\u001b[K\r\n');
        expect(cb).not.toHaveBeenCalled();
      });

      it('a cursor-positioned row quoting the phrase inside a sentence stays silent', () => {
        const { det, cb } = claudeGated();
        det.feed('\u001b[12;2HIf\u001b[1Cthe\u001b[1CCLI\u001b[1Casks\u001b[1C"Do\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?",'
          + '\u001b[13;2Hchoose\u001b[1Cno.\u001b[14;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?\u001b[1Cthen\u001b[1Cstop\r\n');
        det.feed('\u001b[36;1H❯ Without using any tools, reply with one prose sentence that contains the exact words \'Do you want to proceed?\' in the\r\n');
        expect(cb).not.toHaveBeenCalled();
      });

      it('a pane another agent owns does not read the Claude-shaped frame', () => {
        // #1474: status patterns belong to the pane's lastAgent only.
        const det = new AgentDetector();
        const cb = vi.fn();
        det.onEvent(cb);
        det.feed('\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n');
        expect(det.getLastAgent()).toBe('Codex CLI');
        cb.mockClear();
        det.feed(FIRST_DRAW);
        det.feed(PADDED_REPAINT);
        expect(cb).not.toHaveBeenCalled();
      });

      it('an idle prompt drawn on a cursor-positioned row is not read as waiting', () => {
        // The dialog scan is Claude's and approval-only: OpenClaude's bare `>`
        // input row must not report Ready for input from inside a repaint.
        const det = new AgentDetector();
        const cb = vi.fn();
        det.onEvent(cb);
        det.feed('OpenClaude\n');
        expect(det.getLastAgent()).toBe('OpenClaude');
        cb.mockClear();
        det.feed('\u001b[10;1H⏺ Working on it\u001b[12;1H>\u001b[13;1Hesc to interrupt\r\n');
        expect(cb).not.toHaveBeenCalled();
      });
    });

    describe('manual-mode footer (default permission mode, no splash)', () => {
      // A fan-out worker launched as `claude "<prompt>"` in the default
      // permission mode: OSC title, then this footer. No splash, no
      // `shift+tab to cycle`, no `bypass permissions on`.
      const TITLE = '\u001b[?25l\u001b]0;✳ Claude Code\u0007\u001b[H';
      const FOOTER_SPACED = '\r\u001b[2C\u001b[2B\u001b[38;2;153;153;153m⏸ manual mode on · ← for agents\u001b[39m\u001b[24;1H\u001b[21;3H\u001b[?25h\r';
      const FOOTER_CURSOR_DRAWN = '\r\r\n\u001b[3G\u001b[38;2;153;153;153m⏸\u001b[5Gmanual\u001b[12Gmode\u001b[17Gon\u001b[20G·\u001b[22Gesc\u001b[26Gto\u001b[29Ginterrupt\u001b[39G·\u001b[41G←\u001b[43G2\u001b[45Gagents\u001b[39m\r\r\n';

      for (const [name, footer] of [['spaced', FOOTER_SPACED], ['cursor-drawn', FOOTER_CURSOR_DRAWN]] as const) {
        it(`opens the gate from the OSC title + ${name} footer, and the prompt emits`, () => {
          const det = new AgentDetector();
          const cb = vi.fn();
          det.onEvent(cb);
          det.feed(TITLE);
          det.feed(footer);
          expect(det.getLastAgent()).toBe('Claude Code');
          det.feed(PROCEED_CURSOR_DRAWN);
          expect(cb.mock.calls.map((c) => c[0].status)).toEqual(['running', 'awaiting_input']);
        });
      }

      it('does not emit waiting for the footer — it is on screen mid-turn too', () => {
        const det = new AgentDetector();
        const cb = vi.fn();
        det.onEvent(cb);
        det.feed(FOOTER_CURSOR_DRAWN);   // prompt half first (evidence stored)
        det.feed(TITLE);                 // banner half opens the gate
        expect(cb.mock.calls.map((c) => c[0].status)).toEqual(['running']);
      });

      it('the footer alone does not open the gate', () => {
        const det = new AgentDetector();
        det.feed(FOOTER_SPACED);
        expect(det.getLastAgent()).toBeNull();
      });
    });
  });
});
