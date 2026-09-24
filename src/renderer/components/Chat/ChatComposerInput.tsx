import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ComposerPrimitive } from '@assistant-ui/react';
import { useT } from '../../hooks/useT';
import type { ChatSkill, ChatSkillCatalog } from '../../../shared/transcript/chatSkills';

export interface SkillComposer { getState(): { text: string }; subscribe(callback: () => void): () => void; setText(text: string): void }
export interface ChatSkillScope { ptyId: string; agent: string; composer: SkillComposer }
export function skillQuery(text: string, caret: number): { query: string; end: number } | null {
  const match = text.match(/^[/$]([^\s]*)/);
  return match && caret > 0 && caret <= match[0].length ? { query: match[1], end: match[0].length } : null;
}

export function ChatComposerInput({ disabled, placeholder, maxLength, scope }: {
  disabled: boolean; placeholder: string; maxLength: number; scope?: ChatSkillScope;
}) {
  const t = useT();
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [catalog, setCatalog] = useState<ChatSkillCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(0);
  const enabled = !!scope && ['claude', 'codex'].includes(scope.agent) && !!window.electronAPI?.chat?.skills;
  const query = skillQuery(text, caret);
  const open = enabled && !disabled && !dismissed && !!query;
  useEffect(() => {
    setCatalog(null); setDismissed(false); setSelected(0);
    if (!scope) return;
    setText(scope.composer.getState().text);
    return scope.composer.subscribe(() => setText(scope.composer.getState().text));
  }, [scope?.composer, scope?.ptyId, scope?.agent]);
  useEffect(() => {
    const readSkills = window.electronAPI?.chat?.skills;
    if (!open || !scope || !readSkills) return;
    let cancelled = false;
    setLoading(true);
    void readSkills({ ptyId: scope.ptyId, agent: scope.agent }).then(result => {
      if (!cancelled) setCatalog(result);
    }, () => { if (!cancelled) setCatalog({ skills: [], state: 'unavailable' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, scope?.ptyId, scope?.agent, reload]);
  const filtered = (catalog?.skills ?? []).filter(skill =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes((query?.query ?? '').toLocaleLowerCase()));
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  useEffect(() => { setSelected(0); }, [query?.query, catalog]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  function choose(skill: ChatSkill) {
    if (!scope || !query) return;
    const tail = text.slice(query.end);
    const prefix = skill.invocation + (tail.startsWith(' ') ? '' : ' ');
    const inserted = prefix + tail;
    scope.composer.setText(inserted);
    setDismissed(true);
    requestAnimationFrame(() => { if (!input.current || scope.composer.getState().text !== inserted) return; input.current?.focus(); input.current?.setSelectionRange(prefix.length, prefix.length); setCaret(prefix.length); });
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') setDismissed(true);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length));
      else if (!loading && filtered[index]) choose(filtered[index]);
    }
  }
  return <div className="wmux-chat-input-wrap">
    {open && <div className="wmux-chat-skills" aria-label={t('chat.skills')}>
      <div className="wmux-chat-skills-heading"><strong>{t('chat.skills')}</strong><span>{scope?.agent === 'codex' ? t('chat.skillsCodexHint') : t('chat.skillsHint')}</span></div>
      {loading ? <p role="status">{t('chat.loading')}</p> : catalog?.state === 'unavailable' ? <p role="status">{t('chat.skillsUnavailable')} <button type="button" onClick={() => setReload(value => value + 1)}>{t('chat.retry')}</button></p> : <>
        {catalog?.state === 'partial' && <p role="status">{t('chat.skillsPartial')}</p>}
        {!filtered.length && <p role="status">{t(catalog?.skills.length ? 'chat.skillsNoMatch' : 'chat.skillsEmpty')}</p>}
      </>}
      <div ref={list} id={id} role="listbox" aria-label={t('chat.skills')} className="wmux-chat-skills-list">
        {!loading && filtered.map((skill, i) => <button key={skill.invocation} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(i)} onClick={() => choose(skill)}>
          <span><strong>{skill.invocation}</strong><small>{t(`chat.skillSource.${skill.source}`)}</small></span>
          {skill.description && <span className="wmux-chat-skill-description" title={skill.description}>{skill.description}</span>}
        </button>)}
      </div>
      <div className="wmux-chat-skills-keys">{t('chat.skillsKeys')}</div>
    </div>}
    <ComposerPrimitive.Input ref={input} className="wmux-chat-input" aria-label={t('chat.message')} placeholder={placeholder}
      role={enabled ? 'combobox' : undefined} aria-autocomplete={enabled ? 'list' : undefined} aria-expanded={enabled ? open : undefined}
      aria-controls={open ? id : undefined} aria-activedescendant={open && !loading && filtered[index] ? `${id}-${index}` : undefined}
      disabled={disabled} maxLength={maxLength} rows={1} maxRows={8} submitMode="enter" enterKeyHint="send" addAttachmentOnPaste={false}
      cancelOnEscape={!open} onKeyDown={keyDown} onChange={event => { setCaret(event.target.selectionStart); setDismissed(false); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onBlur={event => { if (!event.relatedTarget || !event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setDismissed(true); }}
      unstable_focusOnThreadSwitched={false} unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false} />
    {enabled && <button type="button" className="wmux-chat-skills-trigger" disabled={disabled} title={t('chat.skills')} aria-label={t('chat.skills')}
      onClick={() => {
        if (!scope) return;
        let next = scope.composer.getState().text;
        if (!/^[/$]/.test(next)) { next = '/' + (next ? ' ' + next : ''); scope.composer.setText(next); }
        setCaret(1); setDismissed(false); input.current?.focus(); input.current?.setSelectionRange(1, 1);
      }}>/</button>}
  </div>;
}
