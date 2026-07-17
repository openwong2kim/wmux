import { describe, it, expect, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';

describe('AgentDetector', () => {
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
  });
});
