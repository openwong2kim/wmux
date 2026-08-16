import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { injectText, attachFilesToPty } from './inject';
import { collectBroadcastPtyIds } from './BroadcastPopover';
import { placePopover } from './placePopover';
import Button from '../ui/Button';
import { IconPaperclip } from '../icons';

const ARM_MS = 4000;
const COMPOSE_W = 480;
const COMPOSE_H = 420;

interface ComposePopoverProps {
  paneId: string;
  ptyId: string;
}

export default function ComposePopover({ paneId, ptyId }: ComposePopoverProps) {
  const t = useT();
  const draft = useStore((s) => s.richDraftByPane[ptyId] ?? '');
  const setRichDraft = useStore((s) => s.setRichDraft);
  const clearRichDraft = useStore((s) => s.clearRichDraft);
  const closeCompose = useStore((s) => s.closeCompose);
  const target = useStore((s) => s.composeTarget);
  const setComposeTarget = useStore((s) => s.setComposeTarget);
  const snippets = useStore((s) => s.toolbarSnippets);
  const addSnippet = useStore((s) => s.addSnippet);
  const newCommand = useStore((s) => s.newConversationCommand);
  const activeWorkspace = useStore(selectActiveWorkspace);
  const ref = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [addingSnippet, setAddingSnippet] = useState(false);
  const [snipLabel, setSnipLabel] = useState('');
  const [snipText, setSnipText] = useState('');
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);

  const ptyIds = useMemo(
    () => (activeWorkspace ? collectBroadcastPtyIds(activeWorkspace) : []),
    [activeWorkspace],
  );
  const targetCount = ptyIds.length;

  useEffect(() => { ref.current?.focus(); }, []);

  useEffect(() => {
    setArmed(false);
    setResult(null);
  }, [target]);

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), ARM_MS);
    return () => window.clearTimeout(id);
  }, [armed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCompose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeCompose]);

  const insertSnippet = (body: string) => {
    const cur = useStore.getState().richDraftByPane[ptyId] ?? '';
    const needsGap = cur.length > 0 && !/[\s\n]$/.test(cur);
    setRichDraft(ptyId, needsGap ? `${cur} ${body}` : `${cur}${body}`);
    ref.current?.focus();
  };

  const dispatchPane = async (submit: boolean) => {
    const text = useStore.getState().richDraftByPane[ptyId] ?? '';
    if (!text.trim()) return;
    await injectText(ptyId, text, submit);
    clearRichDraft(ptyId);
    closeCompose();
  };

  const dispatchAll = async () => {
    if (sendingRef.current) return;
    const body = (useStore.getState().richDraftByPane[ptyId] ?? '').trim();
    if (body.length === 0 || ptyIds.length === 0) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      const settled = await Promise.allSettled(ptyIds.map((id) => injectText(id, body, true)));
      const ok = settled.filter((r) => r.status === 'fulfilled').length;
      setResult({ ok, fail: settled.length - ok });
      clearRichDraft(ptyId);
      closeCompose();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleSend = () => {
    if (target === 'workspace') void dispatchAll();
    else void dispatchPane(true);
  };

  const anchorEl = document.querySelector(`[data-pane-action="compose"][data-pane-id="${paneId}"]`)
    ?? document.querySelector('[data-pane-tabs-active="true"]');
  const pos = placePopover(anchorEl?.getBoundingClientRect() ?? null, { width: COMPOSE_W, height: COMPOSE_H });

  const node = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('toolbar.compose')}
      data-testid="compose-popover"
      data-compose-host
      className="fixed w-[30rem] max-w-[calc(100vw-16px)] rounded-[7px] border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl font-mono text-xs"
      style={{ top: pos.top, left: pos.left, zIndex: 'var(--z-popover-top)' }}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--bg-surface)] rounded-t-[7px] bg-[var(--bg-surface)]">
        <span className="text-[var(--text-sub)]">{t('toolbar.compose')}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="ui-icon-btn w-6 h-6"
            title={t('toolbar.attachFiles')}
            aria-label={t('toolbar.attachFiles')}
            data-testid="compose-attach"
            onClick={() => { void attachFilesToPty(ptyId); }}
          >
            <IconPaperclip size={13} />
          </button>
          <button
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] px-1 leading-none"
            title={t('toolbar.close')}
            aria-label={t('toolbar.close')}
            onClick={() => closeCompose()}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex rounded-[5px] border border-[var(--bg-overlay)] p-0.5 m-2 mb-0" role="tablist" data-testid="compose-target">
        <button
          type="button"
          role="tab"
          aria-selected={target === 'pane'}
          data-testid="compose-target-pane"
          className={`flex-1 text-[11px] rounded-[4px] py-1 transition-colors ${
            target === 'pane' ? 'bg-[var(--bg-overlay)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'
          }`}
          onClick={() => setComposeTarget('pane')}
        >
          {t('toolbar.composeThisPane')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={target === 'workspace'}
          data-testid="compose-target-all"
          className={`flex-1 text-[11px] rounded-[4px] py-1 transition-colors ${
            target === 'workspace' ? 'bg-[var(--bg-overlay)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'
          }`}
          onClick={() => setComposeTarget('workspace')}
        >
          {t('toolbar.composeAllTerminals', { n: targetCount })}
        </button>
      </div>

      <div className="px-2 pt-2 flex flex-wrap gap-1" data-testid="compose-snippets">
        {snippets.map((s) => (
          <button
            key={s.id}
            type="button"
            className="px-1.5 py-0.5 rounded-[4px] border border-[var(--bg-overlay)] text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] hover:border-[var(--text-muted)]"
            title={s.text}
            onClick={() => insertSnippet(s.text)}
          >
            {s.label}
          </button>
        ))}
        {snippets.length === 0 && !addingSnippet && (
          <button
            type="button"
            className="px-1.5 py-0.5 rounded-[4px] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-sub)]"
            data-testid="compose-add-snippet"
            onClick={() => setAddingSnippet(true)}
          >
            {t('toolbar.addSnippetEmpty')}
          </button>
        )}
        {(addingSnippet || snippets.length > 0) && (
          <button
            type="button"
            className="px-1.5 py-0.5 rounded-[4px] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-sub)]"
            data-testid="compose-add-snippet"
            onClick={() => setAddingSnippet((v) => !v)}
          >
            {t('toolbar.addSnippetEmpty')}
          </button>
        )}
      </div>

      {addingSnippet && (
        <div className="px-2 pt-1.5 flex flex-col gap-1">
          <input
            className="ui-input text-[11px]"
            placeholder={t('toolbar.snippetLabel')}
            value={snipLabel}
            onChange={(e) => setSnipLabel(e.target.value)}
          />
          <textarea
            className="ui-input h-12 resize-none text-[11px]"
            placeholder={t('toolbar.snippetText')}
            value={snipText}
            onChange={(e) => setSnipText(e.target.value)}
          />
          <Button
            variant="secondary"
            className="self-end text-[10px]"
            disabled={!snipLabel.trim() || !snipText.trim()}
            onClick={() => {
              addSnippet(snipLabel.trim(), snipText.trim());
              setSnipLabel('');
              setSnipText('');
              setAddingSnippet(false);
            }}
          >
            {t('toolbar.addSnippet')}
          </Button>
        </div>
      )}

      <div className="p-2">
        <textarea
          ref={ref}
          className="ui-input h-52 min-h-[8rem] resize-y"
          placeholder={t('toolbar.richPlaceholder')}
          value={draft}
          data-testid="compose-input"
          onChange={(e) => setRichDraft(ptyId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeCompose(); }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <button
            type="button"
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-sub)]"
            data-testid="compose-new-chip"
            title={newCommand}
            onClick={() => insertSnippet(newCommand)}
          >
            {t('toolbar.newConversation')}
          </button>
          <div className="flex items-center gap-2">
            {result && (
              <span className="text-[10px] text-[var(--text-muted)]" data-testid="compose-result">
                {t('toolbar.broadcastResult', { ok: result.ok, fail: result.fail })}
              </span>
            )}
            {target === 'pane' && (
              <Button
                variant="secondary"
                disabled={!draft.trim()}
                data-testid="compose-add-to-prompt"
                onClick={() => void dispatchPane(false)}
              >
                {t('toolbar.addToPrompt')}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!draft.trim() || sending || (target === 'workspace' && targetCount === 0)}
              data-testid="compose-send"
              onClick={handleSend}
            >
              {target === 'workspace'
                ? (sending ? t('toolbar.broadcastSending') : t('toolbar.sendToN', { n: targetCount }))
                : <>{t('toolbar.send')} ▸</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
