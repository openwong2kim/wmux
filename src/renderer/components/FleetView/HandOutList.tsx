// Fleet's To hand out items (shared/handOut.ts): work nobody has been given
// yet, as cards in the board's first column and rows of the list's quiet
// section. Item text (title, note, folder, who added it) is untrusted:
// rendered as text only.
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { HAND_OUT_LIMITS, type HandOutAddResult, type HandOutEntry } from '../../../shared/handOut';
import type { Workspace } from '../../../shared/types';
import { displayPath } from '../../utils/displayPath';
import { shortDir } from '../../utils/shortDir';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';
import { useAgentChoices } from '../Sidebar/CompanyPresetDialog';
import { workspaceFolder } from '../Sidebar/externalSessionPlacement';
import PaneActionsMenu, { type PaneActionItem } from '../Pane/PaneActionsMenu';
import { IconChevron, IconX } from '../icons';
import { useStore } from '../../stores';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import TextArea from '../ui/TextArea';

type T = (key: string, vars?: Record<string, string | number>) => string;

export const handOutKey = (id: string) => `handout:${id}`;

/** The hollow ring that marks To hand out: no status colour, nobody has it. */
export function HandOutRing() {
  return <span aria-hidden="true" className="inline-block flex-none w-[7px] h-[7px] rounded-full border border-[var(--text-muted)]" />;
}

/** "Added by you · 2d", or "Added by #ceo · wmux co. · 3h". */
export function handOutAddedLine(item: HandOutEntry, now: number, workspaceName: (id: string) => string, t: T): string {
  const age = now - item.createdAt < IDLE_SHOW_AFTER_MS ? t('fleet.handOut.now') : formatIdle(Math.max(0, now - item.createdAt));
  if (item.addedBy.kind === 'owner') return [t('fleet.handOut.addedByYou'), age].join(' · ');
  const who = item.addedBy.name ? `#${item.addedBy.name}` : t('fleet.handOut.aPane');
  return [t('fleet.handOut.addedBy', { name: who }), workspaceName(item.addedBy.workspaceId), age].filter(Boolean).join(' · ');
}

interface HandOutCardProps {
  item: HandOutEntry;
  layout: 'list' | 'board';
  focused: boolean;
  now: number;
  workspaceName: (id: string) => string;
  onFocus: () => void;
  /** Enter: the Hand out… popover. */
  onHandOut: (item: HandOutEntry) => void;
  /** Backspace / Delete: the inline Remove confirm. */
  onRemove: (item: HandOutEntry) => void;
  t: T;
}

function HandOutCardImpl({ item, layout, focused, now, workspaceName, onFocus, onHandOut, onRemove, t }: HandOutCardProps) {
  const folder = displayPath(item.folder);
  const agent = item.agent ?? t('fleet.handOut.anyAgent');
  // The board's cards sit on a fill like the other cards; the list's rows are
  // a fill only on hover and selection.
  const surface = layout === 'board'
    ? 'px-3 py-2.5 rounded-[10px] bg-[var(--selection-subtle)] hover:bg-[var(--selection)] aria-selected:bg-[var(--selection-hover)]'
    : 'px-2 py-[9px] pr-[120px] rounded-[8px] hover:bg-[var(--hover-fill)] aria-selected:bg-[var(--selection)]';
  // On the board the title makes room for the right lane while the card is
  // selected or focused; on hover the lane's button sits over it.
  const titleLane = layout === 'board' ? (focused ? 'pr-[104px]' : 'group-focus-within:pr-[104px]') : '';
  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={[item.title, folder, agent].join(', ')}
      title={item.note || undefined}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onHandOut(item);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          onRemove(item);
        }
      }}
      className={`flex flex-col gap-[3px] w-full min-w-0 text-left outline-none focus-visible:![outline:2px_solid_var(--accent)] focus-visible:![outline-offset:-2px] ${surface}`}
      data-fleet-hand-out={item.id}
      data-fleet-key={handOutKey(item.id)}
    >
      <span className={`line-clamp-2 [overflow-wrap:anywhere] text-[13px] leading-[18px] text-[var(--text-main)] ${titleLane}`}>{item.title}</span>
      <span className="flex items-center gap-1.5 min-w-0 text-[11px] leading-[14px]">
        {/* The folder's own name is what tells items apart: the line keeps its
            last two segments, the tooltip and the accessible name the path. */}
        <span className="truncate font-mono text-[var(--text-sub)]" title={folder} data-fleet-hand-out-folder-line>{shortDir(folder)}</span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">·</span>
        <span className={`flex-none ${item.agent ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)]'}`}>{agent}</span>
      </span>
      <span className="truncate text-[11px] leading-[14px] text-[var(--text-muted)]">{handOutAddedLine(item, now, workspaceName, t)}</span>
    </button>
  );
}

export const HandOutCard = memo(HandOutCardImpl);

/** The right lane's "Hand out…": shown on hover, focus and selection. A
 *  pointer twin of the card's Enter, so it stays out of the listbox's tree. */
export function HandOutLaneButton({ item, layout, shown, onHandOut, t }: {
  item: HandOutEntry;
  layout: 'list' | 'board';
  shown: boolean;
  onHandOut: (item: HandOutEntry) => void;
  t: T;
}) {
  const place = layout === 'board' ? 'top-[6px]' : 'top-1/2 -translate-y-1/2';
  const visibility = shown ? 'opacity-100 pointer-events-auto'
    : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';
  return (
    <Button variant="secondary" size="sm" tabIndex={-1} aria-hidden="true"
      // Opaque, since on hover it sits over the card's title.
      className={`absolute right-[36px] !min-h-[24px] h-[24px] !bg-[var(--bg-base)] ${place} ${visibility}`}
      onClick={(e) => { e.stopPropagation(); onHandOut(item); }} data-fleet-hand-out-lane>
      {t('fleet.handOut.handOut')}
    </Button>
  );
}

/** The folders an item can be for: each open workspace's, the active one's
 *  first, without repeats. */
export function handOutFolderChoices(workspaces: readonly Workspace[], activeWorkspaceId: string | null): string[] {
  const ordered = [...workspaces].sort((a, b) => Number(b.id === activeWorkspaceId) - Number(a.id === activeWorkspaceId));
  const out: string[] = [];
  for (const ws of ordered) {
    const folder = workspaceFolder(ws);
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

interface HandOutAddFormProps {
  folders: readonly string[];
  /** Closed: `added` is the new item's id, absent on Cancel. */
  onDone: (added?: string) => void;
  t: T;
}

/** Add a task: its title, the folder it is for (a workspace's, or a typed
 *  path), the agent it asks for and a note. Enter adds; Escape (FleetView's
 *  key handler) cancels. */
export function HandOutAddForm({ folders, onDone, t }: HandOutAddFormProps) {
  const agents = useAgentChoices().filter((choice) => choice.installed);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [agent, setAgent] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const folderId = useId();
  const agentId = useId();
  // A reply that lands after the form closed has nothing to show.
  const open = useRef(true);
  useEffect(() => () => { open.current = false; }, []);
  const canAdd = !!title.trim() && !!folder.trim() && !busy;

  const submit = async () => {
    const add = window.electronAPI?.handOut?.add;
    if (!add || !canAdd) return;
    setBusy(true);
    setError(null);
    let res: HandOutAddResult | null;
    try {
      res = await add({ title, folder: folder.trim(), ...(agent ? { agent } : {}), ...(note.trim() ? { note } : {}) });
    } catch {
      res = null;
    }
    if (!open.current) return;
    setBusy(false);
    if (!res) setError(t('fleet.handOut.form.failed'));
    else if (res.ok) onDone(res.item.id);
    else setError(t(res.code === 'full' ? 'fleet.handOut.form.full' : 'fleet.handOut.form.invalid'));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    // A focused button keeps its own Enter (Cancel cancels).
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;
    // The note keeps Shift+Enter for its second line.
    if (event.shiftKey && event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    void submit();
  };
  const edited = () => setError(null);

  return (
    <div role="group" aria-label={t('fleet.handOut.form.label')} onKeyDown={onKeyDown}
      className="flex flex-col gap-2 p-3 rounded-[10px] bg-[var(--selection-subtle)]" data-fleet-hand-out-form>
      <Input autoFocus value={title} maxLength={HAND_OUT_LIMITS.MAX_TITLE} placeholder={t('fleet.handOut.form.title')} aria-label={t('fleet.handOut.form.title')}
        onChange={(e) => { setTitle(e.target.value); edited(); }} className="text-[13px]" data-fleet-hand-out-title />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <label htmlFor={folderId} className="text-[12px] text-[var(--text-sub)]">{t('fleet.handOut.form.folder')}</label>
        <Input id={folderId} list={listId} value={folder} spellCheck={false} placeholder={t('fleet.handOut.form.folderPlaceholder')}
          onChange={(e) => { setFolder(e.target.value); edited(); }} className="font-mono text-[12px]" data-fleet-hand-out-folder />
        <datalist id={listId}>{folders.map((f) => <option key={f} value={f}>{displayPath(f)}</option>)}</datalist>
        <label htmlFor={agentId} className="text-[12px] text-[var(--text-sub)]">{t('fleet.handOut.form.agent')}</label>
        <Select id={agentId} value={agent} onChange={(e) => setAgent(e.target.value)} data-fleet-hand-out-agent>
          <option value="">{t('fleet.handOut.form.anyAgent')}</option>
          {agents.map((choice) => <option key={choice.agent} value={choice.agent}>{choice.label}</option>)}
        </Select>
      </div>
      <TextArea rows={2} value={note} maxLength={HAND_OUT_LIMITS.MAX_NOTE} placeholder={t('fleet.handOut.form.note')} aria-label={t('fleet.handOut.form.note')}
        onChange={(e) => setNote(e.target.value)} className="text-[12px]" data-fleet-hand-out-note />
      {error && <p role="alert" className="m-0 text-[11px] text-[var(--accent-red)]" data-fleet-hand-out-error>{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDone()} data-fleet-hand-out-cancel>{t('fleet.handOut.form.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={!canAdd} onClick={() => void submit()} data-fleet-hand-out-submit>
          {t('fleet.handOut.form.add')}
        </Button>
      </div>
    </div>
  );
}

interface HandOutMenuProps {
  item: HandOutEntry;
  onHandOut: (item: HandOutEntry) => void;
  onRemove: (item: HandOutEntry) => void;
  /** Told the menu's close function while it is open (null once closed), so
   *  FleetView's Escape closes the menu rather than the page. */
  onMenuOpenChange?: (close: (() => void) | null) => void;
  t: T;
}

/** An item's ⋮ menu (Shift+F10 on the card opens it): Hand out… and Remove. */
export function HandOutMenu({ item, onHandOut, onRemove, onMenuOpenChange, t }: HandOutMenuProps) {
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setAnchor(null);
    onMenuOpenChange?.(null);
  }, [onMenuOpenChange]);
  const openRef = useRef(false);
  openRef.current = anchor !== null;
  useEffect(() => () => { if (openRef.current) onMenuOpenChange?.(null); }, [onMenuOpenChange]);
  const items: PaneActionItem[] = [
    { key: 'hand-out', label: t('fleet.handOut.handOut'), shortcut: 'Enter', icon: <IconChevron size={12} />, onSelect: () => onHandOut(item) },
    { key: 'remove', label: t('fleet.handOut.remove'), shortcut: '⌫', icon: <IconX size={12} />, separatorBefore: true, onSelect: () => onRemove(item) },
  ];
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="wmux-fleet-row-trigger"
        // Pointer twin of the card's keys: out of the listbox's tree.
        tabIndex={-1}
        aria-hidden="true"
        title={t('pane.moreActions')}
        aria-label={t('pane.moreActions')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-fleet-row-trigger
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) { close(); return; }
          setAnchor(e.currentTarget.getBoundingClientRect());
          onMenuOpenChange?.(close);
        }}
      >
        <span aria-hidden="true" className="font-mono text-[13px] leading-none">⋮</span>
      </button>
      {anchor && <PaneActionsMenu anchor={anchor} triggerRef={triggerRef} items={items} onClose={close} />}
    </>
  );
}

/** Remove's inline confirm under the card: Cancel first and focused. */
export function HandOutRemoveConfirm({ item, onDone, t }: { item: HandOutEntry; onDone: () => void; t: T }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Opened from the ⋮ menu, the confirm mounts in the same commit the menu
  // unmounts, and the menu's cleanup hands focus back to ⋮ afterwards. Take it
  // on the next frame so Cancel (the safe default) holds focus.
  useEffect(() => {
    const raf = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);
  const remove = () => {
    const call = window.electronAPI?.handOut?.remove;
    onDone();
    if (!call) return;
    call(item.id).then((res) => {
      if (!res?.ok) useStore.getState().pushToast({ level: 'error', message: t('fleet.handOut.removeFailed') });
    }, () => useStore.getState().pushToast({ level: 'error', message: t('fleet.handOut.removeFailed') }));
  };
  return (
    <div className="wmux-fleet-editor" role="group" aria-label={t('fleet.handOut.remove')} data-fleet-hand-out-remove={item.id}>
      <span className="wmux-fleet-editor-text">{t('fleet.handOut.removeConfirm')}</span>
      <button ref={cancelRef} type="button" autoFocus onClick={onDone} data-fleet-hand-out-remove-cancel>{t('fleet.handOut.form.cancel')}</button>
      <button type="button" className="is-destructive" onClick={remove} data-fleet-hand-out-remove-confirm>{t('fleet.handOut.remove')}</button>
    </div>
  );
}
