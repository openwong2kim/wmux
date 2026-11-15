// The key path's draft mark against the screen: a fresh frame of the agent's
// empty plain prompt clears it; nothing on screen ever sets it.
import { describe, expect, it } from 'vitest';
import type { AgentSlug } from '../../shared/events';
import type { DeliveryFrame } from '../deliveryComposer';
import { DRAFT_SCREEN_READ_MIN_MS, draftScreenCheck, type DraftScreenBridge } from '../draftScreen';

const RULE = '─'.repeat(40);
/** A frame with the cursor on row `cursorRow` (the prompt row is 1). */
const frame = (rows: string[], undimmed: string[] = rows, cursorRow = 1): DeliveryFrame => ({ rows: Object.assign([...rows], { undimmed }), cursorRow });
const EMPTY = frame([RULE, '❯ ', RULE, '  ? for shortcuts']);

function world(opts: { draft?: boolean; slug?: AgentSlug; frames?: Array<DeliveryFrame | null>; keyDuringRead?: boolean } = {}) {
  let draft = opts.draft ?? true;
  let keyRevision = 7;
  let clock = 1_000_000;
  let reads = 0;
  const frames = [...(opts.frames ?? [EMPTY])];
  const bridge: DraftScreenBridge = {
    hasDraft: () => draft,
    getKeyInputRevision: () => keyRevision,
    clearDraftIfUnchanged: (rev) => {
      if (rev !== keyRevision) return false;
      draft = false;
      return true;
    },
  };
  const check = draftScreenCheck({
    bridge: () => bridge,
    slug: () => opts.slug ?? 'claude',
    frame: async () => {
      reads++;
      // A key typed while the frame is read: the mark it set stays.
      if (opts.keyDuringRead) {
        keyRevision++;
        draft = true;
      }
      return frames.length > 1 ? frames.shift()! : frames[0];
    },
    now: () => clock,
  });
  return { check, draft: () => draft, reads: () => reads, advance: (ms: number) => { clock += ms; } };
}

describe('draftScreenCheck', () => {
  it('a draft erased with Backspace: the empty prompt on screen clears the mark', async () => {
    const w = world();
    expect(await w.check('pty')).toBe(false);
    expect(w.draft()).toBe(false);
  });

  it("Claude's dim suggestion in the emptied prompt still reads empty: cleared", async () => {
    const ghost = frame([RULE, '❯ Try "fix lint"', RULE], [RULE, '❯', RULE]);
    const w = world({ frames: [ghost] });
    expect(await w.check('pty')).toBe(false);
  });

  it('a draft still on screen keeps the mark', async () => {
    const w = world({ frames: [frame([RULE, '❯ half a thought', RULE])] });
    expect(await w.check('pty')).toBe(true);
    expect(w.draft()).toBe(true);
  });

  it('`!` mode with an empty line keeps the mark (a mode, not a plain prompt)', async () => {
    const w = world({ frames: [frame([RULE, '! ', RULE, '  ! for shell mode'])] });
    expect(await w.check('pty')).toBe(true);
  });

  it('a leftover frame (cursor not on the composer) or no frame keeps the mark', async () => {
    expect(await world({ frames: [frame([RULE, '❯ ', RULE, '  ? for shortcuts'], undefined, 3)] }).check('pty')).toBe(true);
    expect(await world({ frames: [frame([RULE, '❯ ', RULE], undefined, -1)] }).check('pty')).toBe(true);
    expect(await world({ frames: [null] }).check('pty')).toBe(true);
  });

  it('an agent whose cursor wmux has not measured, or no agent: no screen read, the mark stays', async () => {
    for (const slug of ['codex', 'gemini'] as const) {
      const w = world({ slug });
      expect(await w.check('pty')).toBe(true);
      expect(w.reads()).toBe(0);
    }
  });

  it('a key typed while the frame was read keeps the mark', async () => {
    const w = world({ keyDuringRead: true });
    expect(await w.check('pty')).toBe(true);
    expect(w.draft()).toBe(true);
  });

  it('no mark: no screen read; with one, at most one read per pane per second', async () => {
    const none = world({ draft: false });
    expect(await none.check('pty')).toBe(false);
    expect(none.reads()).toBe(0);
    const busy = frame([RULE, '❯ half a thought', RULE]);
    const w = world({ frames: [busy, busy, EMPTY] });
    expect(await w.check('pty')).toBe(true);
    expect(await w.check('pty')).toBe(true);
    expect(w.reads()).toBe(1);
    w.advance(DRAFT_SCREEN_READ_MIN_MS);
    expect(await w.check('pty')).toBe(true);
    expect(w.reads()).toBe(2);
    w.advance(DRAFT_SCREEN_READ_MIN_MS);
    expect(await w.check('pty')).toBe(false);
  });
});
