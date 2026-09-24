import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChatModelSettings } from './ChatModelSettings';
import { ComposerPrimitive } from '@assistant-ui/react';
import { useT } from '../../hooks/useT';
import type { ChatSkill, ChatSkillCatalog } from '../../../shared/transcript/chatSkills';

export interface SkillComposer { getState(): { text: string }; subscribe(callback: () => void): () => void; setText(text: string): void }
export interface ChatSkillScope { ptyId: string; agent: string; composer: SkillComposer; onTerminal?: () => void; live?: boolean }
export function skillQuery(text: string, caret: number): { query: string; end: number } | null {
  const match = text.match(/^[/$]([^\s]*)/);
  return match && caret > 0 && caret <= match[0].length ? { query: match[1], end: match[0].length } : null;
}

export function ChatComposerInput({ disabled, placeholder, maxLength, scope, composer, onDiscoveryOpenChange }: {
  disabled: boolean; placeholder: string; maxLength: number; composer: SkillComposer; scope?: ChatSkillScope; onDiscoveryOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  // Keep React's controlled value synchronous with the DOM input event.
  // The runtime's store propagation can lag a render and cancel native IME.
  const [text, setText] = useState(() => composer.getState().text);
  const composing = useRef(false);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [catalog, setCatalog] = useState<ChatSkillCatalog | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(0);
  const enabled = !!scope && ['claude', 'codex'].includes(scope.agent);
  const query = skillQuery(text, caret);
  const open = enabled && !disabled && !dismissed && !!query;
  useEffect(() => { onDiscoveryOpenChange?.(open); return () => onDiscoveryOpenChange?.(false); }, [open, onDiscoveryOpenChange]);
  useEffect(() => {
    setCatalog(null); setDismissed(false); setSelected(0);
  }, [scope?.ptyId, scope?.agent]);
  useEffect(() => {
    setText(composer.getState().text);
    return composer.subscribe(() => {
      if (!composing.current) setText(composer.getState().text);
    });
  }, [composer]);
  useEffect(() => {
    const readSkills = window.electronAPI?.chat?.skills;
    if (!open || !scope) return;
    if (!readSkills) { setCatalog({skills:[],state:'unavailable',reason:'bridge-outdated'}); return; }
    let cancelled = false;
    setLoading(true);
    void readSkills({ ptyId: scope.ptyId, agent: scope.agent }).then(result => {
      if (!cancelled) setCatalog(result);
    }, error => { if (!cancelled) setCatalog({ skills: [], state: 'unavailable', ...(String(error).includes('No handler registered') ? {reason:'bridge-outdated' as const} : {}) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, scope?.ptyId, scope?.agent, reload]);
  type Entry = ChatSkill & { action?: 'model' | 'terminal' };
  // Terminal-only commands are navigation actions, never text injected into a PTY.
  const commands: Entry[] = scope?.onTerminal && text.startsWith('/') ?
    (scope.agent === 'codex' ? ['model','fast','ide','permissions','keymap','vim','experimental','approve'] : ['model','permissions','context','compact','help'])
      .map(name => ({name,invocation:`/${name}`,description:t(`chat.command.${name}`),source:'terminal',
        action: name === 'model' && scope.agent === 'codex' && scope.live && window.electronAPI?.chat?.settings ? 'model' : 'terminal'})) : [];
  const entries: Entry[] = [...commands, ...(!loading ? catalog?.skills ?? [] : [])];
  const filtered = entries.filter(skill =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes((query?.query ?? '').toLocaleLowerCase()));
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  useEffect(() => { setSelected(0); }, [query?.query, catalog]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  function choose(skill: Entry) {
    if (!scope || !query) return;
    if (skill.action) { scope.composer.setText(text.slice(query.end).replace(/^ /, '')); setDismissed(true); if (skill.action === 'model') setModelOpen(true); else scope.onTerminal?.(); return; }
    const tail = text.slice(query.end);
    const prefix = skill.invocation + (tail.startsWith(' ') ? '' : ' ');
    const inserted = prefix + tail;
    scope.composer.setText(inserted);
    setDismissed(true);
    requestAnimationFrame(() => { if (!input.current || scope.composer.getState().text !== inserted) return; input.current?.focus(); input.current?.setSelectionRange(prefix.length, prefix.length); setCaret(prefix.length); });
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      // Some IMEs report the confirming Enter as 229 without isComposing.
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
      return;
    }
    if (!open) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') setDismissed(true);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length));
      else if (filtered[index]) choose(filtered[index]);
    }
  }
  return <div className="wmux-chat-input-wrap">
    {modelOpen && scope && <ChatModelSettings ptyId={scope.ptyId} onClose={() => {setModelOpen(false); input.current?.focus();}} onTerminal={() => scope.onTerminal?.()} />}
    {open && <div className="wmux-chat-skills" aria-label={t('chat.commandsAndSkills')}>
      <div className="wmux-chat-skills-heading"><strong>{t(text.startsWith('$') ? 'chat.skills' : 'chat.commandsAndSkills')}</strong><span>{scope?.agent === 'codex' ? t('chat.skillsCodexHint') : t('chat.skillsHint')}</span></div>
      {loading ? <p role="status">{t('chat.loading')}</p> : catalog?.state === 'unavailable' ? <p role="status">{t(catalog.reason === 'bridge-outdated' ? 'chat.bridgeOutdated' : 'chat.skillsUnavailable')} <button type="button" onClick={() => setReload(value => value + 1)}>{t('chat.retry')}</button></p> : <>
        {catalog?.state === 'partial' && <p role="status">{t('chat.skillsPartial')}</p>}
        {!filtered.length && <p role="status">{t(catalog?.skills.length ? 'chat.skillsNoMatch' : 'chat.skillsEmpty')}</p>}
      </>}
      <div ref={list} id={id} role="listbox" aria-label={t('chat.commandsAndSkills')} className="wmux-chat-skills-list">
        {filtered.map((skill, i) => <button key={`${skill.action ?? 'skill'}:${skill.invocation}`} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(i)} onClick={() => choose(skill)}>
          <span><strong>{skill.invocation}</strong><small>{t(skill.action === 'model' ? 'chat.inChat' : skill.action === 'terminal' ? 'chat.inTerminal' : `chat.skillSource.${skill.source}`)}</small></span>
          {skill.description && <span className="wmux-chat-skill-description" title={skill.description}>{skill.description}</span>}
        </button>)}
      </div>
      <div className="wmux-chat-skills-keys">{t('chat.skillsKeys')}</div>
    </div>}
    <ComposerPrimitive.Input ref={input} className="wmux-chat-input" aria-label={t('chat.message')} placeholder={placeholder}
      role={enabled ? 'combobox' : undefined} aria-autocomplete={enabled ? 'list' : undefined} aria-expanded={enabled ? open : undefined}
      aria-controls={open ? id : undefined} aria-activedescendant={open && filtered[index] ? `${id}-${index}` : undefined}
      disabled={disabled} maxLength={maxLength} rows={1} maxRows={8} submitMode="enter" enterKeyHint="send" addAttachmentOnPaste={false}
      value={text} cancelOnEscape={!open} onKeyDown={keyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; setText(event.currentTarget.value); }}
      onChange={event => { setText(event.target.value); setCaret(event.target.selectionStart); setDismissed(false); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onBlur={event => { if (!event.relatedTarget || !event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setDismissed(true); }}
      unstable_focusOnThreadSwitched={false} unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false} />
    {enabled && <button type="button" className="wmux-chat-skills-trigger" disabled={disabled} title={t('chat.commandsAndSkills')} aria-label={t('chat.commandsAndSkills')}
      onClick={() => {
        if (!scope) return;
        let next = scope.composer.getState().text;
        if (!/^[/$]/.test(next)) { next = '/' + (next ? ' ' + next : ''); scope.composer.setText(next); }
        setCaret(1); setDismissed(false); input.current?.focus(); input.current?.setSelectionRange(1, 1);
      }}>/</button>}
  </div>;
}
