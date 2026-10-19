// ─── Photos on Bots messages (renderer) ──────────────────────────────────
//
// The composer stages photos as Chat view does (DESIGN.md "Chat feedback",
// 2026-09-25): a chip per photo — thumbnail, name, × — from the picker, a
// paste or a drop; main copies them into the room's store when the message
// is sent (room.handler.ts postWithPhotos). An owner card shows its photos
// as thumbnails above the words; a click opens the photo fitted in a dialog.
// Main serves the room's stored copy only (ROOM_ATTACHMENT), never a path.

import { useEffect, useState } from 'react';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import { ROOM_ATTACHMENT_LIMITS } from '../../../shared/roomAttachments';
import { roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The formats a room takes (PNG and JPEG), by a picked file's name. */
export function isRoomPhotoPath(path: string): boolean {
  return /\.(?:png|jpe?g)$/i.test(path);
}

export const ROOM_PHOTO_LIMIT = ROOM_ATTACHMENT_LIMITS.PER_MESSAGE;

/** Whether a card is photos only: its title is wmux's placeholder. */
export function photoOnlyCard(card: Pick<RoomCardData, 'attachments' | 'body'>): boolean {
  return !!card.attachments?.length && !card.body?.trim();
}

/**
 * A file dropped on the window while the Bots page shows belongs to the open
 * composer. AppLayout owns the window-wide drop; the mounted composer
 * registers here (the newest registration takes it).
 */
let dropTarget: ((paths: string[]) => void) | null = null;
export function registerBotsDropTarget(take: (paths: string[]) => void): () => void {
  dropTarget = take;
  return () => { if (dropTarget === take) dropTarget = null; };
}
export function deliverBotsDrop(paths: string[]): boolean {
  if (!dropTarget) return false;
  dropTarget(paths);
  return true;
}

// The photos of cards on screen, by room and id (a small cache: a card
// re-renders with every room event).
const photoCache = new Map<string, Promise<string | null>>();
function roomPhoto(api: RoomsApi | null | undefined, workspaceId: string, attachmentId: string): Promise<string | null> {
  const get = (api === undefined ? roomsApi() : api)?.attachment;
  if (!get) return Promise.resolve(null);
  const key = `${workspaceId}/${attachmentId}`;
  let hit = photoCache.get(key);
  if (!hit) {
    hit = get({ workspaceId, attachmentId }).then((r) => (r.ok ? r.dataUrl : null)).catch(() => null);
    photoCache.set(key, hit);
    if (photoCache.size > 48) photoCache.delete(photoCache.keys().next().value!);
  }
  return hit;
}

function CardPhoto({ api, workspaceId, attachmentId, index, count, t, onOpen }: {
  api: RoomsApi | null | undefined; workspaceId: string; attachmentId: string; index: number; count: number; t: T; onOpen: (src: string) => void;
}) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void roomPhoto(api, workspaceId, attachmentId).then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [api, workspaceId, attachmentId]);
  const label = count > 1 ? t('room.photo.openNth', { n: index + 1, count }) : t('room.photo.open');
  if (src === null) {
    return <span className="wmux-chat-image" data-bots-photo-missing><span className="wmux-chat-image-name">{t('room.photo.unavailable')}</span></span>;
  }
  return (
    <button type="button" className="wmux-chat-image" data-bots-photo={attachmentId} aria-label={label} title={label} disabled={!src} onClick={() => src && onOpen(src)}>
      {src ? <img src={src} alt="" /> : <span className="wmux-chat-image-name">{t('room.photo.loading')}</span>}
    </button>
  );
}

/** An owner card's photos: thumbnails, a click opens one full size. */
export function CardPhotos({ card, api, t }: { card: RoomCardData; api: RoomsApi | null | undefined; t: T }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = card.attachments ?? [];
  if (list.length === 0) return null;
  return (
    <>
      <div className="wmux-chat-images" data-bots-photos>
        {list.map((a, i) => (
          <CardPhoto key={a.id} api={api} workspaceId={card.workspaceId} attachmentId={a.id} index={i} count={list.length} t={t} onOpen={setOpen} />
        ))}
      </div>
      {open && (
        // Escape, the × and a click on the backdrop close it; focus goes back
        // to the thumbnail that opened it (the dialog's opener).
        <Dialog onClose={() => setOpen(null)} width={1100} closeOnBackdrop data-testid="bots-photo-viewer">
          <DialogHeader title={t('room.photo.viewer')} closeLabel={t('room.photo.close')} closeTestId="bots-photo-viewer-close" />
          <DialogBody>
            <div className="wmux-bots-photo-viewer">
              <img src={open} alt="" />
            </div>
          </DialogBody>
        </Dialog>
      )}
    </>
  );
}
