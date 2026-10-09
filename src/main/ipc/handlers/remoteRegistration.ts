// The remote-host IPC surfaces, registered together over ONE pair of stores:
// the attach handlers (remote.handler.ts) and the PC rail feeds
// (pcRail.handler.ts). Sharing the instances is what keeps a host paired,
// re-paired or removed on one surface current on the other.

import { registerRemoteHandlers } from './remote.handler';
import { registerPcRailHandlers } from './pcRail.handler';
import { RemoteHostsStore } from '../../remote/RemoteHostsStore';
import { RemoteAttachmentsStore } from '../../remote/RemoteAttachmentsStore';

export interface RemoteRegistrationDeps {
  registerRemote: typeof registerRemoteHandlers;
  registerPcRail: typeof registerPcRailHandlers;
}

export function registerRemoteSurfaces(
  stores: { store: RemoteHostsStore; attachments: RemoteAttachmentsStore },
  deps: RemoteRegistrationDeps = { registerRemote: registerRemoteHandlers, registerPcRail: registerPcRailHandlers },
): () => void {
  const disposeRemote = deps.registerRemote({ store: stores.store, attachments: stores.attachments });
  const disposePcRail = deps.registerPcRail({ store: stores.store, attachments: stores.attachments });
  return () => {
    disposePcRail();
    disposeRemote();
  };
}
