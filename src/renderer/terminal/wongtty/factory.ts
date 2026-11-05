// The wongtty package bundled into one function. vite.renderer.config.ts
// (wongttyFactory) builds this module's body: each call evaluates the package
// afresh, with its own WebAssembly instances, so dropping what a call returned
// frees all of it (see load.ts). Built any other way (a test), it only throws.

import type * as WongttyModule from 'wongtty/xterm';

export function createWongtty(): typeof WongttyModule {
  throw new Error('wongtty: createWongtty is built by vite.renderer.config.ts');
}
