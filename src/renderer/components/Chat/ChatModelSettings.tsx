import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import type { ChatBridgeApi } from '../../../shared/transcript/turnEvents';
type SettingsResult = Awaited<ReturnType<NonNullable<ChatBridgeApi['settings']>>>;
type Settings = NonNullable<SettingsResult['settings']>;
export function ChatModelSettings({ ptyId, onClose, onTerminal }: { ptyId: string; onClose(): void; onTerminal(): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false; setBusy(true); setError('');
    const request = window.electronAPI?.chat?.settings;
    const pending: Promise<SettingsResult> = request ? request({ ptyId }) : Promise.resolve({ok:false});
    void pending.then(result => {
      if (cancelled) return;
      if (result.ok && result.settings) {
        const current = result.settings; setSettings(current); setModel(current.model);
        setEffort(current.effort ?? current.models.find(item => item.model === current.model)?.defaultEffort ?? '');
      } else setError('unavailable');
    }, () => { if (!cancelled) setError('unavailable'); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [ptyId, revision]);
  const choices = settings?.models.find(item => item.model === model);
  async function apply() {
    if (!settings || busy || !choices?.efforts.includes(effort)) return;
    setBusy(true); setSaving(true); setError('');
    try {
      const result = await window.electronAPI.chat.settings?.({ptyId,choice:{model,effort,expectedRevision:settings.revision}});
      if (!alive.current) return;
      if (result?.ok) onClose(); else setError(result?.error ?? 'unconfirmed');
    } catch { if (alive.current) setError('unconfirmed'); }
    finally { if (alive.current) {setBusy(false); setSaving(false);} }
  }
  return <dialog ref={dialog} className="wmux-chat-model-dialog" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} aria-labelledby="chat-model-title">
    <h2 id="chat-model-title">{t('chat.modelTitle')}</h2>
    {busy && <p role="status">{t('chat.loading')}</p>}
    {error && <p role="alert">{t(`chat.modelError.${error}`)}</p>}
    {settings && <>
      <label>{t('chat.modelLabel')}<select value={model} disabled={busy} onChange={event => { const next=settings.models.find(item=>item.model===event.target.value); if(next){setModel(next.model);setEffort(next.defaultEffort);} }}>
        {!settings.models.some(item=>item.model===model) && <option value={model}>{model}</option>}
        {settings.models.map(item=><option key={item.model} value={item.model}>{item.model}</option>)}
      </select></label>
      <label>{t('chat.effortLabel')}<select value={effort} disabled={busy} onChange={event=>setEffort(event.target.value)}>{choices?.efforts.map(item=><option key={item} value={item}>{item}</option>)}</select></label>
      {settings.busy && <p>{t('chat.modelError.busy')}</p>}
    </>}
    <div className="wmux-chat-model-actions">
      <button type="button" onClick={onClose} disabled={saving}>{t('chat.closeMenu')}</button>
      {error && <><button type="button" onClick={()=>setRevision(value=>value+1)} disabled={busy}>{t('chat.retry')}</button><button type="button" onClick={()=>{onClose();onTerminal();}} disabled={busy}>{t('chat.openTerminal')}</button></>}
      <button type="button" onClick={()=>void apply()} disabled={busy || !!error || !settings || settings.busy || !choices?.efforts.includes(effort)}>{t('chat.applyModel')}</button>
    </div>
  </dialog>;
}
