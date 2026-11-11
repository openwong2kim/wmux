// ─── Settings › Accounts: one account's vault ──────────────────────────────
//
// The values an account's panes get as env vars (main/account/accountVault.ts).
// The renderer never holds a value: a save reads the clipboard in main, a
// generated value is made in main, and the list carries names, length and a
// short fingerprint only. A Claude account's sign-in token is listed as a
// managed row: it is added and removed through the token sign-in path in the
// account's ⋯ menu, never here.

import { useCallback, useEffect, useState } from 'react';
import type { AccountRow } from '../../../main/ipc/handlers/account.handler';
import type { AccountVaultEntry } from '../../../main/account/accountVault';
import { BOT_SECRET_LIMITS, isBotSecretName } from '../../../shared/botSecret';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import Input from '../ui/Input';
import { InlineConfirm } from '../Bots/InlineConfirm';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Why nothing can be added to the vault right now. */
export type VaultAddBlock = 'encryption_unavailable' | 'basic_text' | 'store_unreadable' | 'full' | null;

/** Generated value lengths, as the store's `generate` clamps them. */
export const GENERATE_LENGTH = { min: BOT_SECRET_LIMITS.VALUE_MIN, max: 256, fallback: 40 } as const;

/** Whether an add (save or generate) can run: storage first, then the limit. Pure. */
export function vaultAddBlock(count: number, max: number, cannotStore: { code: string } | null | undefined): VaultAddBlock {
  const code = cannotStore?.code;
  if (code === 'encryption_unavailable' || code === 'basic_text' || code === 'store_unreadable') return code;
  return count >= max ? 'full' : null;
}

/** What is wrong with a name typed for a new entry, or null. `reserved` is
 *  the sign-in token's name, which only the token path writes. Pure. */
export function vaultNameError(name: string, entries: ReadonlyArray<Pick<AccountVaultEntry, 'name'>>, reserved: string): 'invalid' | 'reserved' | 'taken' | null {
  if (name === reserved) return 'reserved';
  if (!isBotSecretName(name)) return 'invalid';
  return entries.some((e) => e.name === name) ? 'taken' : null;
}

/** A typed generate length: undefined for empty (the store's default), null when out of range. Pure. */
export function parseGenerateLength(text: string): number | undefined | null {
  const s = text.trim();
  if (!s) return undefined;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= GENERATE_LENGTH.min && n <= GENERATE_LENGTH.max ? n : null;
}

function blockText(t: T, block: Exclude<VaultAddBlock, null>, max: number): string {
  if (block === 'full') return t('accounts.vaultFull', { max });
  if (block === 'basic_text') return t('accounts.vaultNoKeyring');
  if (block === 'store_unreadable') return t('accounts.vaultUnreadable');
  return t('accounts.vaultNoEncryption');
}

function nameErrorText(t: T, error: Exclude<ReturnType<typeof vaultNameError>, null>, name: string): string {
  if (error === 'reserved') return t('accounts.vaultNameReserved', { name });
  if (error === 'taken') return t('accounts.vaultNameTaken', { name });
  return t('accounts.vaultNameInvalid');
}

const TABLE_TRACKS = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 150px) 96px 72px', columnGap: 12, alignItems: 'center' } as const;

/** The entries as a table: name, length · fingerprint, put into panes, remove.
 *  `managedName` is the sign-in token's name when this account signs in with
 *  it; that row says so and has no controls. */
export function AccountVaultTable({ entries, managedName, confirming, busy, onToggle, onAskRemove, onRemove, onCancelRemove }: {
  entries: ReadonlyArray<AccountVaultEntry>;
  managedName?: string;
  confirming: string | null;
  busy: boolean;
  onToggle: (name: string, inject: boolean) => void;
  onAskRemove: (name: string) => void;
  onRemove: (name: string) => void;
  onCancelRemove: () => void;
}): React.ReactElement {
  const t = useT();
  if (entries.length === 0) {
    return <div className="text-[12px] text-[var(--text-sub)]" data-account-vault-empty>{t('accounts.vaultEmpty')}</div>;
  }
  return (
    <div className="flex flex-col" role="table" aria-label={t('accounts.vaultTitle')}>
      <div role="row" className="text-[11px] text-[var(--text-sub)] pb-1" style={TABLE_TRACKS}>
        <span role="columnheader">{t('accounts.vaultColName')}</span>
        <span role="columnheader">{t('accounts.vaultColLength')}</span>
        <span role="columnheader">{t('accounts.vaultColInject')}</span>
        <span role="columnheader" className="sr-only">{t('common.remove')}</span>
      </div>
      {entries.map((e) => {
        const managed = e.name === managedName;
        return (
          <div key={e.name} role="rowgroup" className="border-t border-[var(--surface-hairline)]" data-account-vault-entry={e.name}>
            <div role="row" className="min-h-[36px] py-1" style={TABLE_TRACKS}>
              <span role="cell" className="min-w-0 flex flex-col">
                <code className="ui-code min-w-0 truncate self-start max-w-full" title={e.name}>{e.name}</code>
                {managed && <span className="text-[11px] text-[var(--text-sub)]">{t('accounts.vaultSignInRow')}</span>}
              </span>
              <span role="cell" className="min-w-0 truncate text-[11px]" style={{ color: e.usable ? 'var(--text-sub)' : 'var(--accent-red)' }}>
                {e.usable && e.fingerprint
                  ? <code className="ui-code">{`${e.length} · ${e.fingerprint}`}</code>
                  : t('accounts.vaultUnusable')}
              </span>
              <span role="cell" className="flex items-center">
                {managed ? (
                  <span className="text-[12px] text-[var(--text-sub)]" data-account-vault-always>{t('accounts.vaultAlways')}</span>
                ) : (
                  <Checkbox
                    checked={e.inject}
                    disabled={busy}
                    onCheckedChange={(v) => onToggle(e.name, v)}
                    aria-label={t('accounts.vaultInjectNamed', { name: e.name })}
                  />
                )}
              </span>
              <span role="cell" className="flex justify-end">
                {!managed && confirming !== e.name && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    aria-label={t('accounts.vaultRemoveNamed', { name: e.name })}
                    onClick={() => onAskRemove(e.name)}
                  >
                    {t('common.remove')}
                  </Button>
                )}
              </span>
            </div>
            {confirming === e.name && (
              <div role="row" className="pb-2">
                <div role="cell">
                  <InlineConfirm
                    text={t('accounts.vaultRemoveConfirm', { name: e.name })}
                    confirmLabel={t('common.remove')}
                    cancelLabel={t('common.cancel')}
                    busy={busy}
                    onConfirm={() => onRemove(e.name)}
                    onCancel={onCancelRemove}
                    testId={`account-vault-${e.name}`}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Mode = 'list' | 'save' | 'generate';

/** One account's vault under its row: the table, then Save from clipboard
 *  and Generate, each opening its form in place. */
export function AccountVaultPanel({ account, signInName, onChanged }: {
  account: AccountRow;
  /** The Claude sign-in token's entry name (managed by the token path). */
  signInName: string;
  /** The vault changed: the account list re-reads its counts. */
  onChanged: () => void;
}): React.ReactElement {
  const t = useT();
  const [entries, setEntries] = useState<AccountVaultEntry[]>([]);
  const [max, setMax] = useState<number>(Number.POSITIVE_INFINITY);
  const [cannotStore, setCannotStore] = useState<{ code: string } | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const vault = window.electronAPI?.accounts?.vault;
    if (!vault) return;
    void vault.list(account.id).then((res) => {
      setEntries(res.entries);
      if (typeof res.max === 'number') setMax(res.max);
      setCannotStore(res.cannotStore ?? null);
    }, (e: unknown) => setError(String((e as { message?: string })?.message ?? e)));
  }, [account.id]);

  // Re-read when the account list sees the vault change (the token panel
  // saving or removing the sign-in token, another window).
  useEffect(() => { load(); }, [load, account.vaultCount, account.tokenSignIn?.createdAt]);

  const changed = () => {
    load();
    onChanged();
  };

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
      changed();
    }
  };

  const vault = window.electronAPI?.accounts?.vault;
  const block = vaultAddBlock(entries.length, max, cannotStore);
  const managedName = account.tokenSignIn ? signInName : undefined;

  return (
    <div className="settings-row" data-account-vault={account.id}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[13px] text-[var(--text-main)]">{t('accounts.vaultTitle')}</span>
          <span className="text-[11px] text-[var(--text-sub)]">{t('accounts.vaultHint')}</span>
        </div>
        <AccountVaultTable
          entries={entries}
          managedName={managedName}
          confirming={confirming}
          busy={busy}
          onToggle={(name, inject) => {
            if (!vault) return;
            void run(async () => {
              const res = await vault.setInject({ accountId: account.id, name, inject });
              if (!res.ok) setError(t('accounts.vaultChangeFailed'));
            });
          }}
          onAskRemove={setConfirming}
          onCancelRemove={() => setConfirming(null)}
          onRemove={(name) => {
            if (!vault) return;
            void run(async () => {
              const res = await vault.remove({ accountId: account.id, name });
              if (!res.ok) setError(t('accounts.vaultChangeFailed'));
              setConfirming(null);
            });
          }}
        />
        {block && (
          <div className="text-[11px]" style={{ color: block === 'full' ? 'var(--text-sub)' : 'var(--accent-red)' }} data-account-vault-block={block}>
            {blockText(t, block, max)}
          </div>
        )}
        {error && <div className="text-[11px] text-[var(--accent-red)]" role="alert">{error}</div>}
        {mode === 'save' && vault && (
          <SaveFromClipboardForm
            accountId={account.id}
            entries={entries}
            reserved={signInName}
            block={block}
            onDone={() => { setMode('list'); changed(); }}
            onCancel={() => setMode('list')}
          />
        )}
        {mode === 'generate' && vault && (
          <GenerateForm
            accountId={account.id}
            entries={entries}
            reserved={signInName}
            block={block}
            onDone={() => { setMode('list'); changed(); }}
            onCancel={() => setMode('list')}
          />
        )}
        {mode === 'list' && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              disabled={!vault || block !== null}
              title={block ? blockText(t, block, max) : undefined}
              onClick={() => { setError(null); setMode('save'); }}
            >
              {t('accounts.vaultSaveFromClipboard')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={!vault || block !== null}
              title={block ? blockText(t, block, max) : undefined}
              onClick={() => { setError(null); setMode('generate'); }}
            >
              {t('accounts.vaultGenerate')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The message for a refused save or generate. */
function refusalText(t: T, res: { code: string; message: string }, prefix: string | undefined): string {
  if (res.code === 'invalid_value') return prefix ? t('accounts.vaultPrefixMismatch', { prefix }) : t('accounts.vaultValueInvalid');
  if (res.code === 'too_many') return t('accounts.vaultFullShort');
  if (res.code === 'encryption_unavailable') return t('accounts.vaultNoEncryption');
  if (res.code === 'basic_text') return t('accounts.vaultNoKeyring');
  if (res.code === 'store_unreadable') return t('accounts.vaultUnreadable');
  if (res.code === 'invalid_name') return t('accounts.vaultNameInvalid');
  return res.message;
}

function NameField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: string | null }): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <Field label={t('accounts.vaultNameLabel')} description={t('accounts.vaultNameHint')} layout="stacked">
        <Input
          className="settings-input w-full"
          value={value}
          spellCheck={false}
          autoComplete="off"
          maxLength={BOT_SECRET_LIMITS.NAME_MAX}
          placeholder="GITHUB_TOKEN"
          aria-invalid={error ? true : undefined}
          // Env var names are upper case; typing lower case is never meant.
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          autoFocus
        />
      </Field>
      {error && <div className="text-[11px] text-[var(--accent-red)]" data-account-vault-name-error>{error}</div>}
    </div>
  );
}

function SaveFromClipboardForm({ accountId, entries, reserved, block, onDone, onCancel }: {
  accountId: string;
  entries: ReadonlyArray<AccountVaultEntry>;
  reserved: string;
  block: VaultAddBlock;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const t = useT();
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [inject, setInject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = name ? vaultNameError(name, entries, reserved) : null;
  const canSave = !!name && !nameError && block === null && !busy;

  const save = async () => {
    const vault = window.electronAPI?.accounts?.vault;
    if (!vault || !canSave) return;
    const expectPrefix = prefix.trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      const res = await vault.saveFromClipboard({ accountId, name, expectPrefix });
      if (!res.ok) {
        setError(refusalText(t, res, expectPrefix));
        return;
      }
      // The save has no inject argument; a new entry is injected by default.
      if (!inject) {
        const off = await vault.setInject({ accountId, name, inject: false });
        if (!off.ok) {
          setError(t('accounts.vaultInjectOffFailed', { name }));
          return;
        }
      }
      onDone();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-1" data-account-vault-save>
      <div className="text-[13px] text-[var(--text-main)]">{t('accounts.vaultSaveTitle')}</div>
      <NameField value={name} onChange={setName} error={nameError ? nameErrorText(t, nameError, name) : null} />
      <Field label={t('accounts.vaultPrefixLabel')} description={t('accounts.vaultPrefixHint')} layout="stacked">
        <Input
          className="settings-input w-full"
          value={prefix}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('accounts.vaultPrefixPlaceholder')}
          onChange={(e) => setPrefix(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px] text-[var(--text-main)] cursor-pointer">
        <Checkbox checked={inject} onCheckedChange={setInject} aria-label={t('accounts.vaultInjectOnSave')} />
        {t('accounts.vaultInjectOnSave')}
      </label>
      <div className="flex flex-col gap-1 text-[11px] text-[var(--text-sub)]">
        <span>{t('accounts.vaultWhenSaved')}</span>
        <ul className="m-0 pl-5 flex flex-col gap-0.5 list-disc">
          <li>{t('accounts.vaultWhenClipboard')}</li>
          <li>{t('accounts.vaultWhenEncrypted')}</li>
          <li>{t('accounts.vaultWhenShown')}</li>
          <li>{t('accounts.vaultWhenMasked', { marker: `[secret:${name || 'NAME'}]` })}</li>
        </ul>
      </div>
      {error && <div className="text-[11px] text-[var(--accent-red)]" role="alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="md" disabled={!canSave} onClick={() => { void save(); }}>{t('accounts.vaultSaveAndClear')}</Button>
      </div>
    </div>
  );
}

function GenerateForm({ accountId, entries, reserved, block, onDone, onCancel }: {
  accountId: string;
  entries: ReadonlyArray<AccountVaultEntry>;
  reserved: string;
  block: VaultAddBlock;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const t = useT();
  const [name, setName] = useState('');
  const [lengthText, setLengthText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = name ? vaultNameError(name, entries, reserved) : null;
  const length = parseGenerateLength(lengthText);
  const canGenerate = !!name && !nameError && length !== null && block === null && !busy;

  const generate = async () => {
    const vault = window.electronAPI?.accounts?.vault;
    if (!vault || !canGenerate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await vault.generate({ accountId, name, ...(length !== undefined ? { length } : {}) });
      if (!res.ok) {
        setError(refusalText(t, res, undefined));
        return;
      }
      onDone();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-1" data-account-vault-generate>
      <div className="text-[13px] text-[var(--text-main)]">{t('accounts.vaultGenerateTitle')}</div>
      <div className="text-[11px] text-[var(--text-sub)]">{t('accounts.vaultGenerateHint')}</div>
      <NameField value={name} onChange={setName} error={nameError ? nameErrorText(t, nameError, name) : null} />
      <div className="flex flex-col gap-1">
        <Field
          label={t('accounts.vaultLengthLabel')}
          description={t('accounts.vaultLengthHint', { min: GENERATE_LENGTH.min, max: GENERATE_LENGTH.max, n: GENERATE_LENGTH.fallback })}
          layout="stacked"
        >
          <Input
            className="settings-input w-[120px]"
            inputMode="numeric"
            value={lengthText}
            placeholder={String(GENERATE_LENGTH.fallback)}
            aria-invalid={length === null ? true : undefined}
            onChange={(e) => setLengthText(e.target.value)}
          />
        </Field>
        {length === null && (
          <div className="text-[11px] text-[var(--accent-red)]">{t('accounts.vaultLengthInvalid', { min: GENERATE_LENGTH.min, max: GENERATE_LENGTH.max })}</div>
        )}
      </div>
      {error && <div className="text-[11px] text-[var(--accent-red)]" role="alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="md" disabled={!canGenerate} onClick={() => { void generate(); }}>{t('accounts.vaultGenerateAction')}</Button>
      </div>
    </div>
  );
}
