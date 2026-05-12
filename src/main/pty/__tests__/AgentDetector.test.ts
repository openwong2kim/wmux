import { describe, it, expect, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';

describe('AgentDetector', () => {
  describe('agent status emission', () => {
    it('emits "waiting" for "shift+tab to cycle" Claude prompt', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      // gate first
      det.feed('Claude Code starting up\n');
      det.feed('  shift+tab to cycle modes\n');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ agent: 'Claude Code', status: 'waiting' });
    });

    it('REGRESSION (R3): does NOT match "esc to interrupt" — Claude in-flight hint, not idle', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code starting up\n');
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
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('splits on lone \\r (carriage return redraw)', () => {
      // Claude/Codex TUIs redraw their footer line using bare CR. Without
      // \r-splitting, the entire redrawn buffer would land as one line and
      // line-anchored regexes would fail.
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r  shift+tab to cycle\r');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('keeps \\r\\n intact (no double-split)', () => {
      const det = new AgentDetector();
      const cb = vi.fn();
      det.onEvent(cb);
      det.feed('Claude Code\r\n  shift+tab to cycle\r\n');
      expect(cb).toHaveBeenCalledTimes(1);
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
