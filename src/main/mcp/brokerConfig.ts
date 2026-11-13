import * as fs from 'fs';
import { getConfigPath } from '../../daemon/config';
import { stripBom } from '../../shared/stripBom';
import { parseBrokerLimits, type BrokerLimits } from '../../shared/brokerLimits';

/**
 * The broker limits in config.json (`mcp.broker`, shared/brokerLimits.ts).
 * A missing or unreadable file, or one that does not parse, sets no limit.
 */
export function readBrokerLimitsConfig(cfgPath: string = getConfigPath()): { limits: BrokerLimits; ignored: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, 'utf-8');
  } catch {
    return parseBrokerLimits(undefined);
  }
  let parsed: unknown;
  try {
    // Prototype pollution guard, as daemon/config.ts and enforcementMode.ts do.
    parsed = JSON.parse(stripBom(raw), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);
  } catch {
    return parseBrokerLimits(undefined);
  }
  const mcp = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).mcp : undefined;
  const broker = mcp && typeof mcp === 'object' ? (mcp as Record<string, unknown>).broker : undefined;
  return parseBrokerLimits(broker);
}
