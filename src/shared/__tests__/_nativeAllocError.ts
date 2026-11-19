import { NATIVE_ALLOC_FAILED_CODE } from '../nativeTerminalCore';

/**
 * An error shaped as the native core throws a refused allocation (#3440):
 * `code === 'ALLOC_FAILED'`, which is what classifies it. The message is
 * diagnostic only and may be empty.
 */
export function nativeAllocError(message = 'ALLOC_FAILED: could not allocate 8 bytes for a test'): Error {
  return Object.assign(new Error(message), { code: NATIVE_ALLOC_FAILED_CODE });
}
