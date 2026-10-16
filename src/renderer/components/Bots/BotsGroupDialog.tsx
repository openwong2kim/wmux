// ─── New group chat / a group chat's settings (owner decision 2026-10-15) ──
//
// The owner makes group chats; bots never do. A group is a name and two or
// more bots of one workspace (they share its repository and its room), so
// the bots offered are the chosen workspace's only, and a workspace with
// fewer than two says so. The same form edits a group: rename it, change
// its bots, or delete it (asked in place; its messages stay saved, the row
// goes).
import { useMemo, useState } from 'react';
import type { BotGroup } from '../../../shared/botGroup';
import { BOT_GROUP_LIMITS, normalizeGroupName } from '../../../shared/botGroup';
import type { FactoryBotRow } from '../Room/factoryPorts';
import type { BotGroupPort } from '../Room/botGroups';
import BotAvatar from '../Room/BotAvatar';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { InlineConfirm } from './InlineConfirm';
import { botModelSummary } from './botsProfile';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** What the form opens with: a new group (a workspace, and a name and bots
 *  to start from — Add team's), or a group to edit. */
export type GroupDialogStart =
  | { kind: 'new'; workspaceId: string | null; name?: string; memberIds?: readonly string[] }
  | { kind: 'edit'; group: BotGroup };

/** Why Create / Save is not possible yet, as an i18n key, or null. Pure. */
export function groupFormBlocked(name: string, picked: readonly string[], available: number): string | null {
  if (available < BOT_GROUP_LIMITS.MEMBERS_MIN) return 'botsPage.group.needTwoBots';
  if (!normalizeGroupName(name)) return 'botsPage.group.needName';
  if (picked.length < BOT_GROUP_LIMITS.MEMBERS_MIN) return 'botsPage.group.pickTwo';
  return null;
}

export default function BotsGroupDialog({ start, bots, workspaces, port, t, onDone, onClose }: {
  start: GroupDialogStart;
  bots: readonly FactoryBotRow[];
  /** The owner's workspaces, by name. */
  workspaces: readonly { id: string; name: string }[];
  port: BotGroupPort;
  t: T;
  /** The group made or saved (null: deleted). */
  onDone: (group: BotGroup | null) => void;
  onClose: () => void;
}): React.ReactElement {
  const editing = start.kind === 'edit' ? start.group : null;
  // Workspaces with bots, the ones a group can be made in.
  const withBots = useMemo(() => workspaces.filter((w) => bots.some((r) => r.bot.workspaceId === w.id)), [workspaces, bots]);
  const [workspaceId, setWorkspaceId] = useState<string>(() => editing?.workspaceId
    ?? (start.kind === 'new' && start.workspaceId && withBots.some((w) => w.id === start.workspaceId) ? start.workspaceId : withBots[0]?.id ?? ''));
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
  const [name, setName] = useState<string>(() => (editing ? editing.name || workspaceName : start.kind === 'new' ? start.name ?? '' : ''));
  const [picked, setPicked] = useState<string[]>(() => [...(editing?.memberIds ?? (start.kind === 'new' ? start.memberIds ?? [] : []))]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const here = useMemo(
    () => bots.filter((r) => r.bot.workspaceId === workspaceId).sort((a, b) => a.bot.createdAt - b.bot.createdAt),
    [bots, workspaceId],
  );
  const chosen = picked.filter((id) => here.some((r) => r.bot.id === id));
  const blocked = groupFormBlocked(name, chosen, here.length);

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async () => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = editing
        ? await port.update({ id: editing.id, name, memberIds: chosen })
        : await port.create({ workspaceId, name, memberIds: chosen });
      if (r.ok) onDone(r.group);
      else setError(r.message || t('botsPage.group.failed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await port.remove(editing.id);
      if (r.ok) onDone(null);
      else setError(r.message || t('botsPage.group.failed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width={440} data-testid="bots-group-dialog">
      <DialogHeader title={editing ? t('botsPage.group.editTitle') : t('botsPage.group.newTitle')} closeLabel={t('settings.close')} />
      <DialogBody>
        <form
          className="flex flex-col gap-3 px-3 py-2"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          {!editing && (
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
              <span className="w-[96px] shrink-0">{t('settings.factory.addBotWorkspace')}</span>
              <Select data-bots-group-workspace value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setPicked([]); }}>
                {withBots.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
            <span className="w-[96px] shrink-0">{t('botsPage.group.name')}</span>
            <Input
              data-bots-group-name
              autoFocus
              value={name}
              maxLength={BOT_GROUP_LIMITS.NAME_MAX}
              placeholder={t('botsPage.group.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 text-[13px]"
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[12px] text-[var(--text-sub)]">{t('botsPage.group.bots')}</legend>
            <p className="text-[11px] text-[var(--text-muted)]">{t('botsPage.group.sameWorkspace', { workspace: workspaceName })}</p>
            {here.map((r) => (
              <label key={r.bot.id} className="ui-section-row w-full cursor-pointer text-left text-[13px]">
                <input type="checkbox" data-bots-group-member={r.bot.id} checked={chosen.includes(r.bot.id)} onChange={() => toggle(r.bot.id)} className={FOCUS_RING} />
                <BotAvatar bot={r.bot} size={20} />
                <span className="min-w-0 truncate">{r.bot.name}</span>
                {botModelSummary(r.bot, t) && <span data-bots-group-member-models className="ml-auto min-w-0 truncate text-[11px] text-[var(--text-muted)]">{botModelSummary(r.bot, t)}</span>}
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" data-bots-group-error className="text-[12px] text-[var(--accent-red)]">{error}</p>}
          {confirmDelete ? (
            <InlineConfirm
              text={t('botsPage.group.deleteConfirm', { name: editing?.name || workspaceName })}
              confirmLabel={t('botsPage.group.delete')}
              cancelLabel={t('room.hq.cancel')}
              busy={busy}
              onConfirm={() => void remove()}
              onCancel={() => setConfirmDelete(false)}
              testId="bots-group-delete"
            />
          ) : (
            <div className="flex items-center justify-end gap-1.5">
              {blocked && <span data-bots-group-blocked className="mr-auto min-w-0 truncate text-[11px] text-[var(--text-muted)]">{t(blocked, { workspace: workspaceName })}</span>}
              {editing && (
                <Button type="button" size="sm" variant="secondary" data-bots-group-delete onClick={() => setConfirmDelete(true)} disabled={busy}>
                  {t('botsPage.group.delete')}
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>{t('settings.factory.cancel')}</Button>
              <Button type="submit" size="sm" variant="primary" data-bots-group-save disabled={!!blocked || busy}>
                {editing ? t('botsPage.group.save') : t('botsPage.group.create')}
              </Button>
            </div>
          )}
        </form>
      </DialogBody>
    </Dialog>
  );
}
