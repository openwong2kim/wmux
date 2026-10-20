// ─── Settings › Bots: how bots sign in to Claude ───────────────────────────
//
// The mode (factory settings `claudeAuth`, written through the tab's settings
// patch): the owner's Claude subscription (default) or a Claude API key. The
// key row saves a key once (main encrypts it, main/factory/claudeApiKey.ts)
// and from then on shows only that one is saved and its last four
// characters; Remove forgets it, Check connection asks main to try it.
// Below, the sign-in bots actually ran on last, as their sessions reported it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { formatCardTime } from '../Room/roomFormat';
import type { ClaudeAuthMode } from '../../../shared/factorySettings';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The saved key as the renderer sees it: never the key. */
export interface ClaudeKeyStatusView {
  set: boolean;
  last4?: string;
  cannotStore?: { code: string; message: string };
  lastSeen?: { auth: 'subscription' | 'apiKey'; source: string; at: number };
}

export type ClaudeKeyCheckView =
  | { ok: true }
  | { ok: false; code: string; status?: number; message?: string };

export interface ClaudeAuthPort {
  readonly available: boolean;
  status(): Promise<ClaudeKeyStatusView | null>;
  setKey(key: string): Promise<{ ok: true; status: ClaudeKeyStatusView } | { ok: false; code: string; message: string }>;
  removeKey(): Promise<{ ok: boolean; status?: ClaudeKeyStatusView }>;
  check(): Promise<ClaudeKeyCheckView>;
}

type Bridge = Partial<Omit<ClaudeAuthPort, 'available'>>;

export function bridgeClaudeAuthPort(): ClaudeAuthPort {
  const b = (globalThis as { electronAPI?: { factory?: { claudeAuth?: Bridge } } }).electronAPI?.factory?.claudeAuth;
  const none = { ok: false as const, code: 'unavailable', message: 'Not available in this build.' };
  return {
    available: !!b?.status && !!b.setKey,
    status: () => b?.status?.() ?? Promise.resolve(null),
    setKey: (key) => b?.setKey?.(key) ?? Promise.resolve(none),
    removeKey: () => b?.removeKey?.() ?? Promise.resolve({ ok: false }),
    check: () => b?.check?.() ?? Promise.resolve(none),
  };
}

/** The check's answer as one line. Pure over `t`. */
export function claudeKeyCheckText(r: ClaudeKeyCheckView, t: T): { text: string; tone: 'muted' | 'danger' } {
  if (r.ok) return { text: t('settings.factory.claudeAuth.checkOk'), tone: 'muted' };
  const status = r.status ?? '—';
  switch (r.code) {
    case 'invalid_key': return { text: t('settings.factory.claudeAuth.checkInvalid', { status }), tone: 'danger' };
    case 'network': return { text: t('settings.factory.claudeAuth.checkNetwork'), tone: 'danger' };
    case 'no_key': return { text: t('settings.factory.claudeAuth.checkNoKey'), tone: 'danger' };
    default: return { text: t('settings.factory.claudeAuth.checkError', { status }), tone: 'danger' };
  }
}

export function ClaudeAuthSection({ t, mode, disabled, onModeChange, port, now }: {
  t: T;
  mode: ClaudeAuthMode;
  /** The factory settings are not loaded (the mode cannot be changed). */
  disabled: boolean;
  onModeChange: (mode: ClaudeAuthMode) => void;
  port: ClaudeAuthPort;
  now?: number;
}): React.ReactElement | null {
  const [status, setStatus] = useState<ClaudeKeyStatusView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'muted' | 'danger' } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const read = useCallback(() => {
    if (!port.available) return;
    port.status().then((s) => { if (live.current) setStatus(s); }, () => undefined);
  }, [port]);
  useEffect(read, [read]);

  if (!port.available) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      if (live.current) setNote({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const save = () => run(async () => {
    const r = await port.setKey(draft);
    if (!live.current) return;
    if (r.ok) {
      setStatus(r.status);
      setDraft('');
      setNote({ text: t('settings.factory.claudeAuth.saved'), tone: 'muted' });
    } else {
      setNote({ text: t('settings.factory.claudeAuth.saveFailed', { message: r.message }), tone: 'danger' });
    }
  });
  const remove = () => run(async () => {
    const r = await port.removeKey();
    if (!live.current) return;
    setConfirming(false);
    if (r.ok && r.status) setStatus(r.status);
    else setNote({ text: t('settings.factory.claudeAuth.removeFailed'), tone: 'danger' });
  });
  const check = () => run(async () => {
    const r = await port.check();
    if (live.current) setNote(claudeKeyCheckText(r, t));
  });

  const set = status?.set === true;
  const cannotStore = status?.cannotStore
    ? t(status.cannotStore.code === 'basic_text' ? 'botSecret.noKeyring' : 'botSecret.noEncryption')
    : null;
  const seen = status?.lastSeen;

  return (
    <SettingsSection id="factoryclaudeauthsection" title={t('settings.factory.claudeAuth.section')} data-testid="factory-claude-auth">
      <SettingRow id="factoryclaudeauth" label={t('settings.factory.claudeAuth.mode')} description={t('settings.factory.claudeAuth.modeDesc')}>
        <Select
          disabled={disabled}
          data-testid="factory-claude-auth-mode"
          aria-label={t('settings.factory.claudeAuth.mode')}
          value={mode}
          onChange={(e) => onModeChange(e.target.value === 'apiKey' ? 'apiKey' : 'subscription')}
        >
          <option value="subscription">{t('settings.factory.claudeAuth.modeSubscription')}</option>
          <option value="apiKey">{t('settings.factory.claudeAuth.modeApiKey')}</option>
        </Select>
      </SettingRow>
      {(mode === 'apiKey' || set) && (
        <SettingRow
          id="factoryclaudeapikey"
          label={t('settings.factory.claudeAuth.key')}
          description={set && status?.last4 ? t('settings.factory.claudeAuth.keySet', { last4: status.last4 }) : t('settings.factory.claudeAuth.keyNotSet')}
          layout="stacked"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid="factory-claude-key-input"
              aria-label={t('settings.factory.claudeAuth.key')}
              placeholder={t('settings.factory.claudeAuth.keyPlaceholder')}
              value={draft}
              disabled={busy || !!cannotStore}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) void save(); }}
              className="min-w-0 flex-1 text-[13px]"
            />
            <Button size="sm" variant="secondary" data-testid="factory-claude-key-save" disabled={busy || !draft.trim() || !!cannotStore} onClick={() => void save()}>
              {t('settings.factory.claudeAuth.save')}
            </Button>
            <Button size="sm" variant="secondary" data-testid="factory-claude-key-check" disabled={busy || !set} onClick={() => void check()}>
              {t('settings.factory.claudeAuth.check')}
            </Button>
            {set && !confirming && (
              <Button size="sm" variant="destructive" data-testid="factory-claude-key-remove" disabled={busy} onClick={() => setConfirming(true)}>
                {t('settings.factory.claudeAuth.remove')}
              </Button>
            )}
          </div>
          {confirming && (
            <InlineConfirm
              text={t('settings.factory.claudeAuth.removeConfirm')}
              confirmLabel={t('settings.factory.claudeAuth.remove')}
              cancelLabel={t('settings.factory.claudeAuth.cancel')}
              busy={busy}
              onConfirm={() => void remove()}
              onCancel={() => setConfirming(false)}
              testId="factory-claude-key-remove"
            />
          )}
        </SettingRow>
      )}
      {cannotStore && <SettingNote tone="warning">{cannotStore}</SettingNote>}
      {mode === 'apiKey' && status && !set && <SettingNote tone="warning" data-testid="factory-claude-key-missing">{t('settings.factory.claudeAuth.noKeyWarning')}</SettingNote>}
      {note && <SettingNote tone={note.tone} role={note.tone === 'danger' ? 'alert' : 'status'} data-testid="factory-claude-key-note">{note.text}</SettingNote>}
      <SettingNote data-testid="factory-claude-auth-seen" title={seen?.source}>
        {seen
          ? t('settings.factory.claudeAuth.lastSeen', {
            auth: t(seen.auth === 'apiKey' ? 'settings.factory.claudeAuth.seenApiKey' : 'settings.factory.claudeAuth.seenSubscription'),
            when: formatCardTime(seen.at, now),
          })
          : t('settings.factory.claudeAuth.lastSeenNone')}
      </SettingNote>
    </SettingsSection>
  );
}
