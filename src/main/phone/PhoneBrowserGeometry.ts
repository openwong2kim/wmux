import type { RpcResponse } from '../../shared/rpc';

export interface PhoneBrowserGeometry {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

/** Fixed probe only; expressions and CDP parameters never come from the phone. */
export const PHONE_BROWSER_GEOMETRY = '({width:innerWidth,height:innerHeight,scrollX,scrollY,scale:visualViewport?.scale ?? 1})';

export function phoneBrowserGeometry(response: RpcResponse): PhoneBrowserGeometry {
  if (!response.ok) throw new Error('Browser geometry unavailable');
  const value = (response.result as {value?:unknown} | undefined)?.value;
  if (!value || typeof value !== 'object') throw new Error('Browser geometry unavailable');
  const v = value as Record<string,unknown>;
  if (v.scale !== 1 || !validDimension(v.width) || !validDimension(v.height) ||
      typeof v.scrollX !== 'number' || !Number.isFinite(v.scrollX) ||
      typeof v.scrollY !== 'number' || !Number.isFinite(v.scrollY)) throw new Error('Unsupported browser geometry');
  return {width:v.width,height:v.height,scrollX:v.scrollX,scrollY:v.scrollY};
}

function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 32768;
}

export function phoneBrowserPoint(x: unknown, y: unknown, expected: unknown, current: PhoneBrowserGeometry): {x:number;y:number} {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= 1 ||
      typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= 1 ||
      !expected || typeof expected !== 'object') throw new Error('Invalid browser point');
  const previous = expected as Record<string,unknown>;
  for (const field of ['width','height','scrollX','scrollY'] as const) {
    if (previous[field] !== current[field]) throw new Error('Browser viewport changed; refresh before input');
  }
  return {x:x * current.width,y:y * current.height};
}
