// Persisted registry of ATTACHED remote workspaces (main process only).
//
// Sibling of RemoteHostsStore, deliberately a separate file: a descriptor here
// holds no credential (the bearer token stays in remote-hosts.json), so this
// one is written with the ordinary atomic-JSON path rather than
// secureWriteTokenFile. Keeping them apart is what makes that difference
// structural instead of a convention someone has to remember.
//
// Why persist at all: the renderer's remoteWorkspacesSlice is memory-only and
// a reload (Cmd+R) or app restart recreates it empty, which silently dropped
// every attachment. The DESCRIPTORS live here; the panes never do — they are
// re-fetched from the host at restore time.

import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { RemoteAttachmentDescriptor } from '../../shared/remoteHosts';

/** Structural validation for a loaded file — malformed/foreign shapes are
 *  treated the same as a missing file (empty list, never throw). */
function isDescriptorArray(v: unknown): v is RemoteAttachmentDescriptor[] {
  if (!Array.isArray(v)) return false;
  return v.every((r) => {
    if (typeof r !== 'object' || r === null) return false;
    const rec = r as Record<string, unknown>;
    return (
      typeof rec.key === 'string' &&
      typeof rec.hostId === 'string' &&
      typeof rec.hostLabel === 'string' &&
      typeof rec.workspaceId === 'string' &&
      typeof rec.name === 'string'
    );
  });
}

/** Strips anything beyond the five persisted fields — a caller that hands us
 *  a full AttachedRemoteWorkspace must not get its `panes` written to disk. */
function toDescriptor(d: RemoteAttachmentDescriptor): RemoteAttachmentDescriptor {
  return {
    key: d.key,
    hostId: d.hostId,
    hostLabel: d.hostLabel,
    workspaceId: d.workspaceId,
    name: d.name,
  };
}

export class RemoteAttachmentsStore {
  private readonly filePath: string;
  private attachments: RemoteAttachmentDescriptor[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  list(): RemoteAttachmentDescriptor[] {
    return this.attachments.map(toDescriptor);
  }

  /** Dedup by key — re-attaching the same workspace refreshes the stored
   *  label/name in place rather than appending a duplicate row. */
  add(descriptor: RemoteAttachmentDescriptor): void {
    const entry = toDescriptor(descriptor);
    const idx = this.attachments.findIndex((a) => a.key === entry.key);
    const next = [...this.attachments];
    if (idx === -1) next.push(entry);
    else next[idx] = entry;
    this.persist(next);
    this.attachments = next;
  }

  remove(key: string): boolean {
    const next = this.attachments.filter((a) => a.key !== key);
    if (next.length === this.attachments.length) return false;
    this.persist(next);
    this.attachments = next;
    return true;
  }

  /** Cascade for host removal — a descriptor pointing at a host that is no
   *  longer registered can never be restored, so it must not outlive it. */
  removeByHost(hostId: string): number {
    const next = this.attachments.filter((a) => a.hostId !== hostId);
    const removed = this.attachments.length - next.length;
    if (removed === 0) return 0;
    this.persist(next);
    this.attachments = next;
    return removed;
  }

  private persist(attachments: RemoteAttachmentDescriptor[]): void {
    atomicWriteJSONSync(this.filePath, attachments);
  }

  private load(): void {
    try {
      const parsed = atomicReadJSONSync<unknown>(this.filePath);
      this.attachments = isDescriptorArray(parsed) ? parsed.map(toDescriptor) : [];
    } catch {
      // Missing/corrupt file → empty list, never throw (load-on-construct
      // contract, same as RemoteHostsStore).
      this.attachments = [];
    }
  }
}
