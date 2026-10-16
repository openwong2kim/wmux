// ─── The room composer ───────────────────────────────────────────────────────
//
// One box (the shared composer shell: a hairline, no fill, 14px input, a
// solid 26px send) and one row of bot chips under it. A message is a `human`
// card in the shown thread (`general` when the whole room is shown). With no
// chip picked it is for the room: main wakes every bot of the workspace, and
// they may answer each other. A picked chip addresses that bot only (several
// may be picked): the chips become the post's `mentions` (bot ids) and main
// wakes those bots. Starting the message with `@` and a bot's name picks its
// chip (any bot, a room elsewhere included; this room's bot wins a shared
// name); deleting the name unpicks it. An `@name` inside a sentence is plain
// text and picks nothing. The text itself addresses nobody: main reads the
// field, never the text.
//
// Never disabled: a bot that is mid-turn queues the message. When the bot
// port reports a lone addressee running another turn than the one this
// message woke, the line under the box says "Queued for <bot>"; otherwise it
// names who the message went to, as main answered. With no enabled bot in
// this workspace, the row says so and points to Settings › Factory.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { isCoordinatorBot, type BotRole } from '../../../shared/bot';
import type { ThreadId } from '../../../shared/room';
import { FOCUS_RING } from '../focusRing';
import { roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import { useStore } from '../../stores';
import type { FactoryBotRow } from './factoryPorts';
import { actorLabel, messageTitle, roleLabel, type RoomActorView } from './roomFormat';
import Button from '../ui/Button';
import '../Chat/chatMono.css';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The room.post params for one message. Pure. */
export function roomPostParams(args: {
  workspaceId: string;
  threadId: ThreadId;
  text: string;
  /** The bots it is for; none = the whole room. */
  mentions?: readonly string[];
  clientPostId: string;
}): Parameters<RoomsApi['post']>[0] | null {
  const text = args.text.trim();
  const title = messageTitle(text);
  if (!title) return null;
  return {
    workspaceId: args.workspaceId,
    threadId: args.threadId,
    title,
    ...(text !== title ? { body: text } : {}),
    ...(args.mentions && args.mentions.length > 0 ? { mentions: [...args.mentions] } : {}),
    clientPostId: args.clientPostId,
  };
}

function newClientPostId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `desk-${Date.now().toString(36)}-${rand}`;
}

/** One bot a message went to, and the wake it queued. */
export interface SentTo { botId: string; role: BotRole; wakeId?: string }

/** Who main says a post went to: every addressee (null: no bot to wake). */
export function sentFrom(r: { addressee?: { botId: string; role: BotRole } | null; wakeId?: string; addressees?: readonly SentTo[] }): SentTo[] | null {
  if (r.addressees) return r.addressees.length > 0 ? [...r.addressees] : null;
  return r.addressee ? [{ ...r.addressee, ...(r.wakeId ? { wakeId: r.wakeId } : {}) }] : null;
}

/** Whether a lone addressee is running a turn for something else, so the
 *  message waits behind it. Pure. */
export function deliveryQueued(sent: readonly SentTo[] | null | undefined, bots: readonly FactoryBotRow[]): boolean {
  if (!sent || sent.length !== 1) return false;
  const turn = bots.find((b) => b.bot.id === sent[0].botId)?.status?.currentTurn;
  return !!turn && turn.wakeId !== sent[0].wakeId;
}

/** Whether a lone addressee has been seen taking a message up: running the
 *  turn it woke, or — on a status read after the send (`fresh`) — idle with
 *  nothing queued, so that turn has run. A message without a wake id is
 *  never known taken. Pure. */
export function deliveryTaken(sent: readonly SentTo[] | null | undefined, bots: readonly FactoryBotRow[], fresh: boolean): boolean {
  if (!sent || sent.length !== 1 || !sent[0].wakeId) return false;
  const status = bots.find((b) => b.bot.id === sent[0].botId)?.status;
  if (!status) return false;
  if (status.currentTurn) return status.currentTurn.wakeId === sent[0].wakeId;
  return fresh && status.queueDepth === 0;
}

/** The line under the box after a send: a lone addressee queued behind a
 *  turn it is running for something else, or who the message went to (also
 *  once the bot is running the turn this message woke). `started`: the bot
 *  has been seen taking the message up, so a later turn of its own does not
 *  read as the message queuing again. A bot no longer running is named as
 *  main's bot store keeps it (`actors`: a removed bot's name, marked
 *  removed), else by its role. */
export function deliveryLine(
  sent: readonly SentTo[] | null | undefined,
  bots: readonly FactoryBotRow[],
  t: T,
  started = false,
  actors: Readonly<Record<string, RoomActorView>> = {},
): string | null {
  if (sent === undefined) return null;
  if (sent === null || sent.length === 0) return t('room.composer.noAddressee');
  const nameOf = (s: SentTo) => (bots.some((b) => b.bot.id === s.botId) || actors[s.botId]?.name?.trim()
    ? actorLabel({ kind: 'bot', workspaceId: '', botId: s.botId }, t, bots, actors)
    : roleLabel(s.role, t));
  if (sent.length === 1) {
    if (!started && deliveryQueued(sent, bots)) return t('room.composer.queuedFor', { name: nameOf(sent[0]) });
    return t('room.composer.sentTo', { name: nameOf(sent[0]) });
  }
  if (sent.length <= 3) return t('room.composer.sentTo', { name: sent.map(nameOf).join(', ') });
  return t('room.composer.sentToBots', { count: sent.length });
}

/** The bots main will wake for a message here (humanMessage.ts): the
 *  mentioned ones that are on, else every enabled bot of the workspace,
 *  oldest first. Pure. */
export function predictedAddressees(bots: readonly FactoryBotRow[], workspaceId: string, mentions: readonly string[]): FactoryBotRow[] {
  const on = bots.filter((r) => r.bot.enabled);
  if (mentions.length > 0) return mentions.map((id) => on.find((r) => r.bot.id === id)).filter((r): r is FactoryBotRow => !!r);
  return on.filter((r) => r.bot.workspaceId === workspaceId).sort((a, b) => a.bot.createdAt - b.bot.createdAt);
}

/** The bots a chip row offers here: the enabled bots of this workspace,
 *  oldest first. Pure. */
export function roomBots(bots: readonly FactoryBotRow[], workspaceId: string): FactoryBotRow[] {
  return bots.filter((r) => r.bot.enabled && r.bot.workspaceId === workspaceId).sort((a, b) => a.bot.createdAt - b.bot.createdAt);
}

const WORD = /[A-Za-z0-9_]/;
/** What may sit between two leading names: spaces and list commas. */
const BETWEEN = /[\s,\u3001\uff0c]/;

/** The bots named at the very start of the text: a leading `@<name>`, or a
 *  run of them (`@A @B, please …`), in order. An `@name` later in the
 *  sentence is plain text and addresses nobody. A longer name wins over one
 *  it starts with ("@Wmux Dev" is not "@Wmux"); a shared name goes to this
 *  workspace's bot, else the oldest. A Latin name ends at a non-word
 *  character; a name ending in another script may run straight into the
 *  next word (a particle), which ends the run. Pure. */
export function typedMentions(text: string, bots: readonly FactoryBotRow[], workspaceId: string): string[] {
  const lower = text.toLowerCase();
  if (!lower.includes('@')) return [];
  const here = (r: FactoryBotRow) => (r.bot.workspaceId === workspaceId ? 0 : 1);
  const candidates = bots
    .filter((r) => r.bot.enabled && r.bot.name.trim())
    .sort((a, b) => b.bot.name.trim().length - a.bot.name.trim().length || here(a) - here(b) || a.bot.createdAt - b.bot.createdAt);
  const out: string[] = [];
  let at = 0;
  while (at < lower.length && /\s/.test(lower.charAt(at))) at += 1;
  while (lower.charAt(at) === '@') {
    let end = -1;
    for (const r of candidates) {
      const name = r.bot.name.trim().toLowerCase();
      if (!lower.startsWith(name, at + 1)) continue;
      const stop = at + 1 + name.length;
      const next = lower.charAt(stop);
      if (next && WORD.test(name.charAt(name.length - 1)) && WORD.test(next)) continue;
      if (!out.includes(r.bot.id)) out.push(r.bot.id);
      end = stop;
      break;
    }
    if (end < 0) break;
    at = end;
    while (at < lower.length && BETWEEN.test(lower.charAt(at))) at += 1;
  }
  return out;
}

/** The picked bots of a composer: chips toggled by hand, and names typed as
 *  a leading `@name` (typing one picks it, deleting it unpicks it). */
export function useMentionPicks(bots: readonly FactoryBotRow[], workspaceId: string) {
  const [picked, setPicked] = useState<string[]>([]);
  const typed = useRef<string[]>([]);
  const onText = useCallback((text: string) => {
    const now = typedMentions(text, bots, workspaceId);
    const before = typed.current;
    typed.current = now;
    const gone = before.filter((id) => !now.includes(id));
    const added = now.filter((id) => !before.includes(id));
    if (gone.length === 0 && added.length === 0) return;
    setPicked((cur) => [...cur.filter((id) => !gone.includes(id)), ...added.filter((id) => !cur.includes(id))]);
  }, [bots, workspaceId]);
  const toggle = useCallback((id: string) => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);
  const reset = useCallback(() => {
    typed.current = [];
    setPicked([]);
  }, []);
  return { picked, onText, toggle, reset };
}

/** The bot a room message with no bot picked goes to when the room has a
 *  coordinator (its oldest enabled one; main's rule, humanMessage.ts), or
 *  null when it goes to every bot. Pure. */
export function roomLead(candidates: readonly FactoryBotRow[]): FactoryBotRow | null {
  return [...candidates].filter((r) => r.bot.enabled && isCoordinatorBot(r.bot)).sort((a, b) => a.bot.createdAt - b.bot.createdAt)[0] ?? null;
}

/** The chip row: one chip per bot of the room (and any bot picked from
 *  elsewhere), pressed when picked; with none picked, a muted line says
 *  where the message goes: "To everyone here", or "To <lead>" in a room
 *  with a coordinator. */
export function MentionChips({ candidates, bots, picked, onToggle, t, testId }: {
  candidates: readonly FactoryBotRow[];
  bots: readonly FactoryBotRow[];
  picked: readonly string[];
  onToggle: (botId: string) => void;
  t: T;
  testId: string;
}): React.ReactElement {
  const lead = roomLead(candidates);
  const elsewhere = picked
    .filter((id) => !candidates.some((r) => r.bot.id === id))
    .map((id) => bots.find((r) => r.bot.id === id))
    .filter((r): r is FactoryBotRow => !!r);
  return (
    <div role="group" aria-label={t('room.composer.to')} data-testid={`${testId}-chips`} className="flex flex-wrap items-center gap-1">
      {picked.length === 0 && <span data-testid={`${testId}-to-room`} className="mr-0.5 text-[11px] text-[var(--text-muted)]">{lead ? t('room.composer.toLead', { name: lead.bot.name }) : t('room.composer.toRoom')}</span>}
      {[...candidates, ...elsewhere].map((r) => {
        const on = picked.includes(r.bot.id);
        return (
          <button
            key={r.bot.id}
            type="button"
            data-testid={`${testId}-bot`}
            data-bot-id={r.bot.id}
            aria-pressed={on}
            onClick={() => onToggle(r.bot.id)}
            className={`h-[24px] max-w-[160px] truncate px-2 rounded-[var(--chip-radius)] text-[12px] ${on ? 'bg-[var(--selection-emphasis)] text-[var(--text-main)]' : 'bg-[var(--selection)] text-[var(--text-sub)] hover:bg-[var(--selection-hover)]'} ${FOCUS_RING}`}
          >
            @{r.bot.name}
          </button>
        );
      })}
    </div>
  );
}

export function RoomComposer({ workspaceId, threadId, bots, t, api, onAddBot }: {
  workspaceId: string;
  threadId: ThreadId;
  /** Every bot the bot port lists (a bot of another room may be named). */
  bots: readonly FactoryBotRow[];
  t: T;
  api?: RoomsApi | null;
  /** Opens Settings › Factory (the "no bot here" line's button). */
  onAddBot?: () => void;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentTo[] | null | undefined>(undefined);
  // Once taken up, the last message stays sent (see deliveryLine).
  const [started, setStarted] = useState(false);
  const botsAtSend = useRef(bots);
  useEffect(() => {
    if (sent !== undefined && !started && deliveryTaken(sent, bots, bots !== botsAtSend.current)) setStarted(true);
  }, [sent, bots, started]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const textNow = useRef(text);
  const mentions = useMentionPicks(bots, workspaceId);
  // A send that failed keeps its clientPostId for the same message, so a
  // retry is that message again (main queues its missing wakes once), not a
  // new card.
  const failedPost = useRef<{ key: string; clientPostId: string } | null>(null);
  const here = roomBots(bots, workspaceId);
  // `t` reads the store's language: callbacks and memos keyed on it also
  // key on the locale, so they re-word after a language change.
  const locale = useStore((s) => s.locale);

  const submit = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (inFlight) return;
    const bridge = api === undefined ? roomsApi() : api;
    const submitted = text;
    const key = JSON.stringify([workspaceId, threadId, text, mentions.picked]);
    const clientPostId = failedPost.current?.key === key ? failedPost.current.clientPostId : newClientPostId();
    const params = roomPostParams({ workspaceId, threadId, text, mentions: mentions.picked, clientPostId });
    if (!params) return;
    if (!bridge) {
      setError(t('room.composer.unavailable'));
      return;
    }
    setInFlight(true);
    setError(null);
    try {
      const r = await bridge.post(params);
      failedPost.current = r.ok ? null : { key, clientPostId };
      if (r.ok) {
        // Only the sent draft is cleared (with its picks); text typed meanwhile stays.
        if (textNow.current === submitted) {
          textNow.current = '';
          setText('');
          mentions.reset();
        }
        setSent(sentFrom(r));
        setStarted(false);
        botsAtSend.current = bots;
        inputRef.current?.focus();
      } else {
        setError(r.message || t('room.composer.failed'));
      }
    } catch (err) {
      failedPost.current = { key, clientPostId };
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(false);
    }
  }, [api, inFlight, workspaceId, threadId, text, mentions, t, locale]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a newline; an IME composition's Enter
    // commits the composition. Keys never reach the focused terminal.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
    }
  };

  // Before a send: a lone bot this message would wake is mid-turn, so it will queue.
  const next = predictedAddressees(bots, workspaceId, mentions.picked);
  const busy = next.length === 1 && next[0].status?.currentTurn ? next[0] : null;
  const line = error
    ?? (text.trim() && busy ? t('room.composer.willQueue', { name: busy.bot.name }) : null)
    ?? deliveryLine(sent, bots, t, started);

  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="room-composer"
      data-channel-composer
      data-in-flight={inFlight ? 'true' : 'false'}
      className="wmux-channel-composer wmux-chat-composer"
    >
      <div className="relative flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          data-testid="room-composer-input"
          aria-label={t('room.composer.label')}
          placeholder={t('room.composer.placeholder')}
          onChange={(e) => { textNow.current = e.target.value; setText(e.target.value); mentions.onText(e.target.value); if (error) setError(null); }}
          onKeyDown={onKeyDown}
          className="wmux-chat-input wmux-channel-input text-[14px]"
        />
        <button
          type="submit"
          data-testid="room-composer-send"
          disabled={!text.trim() || inFlight}
          aria-label={t('room.composer.send')}
          title={t('room.composer.send')}
          className="wmux-chat-send wmux-chat-icon-button wmux-channel-send"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="7" y1="11" x2="7" y2="3" />
            <polyline points="3.5,6.5 7,3 10.5,6.5" />
          </svg>
        </button>
      </div>
      {here.length === 0 && mentions.picked.length === 0 ? (
        <div data-testid="room-composer-no-bots" className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <span>{t('room.composer.noBots')}</span>
          {onAddBot && (
            <Button size="sm" variant="ghost" data-testid="room-composer-add-bot" onClick={onAddBot}>
              {t('room.composer.addBot')}
            </Button>
          )}
        </div>
      ) : (
        <MentionChips candidates={here} bots={bots} picked={mentions.picked} onToggle={mentions.toggle} t={t} testId="room-composer" />
      )}
      {line && (
        <p role="status" data-testid="room-composer-status" className={`text-[11px] ${error ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
          {line}
        </p>
      )}
    </form>
  );
}
