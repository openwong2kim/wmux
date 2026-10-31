// parseHelperLine as v4.13.0 shipped it (src/shared/computer/protocol.ts at
// that tag), kept so the skew test can show a released main still reads what
// this helper writes. Do not update it with the live parser.

import { isComputerErrorCode } from '../../errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHelperLineV4130(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not an object' };

  if (value.type === 'hello') {
    const caps = value.capabilities;
    if (
      typeof value.protocolVersion !== 'number' ||
      (value.os !== 'win32' && value.os !== 'darwin') ||
      typeof value.helperVersion !== 'string' ||
      !isRecord(caps) ||
      !Array.isArray(caps.actions) ||
      !Array.isArray(caps.modes) ||
      !isRecord(caps.permissions)
    ) {
      return { kind: 'invalid', reason: 'malformed hello' };
    }
    return { kind: 'hello', hello: value };
  }

  if (typeof value.id !== 'number' || !Number.isInteger(value.id)) {
    return { kind: 'invalid', reason: 'missing id' };
  }
  if (value.ok === true) {
    return { kind: 'response', response: { id: value.id, ok: true, result: value.result } };
  }
  if (value.ok === false && isRecord(value.error)) {
    const { code, message } = value.error;
    return {
      kind: 'response',
      response: {
        id: value.id,
        ok: false,
        error: {
          code: isComputerErrorCode(code) ? code : 'internal',
          message: typeof message === 'string' ? message : 'helper error',
        },
      },
    };
  }
  return { kind: 'invalid', reason: 'missing ok' };
}
