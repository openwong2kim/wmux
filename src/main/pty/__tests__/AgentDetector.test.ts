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

    it('emits awaiting_input for a one-line overwrite prompt with filename', () => {
      const { det, cb } = claudeGated();
      det.feed('│ Do you want to overwrite calculator.html? │\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Claude Code', status: 'awaiting_input', message: 'Edit approval requested',
      });
    });

    it('emits awaiting_input for create and make-this-edit variants', () => {
      const { det, cb } = claudeGated();
      det.feed('  Do you want to create src/app.ts?\n');
      det.feed('  Do you want to make this edit to src/app.ts?\n');
      const statuses = cb.mock.calls.map((c) => c[0].status);
      expect(statuses).toEqual(['awaiting_input', 'awaiting_input']);
    });

    it('space-collapsed rendering still matches (cursor-move drawing eats spaces)', () => {
      // Observed in the 2026-07-17 pane buffer: after ANSI strip the prompt
      // read `Doyouwanttooverwrite` — same phenomenon as the `ClaudeCode`
      // banner gate note.
      const { det, cb } = claudeGated();
      det.feed('Doyouwanttooverwrite calculator.html?\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('narrow-pane wrap (verb ends the line, filename on next line) still matches', () => {
      const { det, cb } = claudeGated();
      det.feed('╌╌ Do you want to overwrite\n');
      det.feed(' calculator.html?\n');
      // The verb-terminated first line alone must fire; the orphan filename
      // line emits nothing on its own.
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
});
