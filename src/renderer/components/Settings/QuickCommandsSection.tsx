import { useEffect, useState } from 'react';
import type { QuickCommandSnapshot } from '../../../shared/quickCommands';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { SettingsSection } from './SettingsLayout';

/** Reusable instructions are copied/inserted for review, never executed by saving. */
export function QuickCommandsSection(): React.ReactElement {
  const t = useT();
  const [snapshot, setSnapshot] = useState<QuickCommandSnapshot | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  async function refresh() {
    setBusy(true);
    try { setSnapshot(await window.electronAPI.quickCommands.list()); setError(''); }
    catch { setError(t('settings.quickCommandsReadError')); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save(next: QuickCommandSnapshot) {
    setBusy(true);
    try {
      setSnapshot(await window.electronAPI.quickCommands.replace(next));
      setError(''); setEditing(null); setTitle(''); setText('');
    } catch {
      setSnapshot(null);
      setError(t('settings.quickCommandsSaveConflict'));
    } finally { setBusy(false); }
  }
  const canSave = !!snapshot && !busy && !!title.trim() && !!text.trim();
  return <SettingsSection
    title={t('settings.quickCommands')}
    description={t('settings.quickCommandsDesc')}
    action={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>{t('settings.quickCommandsRefresh')}</Button>}
    data-testid="quick-commands"
  >
      {error && <p role="alert" className="settings-note" data-tone="danger">{error}</p>}
      {snapshot?.commands.map(command => <div key={command.id} className="ui-row" data-quick-command={command.id}>
        <div className="ui-row-text">
          <p className="ui-row-title truncate">{command.title}</p>
          {/* The instruction text is what gets pasted: machine evidence, mono. */}
          <p className="ui-row-detail truncate font-mono">{command.text}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(command.text).then(() => setCopied(command.id)).catch(() => setError(t('settings.quickCommandsCopyError'))); }}>{copied === command.id ? t('settings.quickCommandsCopied') : t('settings.quickCommandsCopy')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(command.id); setTitle(command.title); setText(command.text); }}>{t('settings.quickCommandsEdit')}</Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void save({ ...snapshot, commands: snapshot.commands.filter(row => row.id !== command.id) })}>{t('settings.quickCommandsDelete')}</Button>
        </div>
      </div>)}
      <form className="settings-block" onSubmit={event => {
        event.preventDefault();
        if (!snapshot || busy || !title.trim() || !text.trim()) return;
        const command = { id: editing ?? crypto.randomUUID(), title: title.trim(), text };
        const found = snapshot.commands.some(row => row.id === command.id);
        void save({ ...snapshot, commands: found ? snapshot.commands.map(row => row.id === command.id ? command : row) : [...snapshot.commands, command] });
      }}>
        <Input aria-label={t('settings.quickCommandsTitleLabel')} placeholder={t('settings.quickCommandsTitlePlaceholder')} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} className="settings-input" />
        <textarea aria-label={t('settings.quickCommandsTextLabel')} placeholder={t('settings.quickCommandsTextPlaceholder')} value={text} maxLength={16000} rows={4} onChange={event => setText(event.target.value)} className="ui-input resize-y font-mono" style={{ fontSize: 11, padding: '8px 10px' }} />
        <div className="flex justify-end gap-2">
          {editing && <Button variant="ghost" size="md" onClick={() => { setEditing(null); setTitle(''); setText(''); }}>{t('settings.quickCommandsCancelEdit')}</Button>}
          {/* Primary only while it can act: a disabled action is never the primary. */}
          <Button type="submit" variant={canSave ? 'primary' : 'secondary'} size="md" disabled={!canSave}>{editing ? t('settings.quickCommandsSave') : t('settings.quickCommandsAdd')}</Button>
        </div>
      </form>
  </SettingsSection>;
}
