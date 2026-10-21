// ─── A bot's profile: what it runs ──────────────────────────────────────────
//
// The commands and file edits a bot runs in its own folder (shared/
// botCommand.ts), through the preload bridge `electronAPI.factory.commands`
// (main-window IPC). Shown only where the bot runs commands at all (a Claude
// SDK bot on a machine with the OS sandbox and a new enough Claude Code).
// One switch lets the bot run them (on by default; off, it holds none of the
// tools). Under it main's recent decisions, newest first, a few at a time:
// when, the command or path, allowed or refused (a refusal's word red) and
// why (a reviewer verdict with its risk and rationale);
// every one warns and asks to confirm first, since a program not on the
// list may run code from files in the bot's folder, which the bot can change; a command refused as not on the list has Always allow, which adds an
// owner rule for exactly that command — offered only where main says the
// rule would be saved (never for a built-in command, whose option checks
// stay), and main checks it again and says why when it refuses. Last, the owner's rules, each with Remove. Every
// text is masked by main before it gets here.
import { useCallback, useEffect, useRef, useState } from 'react';
import Switch from '../ui/Switch';
import { FOCUS_RING } from '../focusRing';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { getFactoryBotPort } from '../Room/factoryPorts';
import { timeAgo } from '../../utils/timeAgo';
import {
  RULE_ALLOWABLE_LAYERS,
  type BotCommandAllowRequest,
  type BotCommandLogEntry,
  type BotCommandReadResult,
  type BotCommandRemoveRuleRequest,
  type BotCommandSetEnabledRequest,
  type BotCommandSimpleResult,
} from '../../../shared/botCommand';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface BotCommandPort {
  readonly available: boolean;
  read(botId: string): Promise<BotCommandReadResult>;
  setEnabled(req: BotCommandSetEnabledRequest): Promise<BotCommandSimpleResult>;
  allow(req: BotCommandAllowRequest): Promise<BotCommandSimpleResult>;
  removeRule(req: BotCommandRemoveRuleRequest): Promise<BotCommandSimpleResult>;
}

const UNAVAILABLE = { ok: false as const, error: 'Bot commands are not available in this build.' };

function bridgePort(): BotCommandPort {
  const api = (globalThis as { electronAPI?: { factory?: { commands?: Partial<BotCommandPort> } } }).electronAPI;
  const b = api?.factory?.commands;
  return {
    available: !!b?.read && !!b.setEnabled && !!b.allow && !!b.removeRule,
    read: (botId) => b?.read?.(botId) ?? Promise.resolve(UNAVAILABLE),
    setEnabled: (req) => b?.setEnabled?.(req) ?? Promise.resolve(UNAVAILABLE),
    allow: (req) => b?.allow?.(req) ?? Promise.resolve(UNAVAILABLE),
    removeRule: (req) => b?.removeRule?.(req) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotCommandPort | null = null;

export function getBotCommandPort(): BotCommandPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotCommandPort(next: BotCommandPort | null): void {
  port = next;
}

/** How many decisions show before Show more, and how many more each adds. */
export const COMMANDS_PAGE = 20;

type CommandsView = Extract<BotCommandReadResult, { ok: true }>;

/** One bot's commands, re-read on every bot event (main pushes
 *  `commands-changed` there). */
export function useBotCommands(botId: string, p: BotCommandPort = getBotCommandPort()): CommandsView | null {
  const [state, setState] = useState<CommandsView | null>(null);
  const reload = useCallback(() => {
    if (!p.available) return;
    p.read(botId).then((r) => {
      if (r?.ok) setState(r);
    }, () => undefined);
  }, [p, botId]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return state;
}

const KNOWN_LAYERS = new Set(['attended', 'parse', 'floor', 'allowlist', 'rule', 'unlisted', 'script', 'reviewer', 'path', 'input', 'off']);

/** Where a decision was made, in the owner's words (an unknown layer as it
 *  is). Pure but for `t`. */
export function commandLayerText(layer: string, t: T): string {
  return KNOWN_LAYERS.has(layer) ? t(`bots.commands.layer.${layer}`) : layer;
}

/** Whether a decision offers Always allow: main said its rule would be
 *  saved (a command refused as not on the list, its head not a built-in
 *  command) and it is a Bash refusal. Main checks again. Pure. */
export function canAlwaysAllow(e: BotCommandLogEntry): boolean {
  return e.canAllow === true && e.tool === 'Bash' && e.decision === 'deny' && !!e.target && RULE_ALLOWABLE_LAYERS.includes(e.layer);
}

/** A reviewer decision's risk and rationale (` · Low risk · …`), or ''. Pure but for `t`. */
export function reviewText(e: BotCommandLogEntry, t: T): string {
  const r = e.review;
  if (!r) return '';
  const risk = r.risk === 'low' || r.risk === 'medium' || r.risk === 'high' ? ` · ${t(`bots.commands.risk.${r.risk}`)}` : '';
  return `${risk}${r.rationale ? ` · ${r.rationale}` : ''}`;
}

export function BotCommands({ row, t, port: p = getBotCommandPort() }: { row: FactoryBotRow; t: T; port?: BotCommandPort }): React.ReactElement | null {
  const botId = row.bot.id;
  const view = useBotCommands(botId, p);
  const [shown, setShown] = useState(COMMANDS_PAGE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The entry whose Always allow waits for the owner's confirm.
  const [confirming, setConfirming] = useState<string | null>(null);
  // One request at a time (the ref holds it between a click and the next render).
  const inFlight = useRef(false);
  if (!p.available || !view || !view.available) return null;
  const act = (run: () => Promise<BotCommandSimpleResult>, failed: string): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    run().then((r) => {
      if (!r.ok) setError(r.error);
    }, () => setError(failed)).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };
  const entries = view.entries.slice(0, shown);
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-commands>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('bots.commands.label')}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[var(--text-main)]">{t('bots.commands.switch')}</span>
          <Switch
            checked={view.enabled}
            disabled={busy}
            aria-label={t('bots.commands.switch')}
            data-testid="bot-commands-switch"
            onCheckedChange={(v) => act(() => p.setEnabled({ botId, enabled: v }), t('bots.commands.switchFailed'))}
          />
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">{t('bots.commands.hint')}</p>
        <div data-bot-commands-log>
          <span className="text-[var(--text-muted)]">{t('bots.commands.recent')}</span>
          {view.entries.length === 0 && <p className="text-[var(--text-muted)]">{t('bots.commands.empty')}</p>}
          <ul className="space-y-1">
            {entries.map((e) => (
              <li key={e.id} data-bot-command-entry={e.id} data-decision={e.decision}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-main)]" title={e.target}>{e.target ?? e.tool}</span>
                  {canAlwaysAllow(e) && confirming !== e.id && (
                    <button
                      type="button"
                      data-testid={`bot-command-allow-${e.id}`}
                      disabled={busy}
                      onClick={() => (e.runsCode ? setConfirming(e.id) : act(() => p.allow({ botId, entryId: e.id }), t('bots.commands.allowFailed')))}
                      className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}
                    >
                      {t('bots.commands.alwaysAllow')}
                    </button>
                  )}
                </div>
                {confirming === e.id && (
                  <div className="flex items-center gap-2 text-[11px]" data-bot-command-confirm={e.id}>
                    <span className="min-w-0 flex-1 text-[var(--accent-yellow)]">{t('bots.commands.runsCodeWarning')}</span>
                    <button type="button" data-testid={`bot-command-allow-confirm-${e.id}`} disabled={busy} onClick={() => { setConfirming(null); act(() => p.allow({ botId, entryId: e.id, confirm: true }), t('bots.commands.allowFailed')); }} className={`shrink-0 text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}>
                      {t('bots.commands.allowAnyway')}
                    </button>
                    <button type="button" data-testid={`bot-command-allow-cancel-${e.id}`} onClick={() => setConfirming(null)} className={`shrink-0 text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
                      {t('room.hq.cancel')}
                    </button>
                  </div>
                )}
                <p className="text-[11px] text-[var(--text-muted)]">
                  <span className={e.decision === 'deny' ? 'text-[var(--accent-red)]' : undefined}>{t(e.decision === 'deny' ? 'bots.commands.refused' : 'bots.commands.allowed')}</span>
                  {` · ${timeAgo(e.at)} · ${e.tool} · ${commandLayerText(e.layer, t)}${reviewText(e, t)}${e.reason ? ` · ${e.reason}` : ''}`}
                </p>
              </li>
            ))}
          </ul>
          {view.entries.length > shown && (
            <button type="button" data-testid="bot-commands-more" onClick={() => setShown((n) => n + COMMANDS_PAGE)} className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
              {t('bots.commands.showMore')}
            </button>
          )}
        </div>
        <div data-bot-commands-rules>
          <span className="text-[var(--text-muted)]">{t('bots.commands.rules')}</span>
          {view.rules.length === 0 && <p className="text-[var(--text-muted)]">{t('bots.commands.rulesEmpty')}</p>}
          <ul className="space-y-0.5">
            {view.rules.map((r, i) => (
              <li key={`${i}:${r.text}`} data-bot-command-rule={i} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-main)]">{r.anyArgs ? t('bots.commands.ruleAnyArgs', { rule: r.text }) : r.text}</span>
                <button type="button" data-testid={`bot-command-rule-remove-${i}`} disabled={busy} onClick={() => act(() => p.removeRule({ botId, index: i, text: r.text }), t('bots.commands.removeFailed'))} className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}>
                  {t('bots.commands.remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {error && <p role="alert" className="text-[var(--accent-red)]">{error}</p>}
      </div>
    </div>
  );
}
