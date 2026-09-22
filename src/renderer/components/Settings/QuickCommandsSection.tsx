import { useEffect, useState } from 'react';
import type { QuickCommandSnapshot } from '../../../shared/quickCommands';

/** Reusable instructions are copied/inserted for review, never executed by saving. */
export function QuickCommandsSection(): React.ReactElement {
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
  return <section className="mt-5 border-t border-[var(--border-subtle)] pt-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm text-[var(--text-main)]">Quick commands</h3>
      <button type="button" disabled={busy} onClick={() => void refresh()} className="text-xs text-[var(--text-subtle)]">Refresh</button>
    </div>
    <p className="mt-1 text-xs text-[var(--text-muted)]">Shared with paired phones on this Mac. Copy or insert instructions, then review before sending.</p>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--text-main)]">{error}</p>}
    <div className="mt-3 divide-y divide-[var(--border-subtle)]">
      {snapshot?.commands.map(command => <div key={command.id} className="py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--text-main)]">{command.title}</span>
          <div className="flex gap-3 text-xs text-[var(--text-subtle)]">
            <button type="button" onClick={() => { void navigator.clipboard.writeText(command.text).then(() => setCopied(command.id)).catch(() => setError('Could not copy the command.')); }}>{copied === command.id ? 'Copied' : 'Copy'}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(command.id); setTitle(command.title); setText(command.text); }}>Edit</button>
            <button type="button" disabled={busy} onClick={() => void save({ ...snapshot, commands: snapshot.commands.filter(row => row.id !== command.id) })}>Delete</button>
          </div>
        </div>
        <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{command.text}</p>
      </div>)}
    </div>
    <form className="mt-3 flex flex-col gap-2" onSubmit={event => {
      event.preventDefault();
      if (!snapshot || busy || !title.trim() || !text.trim()) return;
      const command = { id: editing ?? crypto.randomUUID(), title: title.trim(), text };
      const found = snapshot.commands.some(row => row.id === command.id);
      void save({ ...snapshot, commands: found ? snapshot.commands.map(row => row.id === command.id ? command : row) : [...snapshot.commands, command] });
    }}>
      <input aria-label="Quick command title" placeholder="Title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} className="rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-xs text-[var(--text-main)]" />
      <textarea aria-label="Quick command instructions" placeholder="Reusable instructions" value={text} maxLength={16000} rows={4} onChange={event => setText(event.target.value)} className="resize-y rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-2 text-xs text-[var(--text-main)]" />
      <div className="flex gap-3 text-xs">
        <button type="submit" disabled={busy || !snapshot || !title.trim() || !text.trim()} className="text-[var(--accent-amber)] disabled:opacity-40">{editing ? 'Save changes' : 'Add command'}</button>
        {editing && <button type="button" onClick={() => { setEditing(null); setTitle(''); setText(''); }}>Cancel edit</button>}
      </div>
    </form>
  </section>;
}
