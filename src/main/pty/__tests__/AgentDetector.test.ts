import { describe, it, expect, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';

describe('AgentDetector', () => {
  describe('one line, at most one emission (first-match-wins)', () => {
    // Pins the invariant documented above processLine. A plan review read the
    // dedup `return`s as a swallowed-detection bug and proposed turning them
    // into `continue`; these tests are what that change breaks.

    it('a repeated prompt does NOT re-emit under a second agent that shares the pattern', () => {
      // Claude Code and OpenClaude are the same forked TUI and share their
      // approval patterns byte-for-byte. With both gates open, turn 2 of an
      // identical prompt must stay silent rather than firing as OpenClaude.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);

      det.feed('Claude Code v2.1.172\n');
      det.feed('OpenClaude v0.9.0\n');
      expect(det.getActiveAgents()).toEqual(
        expect.arrayContaining(['Claude Code', 'OpenClaude']),
      );
      cb.mockClear();

      det.feed('Do you want to proceed?\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Claude Code',
        status: 'awaiting_input',
      });

      cb.mockClear();
      det.feed('Do you want to proceed?\n');
      expect(cb).not.toHaveBeenCalled();
    });

    it('a critical hit consumes the line, deduped or not', () => {
      const det = new AgentDetector();
      const onCritical = vi.fn();
      det.onCritical(onCritical);
      det.feed('Claude Code v2.1.172\n');

      det.feed('git push --force origin main\n');
      expect(onCritical).toHaveBeenCalledTimes(1);

      // Same line again: suppressed, and still no second critical emission.
      det.feed('git push --force origin main\n');
      expect(onCritical).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent status emission', () => {
    it('gate 매칭 시 "running" 시작 이벤트를 1회 emit한다 (배너만으로 agentName 확정)', () => {
      // Claude Code v2.1.x처럼 idle prompt hint가 "❯"만 남아 patterns가
      // 매칭되지 않아도, 시작 배너(gate)만으로 detection이 활성화돼야 한다.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.172\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'running' });
      expect(det.getLastAgent()).toBe('Claude Code');
      // 같은 세션에서 배너가 다시 나와도 재발화하지 않는다 (activeAgents 가드).
      det.feed('Claude Code v2.1.172\n');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('개행 없이 미완성 라인에 머무는 시작 배너도 gate 매칭한다 (claude TUI 대응)', () => {
      // claude는 시작 배너를 개행 없이 커서 이동으로 그려 "Claude Code vX"가
      // lineBuffer에 갇혀 라인 완성이 안 될 수 있다. 그래도 gate는 검사돼야 한다.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.172'); // 개행 없음
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'running' });
      expect(det.getLastAgent()).toBe('Claude Code');
    });

    it('emits "waiting" for "shift+tab to cycle" Claude prompt', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // gate first — gate 매칭은 'running' 시작 이벤트를 발화하므로 분리해 무시
      det.feed('Claude Code starting up\n');
      cb.mockClear();
      det.feed('  shift+tab to cycle modes\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'waiting' });
    });

    it('REGRESSION (R3): does NOT match "esc to interrupt" — Claude in-flight hint, not idle', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code starting up\n');
      cb.mockClear(); // gate 'running' 무시 — esc 라인 자체는 emit하면 안 된다
      det.feed('press esc to interrupt\n');
      // Previously this falsely emitted 'waiting'. After the fix, no agent
      // event should fire for this line.
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
    it('opens the Claude gate from the OSC 0 window-title sequence alone', () => {
      // The current TUI renders no visible "Claude Code" text — the name only
      // appears in the window title escape, which ANSI_STRIP removes. The gate
      // must therefore also be checked against the raw line.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b]0;✳ Claude Code\x07\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'running' });
      // Approval detection now works even though no visible banner ever appeared.
      cb.mockClear();
      det.feed('│ Do you want to overwrite calculator.html? │\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('opens the gate from an OSC title stuck in an incomplete line (no newline)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b]0;⠂ Claude Code\x07'); // no newline — tail path
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'running' });
    });
  });

  describe('Claude file-edit approval prompts (live incident 2026-07-17)', () => {
    const gated = () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code v2.1.172\n');
      cb.mockClear();
      return { det, cb };
    };

    it('emits awaiting_input for a one-line overwrite prompt with filename', () => {
      const { det, cb } = gated();
      det.feed('│ Do you want to overwrite calculator.html? │\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({
        agent: 'Claude Code', status: 'awaiting_input', message: 'Edit approval requested',
      });
    });

    it('emits awaiting_input for create and make-this-edit variants', () => {
      const { det, cb } = gated();
      det.feed('  Do you want to create src/app.ts?\n');
      det.feed('  Do you want to make this edit to src/app.ts?\n');
      const statuses = cb.mock.calls.map((c) => c[0].status);
      expect(statuses).toEqual(['awaiting_input', 'awaiting_input']);
    });

    it('space-collapsed rendering still matches (cursor-move drawing eats spaces)', () => {
      // Observed in the 2026-07-17 pane buffer: after ANSI strip the prompt
      // read `Doyouwanttooverwrite` — same phenomenon as the `ClaudeCode`
      // banner gate note.
      const { det, cb } = gated();
      det.feed('Doyouwanttooverwrite calculator.html?\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('narrow-pane wrap (verb ends the line, filename on next line) still matches', () => {
      const { det, cb } = gated();
      det.feed('╌╌ Do you want to overwrite\n');
      det.feed(' calculator.html?\n');
      // The verb-terminated first line alone must fire; the orphan filename
      // line emits nothing on its own.
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ status: 'awaiting_input' });
    });

    it('does NOT match conversational mentions (whole-line anchored)', () => {
      const { det, cb } = gated();
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
      const det = new AgentDetector();
      const cb = vi.fn();
      const unsub = det.onEvent(cb);
      det.feed('Claude Code starting up\n');
      cb.mockClear(); // gate 'running' 분리
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      det.resetEmissionState(); // allow re-emit if cb were still subscribed
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1); // not 2
    });

    it('unsubscribe leaves OTHER callbacks intact', () => {
      const det = new AgentDetector();
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = det.onEvent(a);
      det.onEvent(b);
      unsubA();
      det.feed('Claude Code\n');
      b.mockClear(); // gate 'running' 분리 (a는 이미 unsub됨)
      det.feed('  shift+tab to cycle\n');
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe('emission dedup with cycle reset', () => {
    it('dedups consecutive identical "waiting" matches', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\n');
      cb.mockClear(); // gate 'running' 분리
      det.feed('  shift+tab to cycle\n');
      det.feed('  shift+tab to cycle\n');
      det.feed('  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('after resetEmissionState(), the same prompt fires again (turn N+1)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\n');
      cb.mockClear(); // gate 'running' 분리
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
      cb.mockClear(); // gate 'running' 분리
      det.feed('aider>\n');
      det.feed('Applied edit to src/foo.ts\n');
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0][0].status).toBe('waiting');
      expect(cb.mock.calls[1][0].status).toBe('complete');
    });
  });

  describe('feed() line splitting', () => {
    it('splits on \\n', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\n  shift+tab to cycle\n');
      // gate 'running' + 패턴 'waiting' = 2 emit. 분리되지 않았다면 0이다.
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('splits on lone \\r (carriage return redraw)', () => {
      // Claude/Codex TUIs redraw their footer line using bare CR. Without
      // \r-splitting, the entire redrawn buffer would land as one line and
      // line-anchored regexes would fail.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r  shift+tab to cycle\r');
      expect(cb).toHaveBeenCalledTimes(2); // gate 'running' + 'waiting'
    });

    it('keeps \\r\\n intact (no double-split)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r\n  shift+tab to cycle\r\n');
      expect(cb).toHaveBeenCalledTimes(2); // gate 'running' + 'waiting'
    });
  });

  describe('ANSI strip', () => {
    it('handles private-mode prefix sequences like \\x1b[?25h', () => {
      // Earlier regex omitted '?' from CSI parameter chars and left
      // `\x1b[?25h` (cursor visibility) embedded in `clean`, occasionally
      // breaking gate matches.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('\x1b[?25hClaude Code starting\n');
      cb.mockClear(); // gate 'running' 분리
      det.feed('\x1b[?25l  shift+tab to cycle\n');
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('getters', () => {
    it('getActiveAgents() returns gates that matched in this session', () => {
      const det = new AgentDetector();
      det.feed('Claude Code\n');
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
  // OpenClaude is a Claude Code fork and inherits Claude's approval patterns
  // via `extends`. These pin the inherited behaviour so the indirection cannot
  // quietly drop a prompt — the failure mode is a pane sitting on an unanswered
  // approval, which cost 100 minutes once already.
  describe('OpenClaude inherits Claude approval prompts', () => {
    const open = () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('OpenClaude v0.9.0\n');
      cb.mockClear();
      return { det, cb };
    };

    it('fires awaiting_input for the plain proceed prompt', () => {
      const { det, cb } = open();
      det.feed('Do you want to proceed?\n');
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'OpenClaude', status: 'awaiting_input', message: 'Approval requested' }),
      );
    });

    it('fires awaiting_input for the tool-approval prompt', () => {
      const { det, cb } = open();
      det.feed('│ Allow tool use for Bash? │\n');
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'OpenClaude', message: 'Tool approval requested' }),
      );
    });

    it('fires awaiting_input for both edit-approval shapes', () => {
      const withFile = open();
      withFile.det.feed('Do you want to overwrite calculator.html?\n');
      expect(withFile.cb).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'OpenClaude', message: 'Edit approval requested' }),
      );

      // Narrow pane: the prompt wraps and the verb ends the line alone.
      const wrapped = open();
      wrapped.det.feed('│ Do you want to overwrite │\n');
      expect(wrapped.cb).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'OpenClaude', message: 'Edit approval requested' }),
      );
    });

    it('keeps its own bare ">" idle prompt', () => {
      const { det, cb } = open();
      det.feed('> ○\n');
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'OpenClaude', status: 'waiting', message: 'Ready for input' }),
      );
    });

    it('does NOT inherit the two Claude waiting patterns it omits', () => {
      // "bypass permissions on" repaints every frame in OpenClaude and would
      // flood; "shift+tab to cycle" is not in its TUI at all.
      const a = open();
      a.det.feed('  bypass permissions on\n');
      expect(a.cb).not.toHaveBeenCalled();

      const b = open();
      b.det.feed('  shift+tab to cycle\n');
      expect(b.cb).not.toHaveBeenCalled();
    });
  });

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

    it('accepts a space-collapsed composer (cursor-drawn repaint)', () => {
      // A TUI that paints its composer with cursor moves loses the spaces
      // before the bytes reach us. KIRO_PROMPT_LINE survives that on its own —
      // every separator in it is `\s*` — so this is a behaviour guard, not
      // a test of the whitespace-stripped matcher. That one is below.
      const det = new AgentDetector();
      det.feed(KIRO_BANNER);
      det.feed('\x1b[2K\x1b[G▸askaquestionordescribeatask↵\n');
      expect(det.getLastAgent()).toBe('Kiro CLI');
    });

    it('accepts a composer that does not own its line (whitespace-stripped matcher)', () => {
      // The case the anchored pattern structurally cannot cover: a repaint
      // frame leaves other visible text on the same line, so `^...$` fails and
      // only the whitespace-stripped substring can still find the composer.
      //
      // REGRESSION: that matcher was dead code. It opened its search window
      // with lastIndexOf('ask'), but the needle ends in '...a task' — so the
      // window always latched onto that trailing copy and began past the text
      // it was looking for. It could not match any input, ever.
      const det = new AgentDetector();
      det.feed(KIRO_BANNER);
      det.feed('esc to cancel   ▸ ask a question or describe a task ↵\n');
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
      det.feed('Claude Code v2.1.172\n');
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
});
