/**
 * Copyright (c) 2014-2020 The xterm.js authors. All rights reserved.
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 *
 * Terminal Emulation References:
 *   http://vt100.net/
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.txt
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 *   http://invisible-island.net/vttest/
 *   http://www.inwap.com/pdp10/ansicode.txt
 *   http://linux.die.net/man/4/console_codes
 *   http://linux.die.net/man/7/urxvt
 */

// wmux: interface excerpt only. browser/Types.ts needs ICoreTerminal as a
// type; the CoreTerminal class (and the parser/buffer graph it imports) is
// not part of the WebGL renderer and is not copied.

import { IFunctionIdentifier } from '@xterm/xterm';
import { IBufferSet } from './buffer/Types';
import { ICoreService, IMouseStateService, IOptionsService, IUnicodeService } from './services/Services';
import { IDisposable, IParams, ITerminalOptions } from './Types';

export interface ICoreTerminal {
  mouseStateService: IMouseStateService;
  coreService: ICoreService;
  optionsService: IOptionsService;
  unicodeService: IUnicodeService;
  buffers: IBufferSet;
  options: Required<ITerminalOptions>;
  registerCsiHandler(id: IFunctionIdentifier, callback: (params: IParams) => boolean | Promise<boolean>): IDisposable;
  registerDcsHandler(id: IFunctionIdentifier, callback: (data: string, param: IParams) => boolean | Promise<boolean>): IDisposable;
  registerEscHandler(id: IFunctionIdentifier, callback: () => boolean | Promise<boolean>): IDisposable;
  registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): IDisposable;
  registerApcHandler(id: IFunctionIdentifier, callback: (data: string) => boolean | Promise<boolean>): IDisposable;
}
