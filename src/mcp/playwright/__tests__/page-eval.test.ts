import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  pageEvaluator,
  rpcEvaluator,
  resolveEvaluator,
  evalFunctionOrRpc,
} from '../page-eval';

// Mock the RPC transport. Path is relative to THIS test file:
// __tests__/ -> playwright/ -> mcp/, so ../../wmux-client === src/mcp/wmux-client.
vi.mock('../../wmux-client', () => ({
  sendRpc: vi.fn(),
}));

import { sendRpc } from '../../wmux-client';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

describe('page-eval', () => {
  beforeEach(() => {
    mockSendRpc.mockReset();
  });

  describe('pageEvaluator', () => {
    it('delegates the expression to page.evaluate', async () => {
      const page = { evaluate: vi.fn().mockResolvedValue('result') };
      const evaluate = pageEvaluator(page as never);
      const out = await evaluate('1 + 1');
      expect(page.evaluate).toHaveBeenCalledWith('1 + 1');
      expect(out).toBe('result');
    });
  });

  describe('rpcEvaluator', () => {
    it('calls browser.evaluate and unwraps .value', async () => {
      mockSendRpc.mockResolvedValue({ value: 42 });
      const evaluate = rpcEvaluator('surface-1');
      const out = await evaluate('expr');
      expect(mockSendRpc).toHaveBeenCalledWith('browser.evaluate', {
        expression: 'expr',
        surfaceId: 'surface-1',
      });
      expect(out).toBe(42);
    });

    it('omits surfaceId when not provided', async () => {
      mockSendRpc.mockResolvedValue({ value: null });
      const evaluate = rpcEvaluator();
      await evaluate('expr');
      expect(mockSendRpc).toHaveBeenCalledWith('browser.evaluate', {
        expression: 'expr',
      });
    });
  });

  describe('resolveEvaluator', () => {
    it('returns a page-backed evaluator when getPage resolves a page', async () => {
      const page = { evaluate: vi.fn().mockResolvedValue('via-page') };
      const engine = { getPage: vi.fn().mockResolvedValue(page) };
      const evaluate = await resolveEvaluator(engine as never, 's');
      const out = await evaluate('x');
      expect(page.evaluate).toHaveBeenCalledWith('x');
      expect(out).toBe('via-page');
      expect(mockSendRpc).not.toHaveBeenCalled();
    });

    it('returns an RPC-backed evaluator when getPage resolves null', async () => {
      mockSendRpc.mockResolvedValue({ value: 'via-rpc' });
      const engine = { getPage: vi.fn().mockResolvedValue(null) };
      const evaluate = await resolveEvaluator(engine as never, 's');
      const out = await evaluate('x');
      expect(mockSendRpc).toHaveBeenCalledWith('browser.evaluate', {
        expression: 'x',
        surfaceId: 's',
      });
      expect(out).toBe('via-rpc');
    });

    it('falls back to RPC when getPage rejects', async () => {
      mockSendRpc.mockResolvedValue({ value: 'via-rpc' });
      const engine = { getPage: vi.fn().mockRejectedValue(new Error('boom')) };
      const evaluate = await resolveEvaluator(engine as never);
      const out = await evaluate('x');
      expect(out).toBe('via-rpc');
    });
  });

  describe('evalFunctionOrRpc', () => {
    const fn = ({ n }: { n: number }) => n * 2;

    it('runs the function natively on the page when one exists', async () => {
      const page = { evaluate: vi.fn().mockResolvedValue(20) };
      const out = await evalFunctionOrRpc(page as never, fn, { n: 10 }, 's');
      // native page.evaluate(fn, arg) — dev path unchanged
      expect(page.evaluate).toHaveBeenCalledTimes(1);
      expect(page.evaluate.mock.calls[0][1]).toEqual({ n: 10 });
      expect(out).toBe(20);
      expect(mockSendRpc).not.toHaveBeenCalled();
    });

    it('stringifies the function for RPC when no page exists', async () => {
      mockSendRpc.mockResolvedValue({ value: 20 });
      const out = await evalFunctionOrRpc(null, fn, { n: 10 }, 's');
      expect(mockSendRpc).toHaveBeenCalledTimes(1);
      const [method, params] = mockSendRpc.mock.calls[0];
      expect(method).toBe('browser.evaluate');
      // expression = (fn.toString())(JSON.stringify(arg))
      expect(params.expression).toContain('n * 2');
      expect(params.expression).toContain('{"n":10}');
      expect(params.surfaceId).toBe('s');
      expect(out).toBe(20);
    });

    it('embeds arg via JSON.stringify (no code injection from values)', async () => {
      mockSendRpc.mockResolvedValue({ value: [] });
      const evilFn = ({ fieldNames }: { fieldNames: string[] }) => fieldNames;
      await evalFunctionOrRpc(
        null,
        evilFn,
        { fieldNames: ['"); globalThis.hacked = 1; ("'] },
        undefined,
      );
      const expr = mockSendRpc.mock.calls[0][1].expression as string;
      // The dangerous payload is a JSON string literal, never bare code.
      expect(expr).toContain('globalThis.hacked = 1');
      expect(expr).toContain('\\"); globalThis.hacked = 1; (\\"');
    });
  });
});
