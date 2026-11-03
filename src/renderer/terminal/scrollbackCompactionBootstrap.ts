// Turns experimental scrollback compaction on from the renderer entry, without
// a call in useTerminal: while `terminalCompactScrollback` is off nothing is
// installed. When it is (or becomes) true, the BufferLine patch goes on
// through a throwaway terminal that is never opened, and Terminal.prototype
// open/dispose are wrapped so every terminal opened from then on gets its
// idle sweep and loses it at disposal. Terminals already open when the flag
// turns on are left alone. Turning the flag off stops every sweep; rows
// already packed stay valid and unpack when read.

import { Terminal } from '@xterm/xterm';
import { useStore } from '../stores';
import {
  attachScrollbackCompaction,
  detachScrollbackCompaction,
  installScrollbackCompactionFor,
  type CompactableTerminal,
} from './scrollbackCompaction';

let hooked = false;

const isEnabled = (): boolean => useStore.getState().terminalCompactScrollback;

function hookTerminalLifecycle(): void {
  if (hooked || !installScrollbackCompactionFor(Terminal)) return;
  hooked = true;
  const proto = Terminal.prototype;
  const open = proto.open;
  const dispose = proto.dispose;
  proto.open = function (this: Terminal, parent: HTMLElement): void {
    open.call(this, parent);
    if (isEnabled()) attachScrollbackCompaction(this as unknown as CompactableTerminal, isEnabled);
  };
  proto.dispose = function (this: Terminal): void {
    detachScrollbackCompaction(this);
    dispose.call(this);
  };
}

/** Call once from the renderer entry, before the first terminal mounts. */
export function installScrollbackCompactionOnFlag(): void {
  if (isEnabled()) hookTerminalLifecycle();
  useStore.subscribe((state, prev) => {
    if (state.terminalCompactScrollback && !prev.terminalCompactScrollback) hookTerminalLifecycle();
  });
}
