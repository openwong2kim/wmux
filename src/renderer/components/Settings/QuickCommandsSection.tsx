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
    catch { setError('Could not read quick commands.'); }
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
      setError('The list may have changed elsewhere. Refresh and review before saving again. Your editor text is retained.');
    } finally { setBusy(false); }
  }
  const canSave = !!snapshot && !busy && !!title.trim() && !!text.trim();
  return <SettingsSection
    title={t('settings.quickCommands')}
    description="Shared with paired phones on this Mac. Copy or insert instructions, then review before sending."
    action={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button>}
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
          <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(command.text).then(() => setCopied(command.id)).catch(() => setError('Could not copy the command.')); }}>{copied === command.id ? 'Copied' : 'Copy'}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(command.id); setTitle(command.title); setText(command.text); }}>Edit</Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void save({ ...snapshot, commands: snapshot.commands.filter(row => row.id !== command.id) })}>Delete</Button>
        </div>
      </div>)}
      <form className="settings-block" onSubmit={event => {
        event.preventDefault();
        if (!snapshot || busy || !title.trim() || !text.trim()) return;
        const command = { id: editing ?? crypto.randomUUID(), title: title.trim(), text };
        const found = snapshot.commands.some(row => row.id === command.id);
        void save({ ...snapshot, commands: found ? snapshot.commands.map(row => row.id === command.id ? command : row) : [...snapshot.commands, command] });
      }}>
        <Input aria-label="Quick command title" placeholder="Title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} className="settings-input" />
        <textarea aria-label="Quick command instructions" placeholder="Reusable instructions" value={text} maxLength={16000} rows={4} onChange={event => setText(event.target.value)} className="ui-input resize-y font-mono" style={{ fontSize: 12, padding: '8px 10px' }} />
        <div className="flex justify-end gap-2">
          {editing && <Button variant="ghost" size="md" onClick={() => { setEditing(null); setTitle(''); setText(''); }}>Cancel edit</Button>}
          {/* Primary only while it can act: a disabled action is never the primary. */}
          <Button type="submit" variant={canSave ? 'primary' : 'secondary'} size="md" disabled={!canSave}>{editing ? 'Save changes' : 'Add command'}</Button>
        </div>
      </form>
  </SettingsSection>;
}
