// ─── The connection dialog — add or edit one library connection ────────────
//
// Opened from Settings › Bots › Connections and from a bot's profile. A
// verified preset (or Custom) fills it; main checks everything again on
// save (shared/botConnector.ts). A key's value is typed here, sent once with
// the save and cleared; a stored key shows "Stored" and Replace, never its
// value.
import { useMemo, useRef, useState } from 'react';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field, { FieldOwnIds } from '../ui/Field';
import Input from '../ui/Input';
import Checkbox from '../ui/Checkbox';
import SegmentedControl from '../ui/SegmentedControl';
import { FOCUS_RING } from '../focusRing';
import BotAvatar from '../Room/BotAvatar';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { getBotConnectorPort, type BotConnectorPort } from '../Room/botConnectors';
import { BOT_SECRET_LIMITS } from '../../../shared/botSecret';
import { CONNECTOR_LIMITS, type ConnectorDraft, type ConnectorSecret, type ConnectorView } from '../../../shared/botConnector';
import { CONNECTOR_PRESETS, customConnectorDraft } from '../../../shared/botConnectorPresets';

type T = (key: string, vars?: Record<string, string | number>) => string;

interface KeyRow {
  secret: string;
  header: string;
  scheme: 'bearer' | 'raw';
  /** A value typed now (sent once with the save). */
  value: string;
  /** Show the value field for a stored key (Replace). */
  replacing: boolean;
}

interface Form {
  presetId: string;
  name: string;
  purpose: string;
  kind: 'stdio' | 'remote';
  remoteTransport: 'http' | 'sse';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  keys: KeyRow[];
  toolMode: 'listed' | 'all';
  tools: string;
  scope: 'all' | 'bots';
  botIds: string[];
  enabled: boolean;
}

function formOf(d: ConnectorDraft, presetId: string): Form {
  return {
    presetId,
    name: d.name,
    purpose: d.purpose ?? '',
    kind: d.transport === 'stdio' ? 'stdio' : 'remote',
    remoteTransport: d.transport === 'sse' ? 'sse' : 'http',
    command: d.stdio?.command ?? '',
    args: (d.stdio?.args ?? []).join('\n'),
    env: Object.entries(d.stdio?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    url: d.remote?.url ?? '',
    headers: Object.entries(d.remote?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    keys: d.secrets.map((s) => ({ secret: s.secret, header: s.as === 'header' ? s.header : 'Authorization', scheme: s.as === 'header' ? s.scheme : 'bearer', value: '', replacing: false })),
    toolMode: d.tools.mode,
    tools: (d.tools.mode === 'all' ? d.tools.blocked : d.tools.allowed).join('\n'),
    scope: d.scope.kind,
    botIds: d.scope.kind === 'bots' ? [...d.scope.botIds] : [],
    enabled: d.enabled,
  };
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** The form as a draft for main (main validates it again). Pure. */
export function draftOf(f: Form, id?: string): ConnectorDraft {
  const secrets: ConnectorSecret[] = f.keys.filter((k) => k.secret.trim()).map((k) => (f.kind === 'stdio'
    ? { secret: k.secret.trim(), as: 'env' as const }
    : { secret: k.secret.trim(), as: 'header' as const, header: k.header.trim(), scheme: k.scheme }));
  const pairs = (text: string, sep: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const l of lines(text)) {
      const at = l.indexOf(sep);
      if (at <= 0) out[l] = '';
      else out[l.slice(0, at).trim()] = l.slice(at + 1).trim();
    }
    return out;
  };
  const toolNames = [...new Set(f.tools.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
  return {
    ...(id ? { id } : {}),
    name: f.name.trim(),
    ...(f.purpose.trim() ? { purpose: f.purpose.trim() } : {}),
    ...(f.presetId === 'github' || f.presetId === 'filesystem' ? { preset: f.presetId } : {}),
    transport: f.kind === 'stdio' ? 'stdio' : f.remoteTransport,
    ...(f.kind === 'stdio'
      ? { stdio: { command: f.command.trim(), args: lines(f.args), env: pairs(f.env, '=') } }
      : { remote: { url: f.url.trim(), headers: pairs(f.headers, ':') } }),
    secrets,
    tools: f.toolMode === 'all' ? { mode: 'all', blocked: toolNames } : { mode: 'listed', allowed: toolNames },
    scope: f.scope === 'all' ? { kind: 'all' } : { kind: 'bots', botIds: [...f.botIds] },
    enabled: f.enabled,
  };
}

export function ConnectionDialog({ t, bots, editing, presetBotId, onClose, port = getBotConnectorPort() }: {
  t: T;
  bots: readonly FactoryBotRow[];
  /** The connection to edit; absent to add one. */
  editing?: ConnectorView;
  /** Add from a bot's profile: the scope starts as that bot. */
  presetBotId?: string;
  onClose: () => void;
  port?: BotConnectorPort;
}): React.ReactElement {
  const start = (): Form => {
    if (editing) return formOf(editing, editing.preset ?? 'custom');
    const f = formOf(customConnectorDraft(), 'custom');
    return presetBotId ? { ...f, scope: 'bots', botIds: [presetBotId] } : f;
  };
  const [form, setForm] = useState<Form>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((cur) => ({ ...cur, [k]: v }));
  const stored = useMemo(() => new Set(editing ? editing.secrets.map((s) => s.secret).filter((n) => !editing.missingKeys.includes(n)) : []), [editing]);
  const usedBy = editing ? (editing.scope.kind === 'all' ? bots.filter((b) => !editing.offFor.includes(b.bot.id)).length : editing.scope.botIds.length) : 0;

  const pickPreset = (id: string) => {
    if (id === 'custom') {
      const f = formOf(customConnectorDraft(), 'custom');
      setForm({ ...f, scope: form.scope, botIds: form.botIds });
      return;
    }
    const p = CONNECTOR_PRESETS.find((x) => x.id === id);
    if (p) setForm({ ...formOf(p.draft, id), scope: form.scope, botIds: form.botIds });
  };

  const clearValues = () => setForm((cur) => ({ ...cur, keys: cur.keys.map((k) => ({ ...k, value: '' })) }));
  const close = () => { clearValues(); onClose(); };

  const save = async () => {
    if (busy) return;
    const keyValues: Record<string, string> = {};
    for (const k of form.keys) if (k.secret.trim() && k.value) keyValues[k.secret.trim()] = k.value;
    const draft = draftOf(form, editing?.id);
    // Values leave the renderer here and are not kept.
    clearValues();
    setBusy(true);
    setError(null);
    try {
      const r = await port.save({ connector: draft, ...(Object.keys(keyValues).length > 0 ? { keyValues } : {}) });
      if (r.ok) onClose();
      else setError(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const shortValue = form.keys.some((k) => k.value.length > 0 && k.value.length < BOT_SECRET_LIMITS.VALUE_MIN);
  const canSave = !busy && form.name.trim().length > 0 && !shortValue && (form.scope === 'all' || form.botIds.length > 0);
  const preset = CONNECTOR_PRESETS.find((p) => p.id === form.presetId);
  const area = `w-full rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 font-mono text-[12px] text-[var(--text-main)] outline-none ${FOCUS_RING}`;

  return (
    <Dialog onClose={close} width={460} initialFocusRef={nameRef} data-testid="connection-dialog">
      <DialogHeader
        title={t(editing ? 'settings.factory.connections.editTitle' : 'settings.factory.connections.addTitle')}
        description={t('settings.factory.connections.dialogDesc')}
        closeLabel={t('botSecret.close')}
      />
      <DialogBody>
        <div className="flex flex-col gap-3">
          {editing && usedBy > 0 && <p data-testid="connection-used-by" className="text-[12px] text-[var(--text-sub)]">{t('settings.factory.connections.usedBy', { count: usedBy })}</p>}
          {!editing && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('settings.factory.connections.presets')}>
              {[...CONNECTOR_PRESETS.map((p) => ({ id: p.id as string, label: t(p.labelKey) })), { id: 'custom', label: t('settings.factory.connections.preset.custom') }].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-connection-preset={p.id}
                  aria-pressed={form.presetId === p.id}
                  onClick={() => pickPreset(p.id)}
                  className={`h-[26px] px-2.5 rounded-[var(--chip-radius)] text-[12px] ${form.presetId === p.id ? 'bg-[var(--selection-emphasis)] text-[var(--text-main)]' : 'bg-[var(--selection)] text-[var(--text-sub)] hover:bg-[var(--selection-hover)]'} ${FOCUS_RING}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {preset && <p className="text-[11px] text-[var(--text-sub)]">{t(preset.hintKey)}</p>}
          <Field label={t('settings.factory.connections.name')} description={t('settings.factory.connections.nameHint')} layout="stacked">
            <Input ref={nameRef} data-testid="connection-name" value={form.name} maxLength={32} spellCheck={false} onChange={(e) => set('name', e.target.value.toLowerCase())} className="w-full text-[13px]" />
          </Field>
          <Field label={t('settings.factory.connections.purpose')} description={t('settings.factory.connections.purposeHint')} layout="stacked">
            <Input data-testid="connection-purpose" value={form.purpose} maxLength={CONNECTOR_LIMITS.PURPOSE} onChange={(e) => set('purpose', e.target.value)} className="w-full text-[13px]" />
          </Field>
          <SegmentedControl
            ariaLabel={t('settings.factory.connections.kind')}
            value={form.kind}
            options={[{ value: 'stdio', label: t('settings.factory.connections.local') }, { value: 'remote', label: t('settings.factory.connections.remote') }]}
            onValueChange={(v) => setForm((cur) => ({ ...cur, kind: v, keys: cur.keys }))}
            data-testid="connection-kind"
          />
          {form.kind === 'stdio' ? (
            <>
              <Field label={t('settings.factory.connections.command')} description={t('settings.factory.connections.commandHint')} layout="stacked">
                <Input data-testid="connection-command" value={form.command} spellCheck={false} onChange={(e) => set('command', e.target.value)} className="w-full font-mono text-[12px]" />
              </Field>
              <Field label={t('settings.factory.connections.args')} description={t('settings.factory.connections.argsHint')} layout="stacked">
                <textarea data-testid="connection-args" rows={3} value={form.args} spellCheck={false} onChange={(e) => set('args', e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={area} />
              </Field>
              <Field label={t('settings.factory.connections.env')} description={t('settings.factory.connections.envHint')} layout="stacked">
                <textarea data-testid="connection-env" rows={2} value={form.env} spellCheck={false} onChange={(e) => set('env', e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={area} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('settings.factory.connections.url')} layout="stacked">
                <Input data-testid="connection-url" value={form.url} spellCheck={false} onChange={(e) => set('url', e.target.value)} className="w-full font-mono text-[12px]" />
              </Field>
              <SegmentedControl
                ariaLabel={t('settings.factory.connections.protocol')}
                value={form.remoteTransport}
                options={[{ value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]}
                onValueChange={(v) => set('remoteTransport', v)}
              />
              {form.remoteTransport === 'sse' && <p className="text-[11px] text-[var(--text-sub)]">{t('settings.factory.connections.sseClaudeOnly')}</p>}
              <Field label={t('settings.factory.connections.headers')} description={t('settings.factory.connections.headersHint')} layout="stacked">
                <textarea data-testid="connection-headers" rows={2} value={form.headers} spellCheck={false} onChange={(e) => set('headers', e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={area} />
              </Field>
            </>
          )}
          <div className="flex flex-col gap-1.5" data-testid="connection-keys">
            <span className="ui-field-label">{t('settings.factory.connections.keys')}</span>
            <span className="ui-field-description">{t(form.kind === 'stdio' ? 'settings.factory.connections.keysHintEnv' : 'settings.factory.connections.keysHintHeader')}</span>
            {form.keys.map((k, i) => {
              const isStored = stored.has(k.secret) && !k.replacing;
              const patch = (p: Partial<KeyRow>) => setForm((cur) => ({ ...cur, keys: cur.keys.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
              return (
                <div key={i} className="flex flex-wrap items-center gap-1.5" data-connection-key={i}>
                  <Input aria-label={t('settings.factory.connections.keyName')} placeholder="GITHUB_MCP_TOKEN" value={k.secret} spellCheck={false} onChange={(e) => patch({ secret: e.target.value.toUpperCase(), replacing: true })} className="w-[160px] font-mono text-[12px]" />
                  {form.kind === 'remote' && (
                    <>
                      <Input aria-label={t('settings.factory.connections.keyHeader')} value={k.header} spellCheck={false} onChange={(e) => patch({ header: e.target.value })} className="w-[110px] font-mono text-[12px]" />
                      <SegmentedControl
                        ariaLabel={t('settings.factory.connections.keyScheme')}
                        value={k.scheme}
                        options={[{ value: 'bearer', label: 'Bearer' }, { value: 'raw', label: t('settings.factory.connections.keyRaw') }]}
                        onValueChange={(v) => patch({ scheme: v })}
                      />
                    </>
                  )}
                  {isStored ? (
                    <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-sub)]">
                      {t('settings.factory.connections.keyStored')}
                      <Button size="sm" variant="ghost" onClick={() => patch({ replacing: true })}>{t('settings.factory.connections.keyReplace')}</Button>
                    </span>
                  ) : (
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={t('settings.factory.connections.keyValue')}
                      placeholder={t('settings.factory.connections.keyValue')}
                      data-testid={`connection-key-value-${i}`}
                      maxLength={BOT_SECRET_LIMITS.VALUE_MAX}
                      value={k.value}
                      onChange={(e) => patch({ value: e.target.value })}
                      className="min-w-[120px] flex-1 text-[12px]"
                    />
                  )}
                  <Button size="sm" variant="ghost" aria-label={t('settings.factory.connections.keyRemove')} onClick={() => setForm((cur) => ({ ...cur, keys: cur.keys.filter((_, j) => j !== i) }))}>×</Button>
                </div>
              );
            })}
            {form.keys.length < CONNECTOR_LIMITS.SECRETS && (
              <div>
                <Button size="sm" variant="secondary" data-testid="connection-add-key" onClick={() => setForm((cur) => ({ ...cur, keys: [...cur.keys, { secret: '', header: 'Authorization', scheme: 'bearer', value: '', replacing: true }] }))}>
                  {t('settings.factory.connections.addKey')}
                </Button>
              </div>
            )}
            {shortValue && <p className="text-[11px] text-[var(--text-sub)]">{t('botSecret.valueHint', { min: BOT_SECRET_LIMITS.VALUE_MIN })}</p>}
          </div>
          <Field label={t('settings.factory.connections.tools')} description={t(form.toolMode === 'listed' ? 'settings.factory.connections.toolsListedHint' : 'settings.factory.connections.toolsBlockedHint')} layout="stacked">
            <div className="flex flex-col gap-1.5">
              <SegmentedControl
                ariaLabel={t('settings.factory.connections.tools')}
                value={form.toolMode}
                options={[{ value: 'listed', label: t('settings.factory.connections.toolsListed') }, { value: 'all', label: t('settings.factory.connections.toolsAllBut') }]}
                onValueChange={(v) => set('toolMode', v)}
                data-testid="connection-tool-mode"
              />
              <textarea data-testid="connection-tools" aria-label={t('settings.factory.connections.tools')} rows={3} value={form.tools} spellCheck={false} onChange={(e) => set('tools', e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={area} />
            </div>
          </Field>
          <Field label={t('settings.factory.connections.scope')} layout="stacked">
            <div className="flex flex-col gap-1.5">
              <SegmentedControl
                ariaLabel={t('settings.factory.connections.scope')}
                value={form.scope}
                options={[{ value: 'all', label: t('settings.factory.connections.scopeAll') }, { value: 'bots', label: t('settings.factory.connections.scopeBots') }]}
                onValueChange={(v) => set('scope', v)}
                data-testid="connection-scope"
              />
              {form.scope === 'all' && <p className="text-[11px] text-[var(--text-sub)]">{t('settings.factory.connections.scopeAllHint', { count: bots.length })}</p>}
              {form.scope === 'bots' && (
                <FieldOwnIds>
                  <div className="flex flex-col gap-1" data-testid="connection-scope-bots">
                    {bots.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">{t('settings.factory.noBots')}</p>}
                    {bots.map((b) => {
                      const on = form.botIds.includes(b.bot.id);
                      return (
                        <label key={b.bot.id} className="flex items-center gap-2 text-[13px] text-[var(--text-main)] cursor-pointer" data-connection-scope-bot={b.bot.id}>
                          <Checkbox id={`connection-scope-${b.bot.id}`} checked={on} aria-label={b.bot.name} onCheckedChange={(v) => set('botIds', v ? [...form.botIds, b.bot.id] : form.botIds.filter((x) => x !== b.bot.id))} />
                          <BotAvatar bot={b.bot} size={16} t={t} />
                          <span className="truncate">{b.bot.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </FieldOwnIds>
              )}
            </div>
          </Field>
          <p className="text-[11px] text-[var(--text-sub)]">{t('settings.factory.connections.actsWithKey')}</p>
          {error && <p role="alert" data-testid="connection-error" className="text-[12px] text-[var(--accent-red)]">{error}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" disabled={busy} onClick={close}>{t('settings.factory.cancel')}</Button>
        <Button variant="primary" size="md" disabled={!canSave} data-testid="connection-save" onClick={() => void save()}>{t('settings.factory.save')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
