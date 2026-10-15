// ─── A bot's avatar ──────────────────────────────────────────────────────────
//
// The owner's picture for the bot (BotProfile.avatar, a small square PNG main
// wrote), or, without one, the bot's Mochi character (owner decision
// 2026-10-16): the character of its identity colour slot, so a bot keeps its
// character everywhere and a room's bots never share one while the eight
// last (DESIGN.md, Bots page: Avatars). It breathes, blinks and twitches at
// rest and hops while its bot works (`working`); botAvatar.css holds the
// motion. Identity colours are never state colours, so a character can never
// read as a status. `botInitials` stays for the places that write a name's
// letters.
//
// Decorative by default (the name is always written beside it); pass `alt`
// where the avatar stands alone.
import { useEffect, useId, useRef } from 'react';
import type { BotProfile } from '../../../shared/bot';
import { MOCHI_CHARACTERS, type MochiCharacter } from './mochiCharacters';
import './botAvatar.css';

type T = (key: string, vars?: Record<string, string | number>) => string;

const AVATAR_PREFIX = 'data:image/png;base64,';

/** Hangul syllables and jamo, CJK ideographs, kana: one character reads as
 *  the initial. */
const SYLLABIC_RE = /^[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/u;

/** The tile's letters for a name (1–2), or for `fallback` when the name is
 *  blank. */
export function botInitials(name: string, fallback: string): string {
  const source = name.trim() || fallback.trim();
  const words = source.split(/[\s._\-/:@]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0];
  if (SYLLABIC_RE.test(first)) return first;
  const second = words.length > 1 ? Array.from(words[1])[0] : '';
  return (first + (second && !SYLLABIC_RE.test(second) ? second : '')).toLocaleUpperCase();
}

/**
 * Bot identity colours (owner decision 2026-10-14: each bot is told apart by
 * its own colour, as in the reference messenger; since 2026-10-16 each colour
 * is a Mochi character's body, MOCHI_CHARACTERS in the same order). An identity
 * colour is never a state colour: no red, orange, yellow or green — the
 * error, needs-you, caution and done meanings keep those. Each hue is mixed
 * toward the look's `--text-main`, so it darkens on a light look and lightens
 * on a dark one and reads on `--bg-base` as a name.
 */
export const BOT_IDENTITY_HUES = ['#3d6ff5', '#5b5bd6', '#7c4ddb', '#9d3fd1', '#c0359f', '#0b8fb0', '#2a8fd8', '#5a6b8c'] as const;

function idHash(botId: string): number {
  let h = 0;
  for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) >>> 0;
  return h;
}

/** The order a room's bots take the identity colours in: each next colour
 *  far from those before it (teal, violet, magenta, blue, slate, …), never
 *  the palette's neighbour, so a room's first five bots read apart. */
export const IDENTITY_SPREAD = [5, 2, 4, 0, 7, 3, 6, 1] as const;

type IdentityBot = Pick<BotProfile, 'id' | 'createdAt' | 'workspaceId'>;

/** Each bot's colour among `bots`, per room (workspace): oldest first (then
 *  by id), a bot takes the first colour of IDENTITY_SPREAD that the fewest
 *  bots of its room hold (`taken`: colours its room's bots already hold) —
 *  two bots of a room never share one while the palette lasts. Pure. */
export function identityHueIndexes(bots: readonly IdentityBot[], taken: readonly { workspaceId: string; index: number }[] = []): Map<string, number> {
  const n = BOT_IDENTITY_HUES.length;
  const order = [...bots].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map<string, number[]>();
  const usedIn = (ws: string) => {
    let u = used.get(ws);
    if (!u) { u = new Array<number>(n).fill(0); used.set(ws, u); }
    return u;
  };
  for (const t of taken) usedIn(t.workspaceId)[t.index] += 1;
  const out = new Map<string, number>();
  for (const b of order) {
    if (out.has(b.id)) continue;
    const u = usedIn(b.workspaceId);
    const least = Math.min(...u);
    const pick = IDENTITY_SPREAD.find((i) => u[i] === least) ?? IDENTITY_SPREAD[0];
    u[pick] += 1;
    out.set(b.id, pick);
  }
  return out;
}

// Each listed bot's colour in this window. A bot keeps its colour while it
// exists; a removed bot's colour is free again for the next one added.
const assigned = new Map<string, { index: number; workspaceId: string }>();

/** Records listed bots, so their colours are told apart (useFactoryBots).
 *  `complete`: the list is every bot, so one missing from it was removed. */
export function noteBotIdentities(bots: readonly IdentityBot[], complete = false): void {
  if (complete) {
    const listed = new Set(bots.map((b) => b.id));
    for (const id of [...assigned.keys()]) if (!listed.has(id)) assigned.delete(id);
  }
  const fresh = bots.filter((b) => !assigned.has(b.id));
  if (fresh.length === 0) return;
  for (const [id, index] of identityHueIndexes(fresh, [...assigned.values()])) {
    assigned.set(id, { index, workspaceId: fresh.find((b) => b.id === id)!.workspaceId });
  }
}

// A removed bot's colour, from its tombstone (main's bots.json `removed`):
// its old cards keep the face it had.
const removedHues = new Map<string, number>();

/** Records removed bots' colour slots (useRoomSync loadRoomActors, and the
 *  Bots page as it removes one). */
export function noteRemovedBotHues(entries: Iterable<readonly [string, number]>): void {
  for (const [id, index] of entries) if (Number.isInteger(index) && index >= 0 && index < BOT_IDENTITY_HUES.length) removedHues.set(id, index);
}

function hueIndex(botId: string): number {
  return assigned.get(botId)?.index ?? removedHues.get(botId) ?? idHash(botId) % BOT_IDENTITY_HUES.length;
}

/** A bot's colour slot now (kept with it when it is removed). */
export function botHueIndex(botId: string): number {
  return hueIndex(botId);
}

/** A bot's identity colour, as CSS (the same bot, the same colour). */
export function botIdentityColor(botId: string): string {
  const hue = BOT_IDENTITY_HUES[hueIndex(botId)];
  return `color-mix(in oklab, ${hue} 72%, var(--text-main))`;
}

/** A bot's character: the one of its identity colour slot (the same bot,
 *  the same character and colour). */
export function botCharacter(botId: string): MochiCharacter {
  return MOCHI_CHARACTERS[hueIndex(botId)];
}

/** At this edge and under, a character only blinks: pill stacks and tiny
 *  marks stay still. */
export const SMALL_AVATAR_PX = 24;

// One observer for every animated avatar: an avatar off screen (or in a
// hidden panel) is paused, so a long list costs nothing. Without
// IntersectionObserver every avatar plays.
let observer: IntersectionObserver | null = null;
function offscreenObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) e.target.toggleAttribute('data-avatar-offscreen', !e.isIntersecting);
  });
  return observer;
}

/** The neutral mark of a bot not made yet: a grey mochi, still. */
function PlaceholderMochi() {
  return (
    <>
      <g style={{ fill: 'var(--text-muted)' }}>
        <ellipse cx="8.4" cy="21.5" rx="3" ry="1.65" />
        <ellipse cx="15.6" cy="21.5" rx="3" ry="1.65" />
        <circle cx="12" cy="13.4" r="8.4" />
      </g>
      <g style={{ fill: 'var(--bg-base)' }}>
        <ellipse cx="9.1" cy="12.6" rx="1.5" ry="1.8" />
        <ellipse cx="14.9" cy="12.6" rx="1.5" ry="1.8" />
        <path d="M9.7 15.55C10.55 17.4 13.45 17.4 14.3 15.55C13.2 16.5 10.8 16.5 9.7 15.55Z" />
      </g>
    </>
  );
}

export interface BotAvatarProps {
  bot: Pick<BotProfile, 'id' | 'name' | 'role' | 'avatar'>;
  /** Edge in px. */
  size: number;
  className?: string;
  /** The accessible name when the avatar stands alone (default: hidden). */
  alt?: string;
  /** Kept for callers that pass a translator; the mark has no words. */
  t?: T;
  /** A bot not made yet (the add form): a neutral grey mochi, no identity
   *  and no motion. */
  placeholder?: boolean;
  /** The bot is running now: its character hops (not at SMALL_AVATAR_PX and
   *  under). Pass it only where it reads as "busy now". */
  working?: boolean;
}

export default function BotAvatar({ bot, size, className, alt, placeholder = false, working = false }: BotAvatarProps): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  // This instance's own gradient id: the same character can be on the page
  // many times, some in hidden panels, so ids are never shared.
  const gid = `bot-avatar-${useId().replace(/[^\w-]/g, '')}`;
  const picture = typeof bot.avatar === 'string' && bot.avatar.startsWith(AVATAR_PREFIX) ? bot.avatar : null;
  const animated = picture === null && !placeholder;
  useEffect(() => {
    const el = ref.current;
    const obs = animated ? offscreenObserver() : null;
    if (!el || !obs) return;
    obs.observe(el);
    return () => {
      obs.unobserve(el);
      el.removeAttribute('data-avatar-offscreen');
    };
  }, [animated]);
  const radius = Math.max(3, Math.round(size * 0.22));
  const a11y = alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true as const };
  const box = { width: size, height: size, borderRadius: radius };
  if (picture !== null) {
    return (
      <span {...a11y} data-bot-avatar="image" className={`inline-block shrink-0 overflow-hidden ${className ?? ''}`} style={box}>
        <img src={picture} alt="" draggable={false} width={size} height={size} className="block w-full h-full object-cover" />
      </span>
    );
  }
  if (placeholder) {
    return (
      <span {...a11y} data-bot-avatar="placeholder" className={`inline-flex shrink-0 ${className ?? ''}`} style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><PlaceholderMochi /></svg>
      </span>
    );
  }
  // No picture: the bot's own character, moving.
  const character = botCharacter(bot.id);
  const { Art } = character;
  return (
    <span
      ref={ref}
      {...a11y}
      data-bot-avatar="face"
      data-avatar-character={character.name}
      data-avatar-small={size <= SMALL_AVATAR_PX ? '' : undefined}
      className={`wmux-mochi inline-flex shrink-0${working ? ' is-working' : ''} ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" overflow="visible" aria-hidden="true"><Art gid={gid} /></svg>
    </span>
  );
}
