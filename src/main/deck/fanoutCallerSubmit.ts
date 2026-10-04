// ─── Fan-out caller nudge: main's half of the write ─────────────────────────
//
// The renderer resolves the requester's pane from its layout and asks main to
// write the one fixed line (renderer/hooks/fanoutCallerNudge.ts). Main checks,
// in order, immediately before handing the write to the daemon:
//   1. the line matches the fixed template (shared/fanoutCallerNudge, or the
//      PR owner template in shared/prOwnerNudge, or both in one line),
//   2. the approval/usage-limit gate every non-operator delivery passes,
//   3. the PTY still belongs to the fan-out's owner workspace,
//   4. the pane's agent is a verified live process whose incarnation is the
//      one the renderer bound the pointer to,
//   5. last, after every await: the pane's checkout still shows each PR the
//      line names (number AND url). A PR that moved answers 'pr_changed' so
//      the renderer drops only the PR clauses and resends the rest.
// The daemon then writes under its own identity and input-revision proof and
// waits while a person is typing (daemon/callerNudgeDelivery.ts).
//
// Local (non-daemon) mode has no process identity proof, so it never writes:
// `session` answers null and the renderer drops the pointer (the park stays).

import { agentDisplayToSlug } from '../../shared/agentIdentity';
import { isCallerNudge, prNumbersInNudge } from '../../shared/prOwnerNudge';
import type { AgentSlug } from '../../shared/agentIdentity';
import type { GatedSubmitRefusal } from '../../shared/ptyMessageDelivery';

export type FanoutCallerSubmitResult =
  | 'sent'
  /** Nothing written; try again later (typing, draft, busy, usage limit). */
  | 'held'
  /** Nothing written; the pane shows an approval. Wait for its turn end. */
  | 'approval_pending'
  /** Nothing written; the pane left the owner or its agent is gone. */
  | 'gone'
  /** Nothing written; a different agent session now runs in the pane. */
  | 'session_changed'
  /** Nothing written; the pane's checkout no longer shows a PR the line names. */
  | 'pr_changed'
  | 'unavailable'
  | 'error';

export interface FanoutCallerSubmitReply {
  result: FanoutCallerSubmitResult;
  /** The line may be in the composer: never paste it again. */
  pasted: boolean;
}

export interface FanoutCallerSubmitPorts {
  deliveryGate: (ptyId: string) => Promise<GatedSubmitRefusal | null>;
  ownerOf: (ptyId: string) => Promise<string | null>;
  /** The PR the pane's checkout shows now, or null. Absent → PR lines refused. */
  prOf?: (ptyId: string) => { number: number; url: string } | null;
  agentState: (ptyId: string) => Promise<{ agentName: string | null; agentVerified: boolean; incarnationId: string } | null>;
  deliver: (args: { id: string; agentSlug: AgentSlug; incarnationId: string; prompt: string }) => Promise<{
    result: 'sent' | 'held' | 'session_changed' | 'unavailable' | 'error';
    pasted: boolean;
  }>;
}

function str(v: unknown): string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : '';
}

function parseClaimedPrs(raw: unknown): { number: number; url: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).flatMap((p) => {
    const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    const url = str(r.url);
    return typeof r.number === 'number' && Number.isInteger(r.number) && url ? [{ number: r.number, url }] : [];
  });
}

export function createFanoutCallerSubmit(ports: FanoutCallerSubmitPorts): {
  session: (ptyId: unknown) => Promise<{ incarnationId: string } | null>;
  submit: (raw: unknown) => Promise<FanoutCallerSubmitReply>;
} {
  const verified = async (ptyId: string): Promise<{ slug: AgentSlug; incarnationId: string } | null> => {
    const st = await ports.agentState(ptyId).catch(() => null);
    const slug = st?.agentName ? agentDisplayToSlug(st.agentName) : undefined;
    return st && st.agentVerified && slug && st.incarnationId ? { slug, incarnationId: st.incarnationId } : null;
  };
  return {
    session: async (raw) => {
      const ptyId = str(raw);
      if (!ptyId) return null;
      const v = await verified(ptyId);
      return v ? { incarnationId: v.incarnationId } : null;
    },
    submit: async (raw) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const ptyId = str(r.ptyId);
      const owner = str(r.ownerWorkspaceId);
      const incarnationId = str(r.incarnationId);
      if (!ptyId || !owner || !incarnationId || !isCallerNudge(r.text)) return { result: 'error', pasted: false };
      const text = r.text;
      // Every PR the line names must come with the url the renderer resolved
      // the owner by; main proves both against the pane below.
      const claimed = parseClaimedPrs(r.prs);
      const named = prNumbersInNudge(text);
      if (named.some((n) => !claimed.some((c) => c.number === n))) return { result: 'error', pasted: false };
      const refusal = await ports.deliveryGate(ptyId).catch(() => null);
      if (refusal) {
        if (refusal.reason === 'usage_limited') return { result: 'held', pasted: false };
        if (refusal.reason === 'approval_pending') return { result: 'approval_pending', pasted: false };
        return { result: 'unavailable', pasted: false };
      }
      if ((await ports.ownerOf(ptyId).catch(() => null)) !== owner) return { result: 'gone', pasted: false };
      const v = await verified(ptyId);
      if (!v) return { result: 'gone', pasted: false };
      if (v.incarnationId !== incarnationId) return { result: 'session_changed', pasted: false };
      if (named.length > 0) {
        let current: { number: number; url: string } | null | undefined;
        try {
          current = ports.prOf?.(ptyId);
        } catch {
          current = undefined;
        }
        const stillShown = (n: number): boolean =>
          !!current && current.number === n && claimed.some((c) => c.number === n && c.url === current?.url);
        if (!named.every(stillShown)) return { result: 'pr_changed', pasted: false };
      }
      try {
        return await ports.deliver({ id: ptyId, agentSlug: v.slug, incarnationId, prompt: text });
      } catch {
        return { result: 'error', pasted: true };
      }
    },
  };
}
