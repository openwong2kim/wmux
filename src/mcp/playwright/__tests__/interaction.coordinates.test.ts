import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveWorkspaceBackend, resolveRefMock, listRefEntriesMock, touch } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
  resolveRefMock: vi.fn(),
  listRefEntriesMock: vi.fn(),
  touch: { active: false, drag: vi.fn() },
}));

vi.mock('../touch-input', () => ({
  hasTouchEmulation: () => touch.active,
  touchTapFor: () => undefined,
  touchDragFor: () => (touch.active ? touch.drag : undefined),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend }),
  },
}));

vi.mock('../snapshot', () => ({ resolveRef: resolveRefMock, listRefEntries: listRefEntriesMock, generateSnapshot: vi.fn(), generateScopedSnapshot: vi.fn(), markDomRefsActive: vi.fn() }));

import { registerInteractionTools } from '../tools/interaction';
import { registerInspectionTools } from '../tools/inspection';

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collect(register: (s: never, d: never) => void): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  register(server as never, deps as never);
  return tools;
}

const interaction = collect(registerInteractionTools);
const click = interaction.get('browser_click');
const drag = interaction.get('browser_drag');
const scroll = interaction.get('browser_scroll');
const screenshot = collect(registerInspectionTools).get('browser_screenshot');
if (!click || !drag || !scroll || !screenshot) throw new Error('tools failed to register');

type Handler = (arg: unknown) => void;

function makePage(
  opts: {
    viewport?: { width: number; height: number } | null;
    popupUrl?: string;
    /** What window.innerWidth/innerHeight reports, or 'throws'. */
    innerSize?: [number, number] | 'throws';
    /** Whether the refs table's size-and-scroll read throws. */
    pageSizeThrows?: boolean;
  } = {},
) {
  const handlers = new Map<string, Set<Handler>>();
  const order: string[] = [];
  /** Mouse and keyboard input, in the order the page received it. */
  const input: string[] = [];
  const mouseClick = vi.fn(async (cx: number, cy: number) => {
    input.push(`click ${cx},${cy}`);
    if (opts.popupUrl !== undefined) {
      for (const fn of handlers.get('popup') ?? []) fn({ url: () => opts.popupUrl });
    }
  });
  const mouseMove = vi.fn(async (mx: number, my: number) => { input.push(`move ${mx},${my}`); });
  return {
    mouseClick,
    mouseMove,
    input,
    order,
    listenerCount: () => handlers.get('popup')?.size ?? 0,
    page: {
      on: (event: string, fn: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        set.add(fn);
        handlers.set(event, set);
      },
      off: (event: string, fn: Handler) => handlers.get(event)?.delete(fn),
      locator: vi.fn(),
      mouse: {
        click: mouseClick,
        move: mouseMove,
        down: vi.fn(async () => { input.push('down'); }),
        up: vi.fn(async () => { input.push('up'); }),
        wheel: vi.fn(async (dx: number, dy: number) => { input.push(`wheel ${dx},${dy}`); }),
      },
      keyboard: {
        down: vi.fn(async (key: string) => { input.push(`keydown ${key}`); }),
        up: vi.fn(async (key: string) => { input.push(`keyup ${key}`); }),
      },
      viewportSize: () => (opts.viewport === undefined ? { width: 1280, height: 800 } : opts.viewport),
      evaluate: vi.fn(async (expr: string | ((...a: unknown[]) => unknown)) => {
        order.push('evaluate');
        if (expr === 'window.devicePixelRatio') return 2;
        if (expr === '[window.innerWidth, window.innerHeight]') {
          if (opts.innerSize === 'throws') throw new Error('Execution context was destroyed');
          return opts.innerSize ?? [1024, 768];
        }
        if (typeof expr === 'string' && expr.startsWith('[window.innerWidth, window.innerHeight, window.scrollX')) {
          if (opts.pageSizeThrows) throw new Error('Execution context was destroyed');
          return [1280, 800, 0, 300, 1280, 4000];
        }
        return undefined;
      }),
      screenshot: vi.fn(async () => {
        order.push('screenshot');
        return Buffer.from('png');
      }),
    },
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ data: 'BASE64' });
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  resolveRefMock.mockReset();
  listRefEntriesMock.mockReset();
  listRefEntriesMock.mockReturnValue([]);
  touch.active = false;
  touch.drag.mockReset();
});

/** A resolved element with a fixed box and nothing else. */
function boxed(box: { x: number; y: number; width: number; height: number }) {
  return { boundingBox: async () => box, dispose: async () => undefined };
}

describe('browser_click coordinates', () => {
  it('clicks at viewport CSS pixels through the mouse API', async () => {
    const { page, mouseClick } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: 120, y: 340 });

    expect(result.isError).toBeUndefined();
    expect(mouseClick).toHaveBeenCalledWith(120, 340, {});
    expect(result.content[0].text).toContain('viewport CSS px (120, 340)');
  });

  it('double-clicks at a coordinate when asked', async () => {
    const { page, mouseClick } = makePage();
    getPage.mockResolvedValue(page);

    await click({ x: 5, y: 6, double: true });
    expect(mouseClick).toHaveBeenCalledWith(5, 6, { clickCount: 2 });
  });

  it('refuses a call that carries both a ref and coordinates', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ ref: '3', x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
  });

  it('refuses half a coordinate pair', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('both x and y');
  });

  it('says the RPC lane cannot do coordinate clicks', async () => {
    getPage.mockResolvedValue(null);

    const result = await click({ x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('chrome backend');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.click.cdp', expect.anything());
  });

  it('[fix] carries the underlying page failure into that message', async () => {
    getPage.mockRejectedValue(new Error('Target page, context or browser has been closed'));

    const result = await click({ x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('browser has been closed');
  });

  it('[fix] refuses a negative coordinate', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: -5, y: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('inside the viewport');
  });

  it('[fix] refuses a coordinate outside the viewport instead of faking success', async () => {
    const { page, mouseClick } = makePage({ viewport: { width: 800, height: 600 } });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 900, y: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('800x600 viewport');
    expect(mouseClick).not.toHaveBeenCalled();
  });

  it('[fix] falls back to the page\'s own innerWidth/innerHeight when viewportSize() is null', async () => {
    // Every chrome-backend page is connectOverCDP, where viewportSize() is null.
    const { page, mouseClick } = makePage({ viewport: null, innerSize: [1024, 768] });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 2000, y: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1024x768 viewport');
    expect(mouseClick).not.toHaveBeenCalled();
  });

  it('[fix] clicks inside the bounds that fallback reports', async () => {
    const { page, mouseClick } = makePage({ viewport: null, innerSize: [1024, 768] });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 500, y: 400 });
    expect(result.isError).toBeUndefined();
    expect(mouseClick).toHaveBeenCalledWith(500, 400, {});
  });

  it('[fix] still clicks when neither viewportSize nor the page can report a size', async () => {
    const { page, mouseClick } = makePage({ viewport: null, innerSize: 'throws' });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 900, y: 100 });
    expect(result.isError).toBeUndefined();
    expect(mouseClick).toHaveBeenCalled();
  });

  it('[fix] reports a popup opened by a coordinate click, and detaches the listener', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/from-coords' });
    getPage.mockResolvedValue(watched.page);

    const result = await click({ x: 10, y: 20 });
    expect(result.content[0].text).toContain('opened a popup (page: https://popup.example/from-coords)');
    expect(watched.listenerCount()).toBe(0);
  });
});

describe('browser_screenshot coordinate basis', () => {
  it('states the devicePixelRatio divisor for a viewport capture', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await screenshot({});
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(result.content[0].type).toBe('image');
    expect(note).toContain('devicePixelRatio 2');
    expect(note).toContain('image pixels / 2');
  });

  it('[fix] reads the devicePixelRatio before taking the shot', async () => {
    const watched = makePage();
    getPage.mockResolvedValue(watched.page);

    await screenshot({});
    expect(watched.order).toEqual(['evaluate', 'screenshot']);
  });

  it('[fix] tells the RPC lane that coordinate clicks are unsupported', async () => {
    getPage.mockResolvedValue(null);

    const result = await screenshot({});
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('does not support coordinate clicks');
    expect(note).not.toContain('devicePixelRatio');
  });

  it('marks a fullPage capture as unusable for coordinate clicks', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await screenshot({ fullPage: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(note).toContain('DOCUMENT coordinates');
    expect(note).toContain('NOT usable for browser_click x/y');
  });

  it('marks an element capture as element-relative', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);
    resolveRefMock.mockResolvedValue({ screenshot: async () => Buffer.from('png') });

    const result = await screenshot({ ref: '3' });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(note).toContain('ELEMENT-relative');
    expect(note).toContain('NOT usable');
  });
});

describe('browser_drag path', () => {
  const PATH = [{ x: 100, y: 100 }, { x: 300, y: 120 }, { x: 320, y: 400 }];

  it('presses at the first point, walks every leg with the pointer geometry, and releases at the last', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);

    const result = await drag({ path: PATH });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Dragged through 3 points from viewport CSS px (100, 100) to (320, 400)');
    const down = input.indexOf('down');
    expect(input[down - 1]).toBe('move 100,100');
    // Every waypoint is visited exactly, with intermediate points between them.
    expect(input).toContain('move 300,120');
    expect(input[input.length - 2]).toBe('move 320,400');
    expect(input[input.length - 1]).toBe('up');
    expect(input.length - down).toBeGreaterThan(2 * 8);
  });

  it('keeps every pressed leg on the straight line between the agent\'s waypoints', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);

    await drag({ path: PATH });

    const pressed = input
      .slice(input.indexOf('down') + 1, input.indexOf('up'))
      .map((entry) => entry.slice('move '.length).split(',').map(Number));
    let leg = 0;
    for (const [px, py] of pressed) {
      const a = PATH[leg];
      const b = PATH[leg + 1];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
      if (px === b.x && py === b.y) leg++;
    }
    expect(leg).toBe(PATH.length - 1);
  });

  it('refuses a point outside the viewport before pressing anything', async () => {
    const { page, input } = makePage({ viewport: null, innerSize: [1024, 768] });
    getPage.mockResolvedValue(page);

    const result = await drag({ path: [{ x: 10, y: 10 }, { x: 2000, y: 10 }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1024x768 viewport');
    expect(input).toEqual([]);
  });

  it('refuses refs and a path together', async () => {
    const result = await drag({ sourceRef: '1', targetRef: '2', path: PATH });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
  });

  it('refuses a ref drag with only one ref', async () => {
    const result = await drag({ sourceRef: '1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('needs both sourceRef and targetRef');
  });

  it('refuses a path outside 2..50 points', async () => {
    expect((await drag({ path: [{ x: 1, y: 1 }] })).content[0].text).toContain('2 to 50');
    const long = Array.from({ length: 51 }, (_, i) => ({ x: i, y: i }));
    expect((await drag({ path: long })).content[0].text).toContain('2 to 50');
  });

  it('is refused on the RPC lane with the coordinate-click wording', async () => {
    getPage.mockResolvedValue(null);

    const result = await drag({ path: PATH });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Path drags need a live browser page');
    expect(result.content[0].text).toContain('chrome backend');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.drag.cdp', expect.anything(), expect.anything());
  });

  it('is refused under a touchscreen preset', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    touch.active = true;

    const result = await drag({ path: PATH });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('mouse-only');
    expect(input).toEqual([]);
    expect(touch.drag).not.toHaveBeenCalled();
  });
});

describe('browser_drag by ref', () => {
  it('uses the pointer geometry instead of a straight 10-step move', async () => {
    const { page, input, mouseMove } = makePage();
    getPage.mockResolvedValue(page);
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) =>
      boxed(ref === '1' ? { x: 90, y: 90, width: 20, height: 20 } : { x: 490, y: 290, width: 20, height: 20 }),
    );

    const result = await drag({ sourceRef: '1', targetRef: '2' });

    expect(result.content[0].text).toBe('Dragged element ref=1 to ref=2');
    // Never Playwright's own interpolation, which is a perfectly straight line.
    for (const call of mouseMove.mock.calls) expect(call).toHaveLength(2);
    const down = input.indexOf('down');
    expect(input[down - 1]).toBe('move 100,100');
    expect(input[input.length - 2]).toBe('move 500,300');
    expect(input.length - down - 2).toBeGreaterThanOrEqual(8);
  });

  it('keeps the touch drag between the two centres under a touchscreen preset', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    touch.active = true;
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) =>
      boxed(ref === '1' ? { x: 0, y: 0, width: 10, height: 10 } : { x: 100, y: 0, width: 10, height: 10 }),
    );

    const result = await drag({ sourceRef: '1', targetRef: '2' });
    expect(result.content[0].text).toContain('(touch drag)');
    expect(touch.drag).toHaveBeenCalledWith({ x: 5, y: 5 }, { x: 105, y: 5 });
    expect(input).toEqual([]);
  });
});

describe('browser_scroll wheel at a point', () => {
  it('walks the pointer to the point and sends a real wheel event there', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);

    const result = await scroll({ direction: 'down', amount: 240, x: 600, y: 350 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Scrolled down by 240px with the wheel at viewport CSS px (600, 350)');
    expect(input.slice(-2)).toEqual(['move 600,350', 'wheel 0,240']);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('is refused under a touchscreen preset', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    touch.active = true;

    const result = await scroll({ direction: 'down', x: 10, y: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('mouse-only');
    expect(input).toEqual([]);
  });

  it('refuses x without y', async () => {
    const result = await scroll({ direction: 'down', x: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('needs both x and y');
  });

  it('refuses a point outside the viewport', async () => {
    const { page, input } = makePage({ viewport: { width: 800, height: 600 } });
    getPage.mockResolvedValue(page);

    const result = await scroll({ direction: 'up', x: 10, y: 700 });
    expect(result.content[0].text).toContain('800x600 viewport');
    expect(input).toEqual([]);
  });

  it('is refused on the RPC lane with the coordinate-click wording', async () => {
    getPage.mockResolvedValue(null);

    const result = await scroll({ direction: 'down', x: 10, y: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('chrome backend');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.evaluate', expect.anything(), expect.anything());
  });

  it('without x/y still scrolls with scrollBy and sends no pointer input', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);

    const result = await scroll({ direction: 'down', amount: 100 });
    expect(result.content[0].text).toBe('Scrolled down by 100px');
    expect(page.evaluate).toHaveBeenCalled();
    expect(input).toEqual([]);
  });
});

describe('modifier keys', () => {
  it('holds the keys around a coordinate click and releases them after', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: 50, y: 60, modifiers: ['Control', 'Shift', 'Control'] });

    expect(result.content[0].text).toBe('Clicked at viewport CSS px (50, 60) with Control+Shift held');
    expect(input).toEqual(['keydown Control', 'keydown Shift', 'click 50,60', 'keyup Shift', 'keyup Control']);
  });

  it('releases every key that went down when the gesture throws', async () => {
    const { page, input, mouseClick } = makePage();
    getPage.mockResolvedValue(page);
    mouseClick.mockRejectedValueOnce(new Error('Target closed'));

    const result = await click({ x: 50, y: 60, modifiers: ['Meta'] });

    expect(result.isError).toBe(true);
    expect(input).toEqual(['keydown Meta', 'keyup Meta']);
  });

  it('reports a release that failed after a successful gesture, still releasing the other keys', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    page.keyboard.up.mockImplementationOnce(async () => { throw new Error('Shift release failed'); });

    const result = await click({ x: 50, y: 60, modifiers: ['Control', 'Shift'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Shift release failed');
    expect(input).toEqual(['keydown Control', 'keydown Shift', 'click 50,60', 'keyup Control']);
  });

  it('keeps the gesture\'s own error when a release fails on top of it', async () => {
    const { page, mouseClick } = makePage();
    getPage.mockResolvedValue(page);
    mouseClick.mockRejectedValueOnce(new Error('Target closed'));
    page.keyboard.up.mockImplementationOnce(async () => { throw new Error('release failed'); });

    const result = await click({ x: 50, y: 60, modifiers: ['Meta'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Target closed');
    expect(result.content[0].text).not.toContain('release failed');
  });

  it('releases the keys when a held drag throws mid-path, and the mouse button too', async () => {
    const { page, input, mouseMove } = makePage();
    getPage.mockResolvedValue(page);
    let moves = 0;
    mouseMove.mockImplementation(async () => {
      moves++;
      input.push('move');
      if (moves === 20) throw new Error('Execution context was destroyed');
    });

    const result = await drag({ path: [{ x: 10, y: 10 }, { x: 700, y: 500 }], modifiers: ['Alt'] });

    expect(result.isError).toBe(true);
    expect(input[0]).toBe('keydown Alt');
    expect(input.slice(-2)).toEqual(['up', 'keyup Alt']);
  });

  it('holds the keys around a ref drag', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    resolveRefMock.mockResolvedValue(boxed({ x: 10, y: 10, width: 10, height: 10 }));

    const result = await drag({ sourceRef: '1', targetRef: '2', modifiers: ['Shift'] });
    expect(result.content[0].text).toBe('Dragged element ref=1 to ref=2 with Shift held');
    expect(input[0]).toBe('keydown Shift');
    expect(input[input.length - 1]).toBe('keyup Shift');
  });

  it('are refused on the RPC lane with the coordinate-click wording', async () => {
    getPage.mockResolvedValue(null);

    const onClick = await click({ ref: '3', modifiers: ['Shift'] });
    expect(onClick.isError).toBe(true);
    expect(onClick.content[0].text).toContain('Modifier keys need a live browser page');
    expect(onClick.content[0].text).toContain('chrome backend');
    const onDrag = await drag({ sourceRef: '1', targetRef: '2', modifiers: ['Alt'] });
    expect(onDrag.content[0].text).toContain('Modifier keys need a live browser page');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.click.cdp', expect.anything(), expect.anything());
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.drag.cdp', expect.anything(), expect.anything());
  });

  it('are refused under a touchscreen preset', async () => {
    const { page, input } = makePage();
    getPage.mockResolvedValue(page);
    touch.active = true;
    resolveRefMock.mockResolvedValue(boxed({ x: 10, y: 10, width: 10, height: 10 }));

    const onClick = await click({ x: 5, y: 5, modifiers: ['Control'] });
    expect(onClick.isError).toBe(true);
    expect(onClick.content[0].text).toContain('touchscreen');
    const onDrag = await drag({ sourceRef: '1', targetRef: '2', modifiers: ['Control'] });
    expect(onDrag.content[0].text).toContain('touchscreen');
    expect(input).toEqual([]);
    expect(touch.drag).not.toHaveBeenCalled();
  });
});

describe('browser_screenshot refs', () => {
  const ENTRIES = [
    { ref: 12, role: 'button', name: 'Log in' },
    { ref: 13, role: 'link', name: 'Far below' },
  ];

  it('appends a table of refs measured after the capture, without writing into the page', async () => {
    const watched = makePage();
    getPage.mockResolvedValue(watched.page);
    listRefEntriesMock.mockReturnValue(ENTRIES);
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) => {
      watched.order.push(`measure ${ref}`);
      return boxed(ref === '12' ? { x: 40.4, y: 20, width: 80, height: 30 } : { x: 0, y: 5000, width: 10, height: 10 });
    });

    const result = await screenshot({ refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(note).toContain('devicePixelRatio 2');
    expect(note).toContain('Refs in this capture (viewport CSS px: x,y,w,h):\nref=12 button "Log in" 40,20,80,30');
    expect(note).not.toContain('ref=13');
    expect(note).toContain('1 outside the capture');
    // Measured after the shot, and every page evaluation is a read.
    expect(watched.order.indexOf('screenshot')).toBeLessThan(watched.order.indexOf('measure 12'));
    for (const [expr] of watched.page.evaluate.mock.calls) {
      expect(String(expr)).toMatch(/^(window\.devicePixelRatio|\[window\.)/);
    }
  });

  it('prints fullPage rows in document coordinates', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);
    listRefEntriesMock.mockReturnValue(ENTRIES);
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) =>
      boxed(ref === '12' ? { x: 40, y: 20, width: 80, height: 30 } : { x: 0, y: 3500, width: 10, height: 10 }),
    );

    const result = await screenshot({ fullPage: true, refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    // scrollY 300 is added; the document is 4000 px tall, so ref 13 is in it.
    expect(note).toContain('ref=12 button "Log in" 40,320,80,30');
    expect(note).toContain('ref=13 link "Far below" 0,3800,10,10');
  });

  it('says to snapshot first when the page has no refs', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await screenshot({ refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('call browser_snapshot');
  });

  it('adds nothing when refs is not asked for', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);
    listRefEntriesMock.mockReturnValue(ENTRIES);

    const result = await screenshot({});
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).not.toContain('Refs in this capture');
    expect(listRefEntriesMock).not.toHaveBeenCalled();
  });

  it('notes that the RPC lane cannot measure boxes', async () => {
    resolveWorkspaceBackend.mockResolvedValue('builtin');
    getPage.mockResolvedValue(null);

    const result = await screenshot({ refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('refs:true needs the chrome backend');
  });

  it('does not blame the backend when the chrome backend gave no page', async () => {
    getPage.mockResolvedValue(null);

    const result = await screenshot({ refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('the chrome backend did not provide one');
    expect(note).not.toContain('needs the chrome backend');
  });

  it('lists boxes unfiltered, and says so, when the viewport size cannot be read', async () => {
    const { page } = makePage({ viewport: null, pageSizeThrows: true });
    getPage.mockResolvedValue(page);
    listRefEntriesMock.mockReturnValue(ENTRIES);
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) =>
      boxed(ref === '12' ? { x: 40, y: 20, width: 80, height: 30 } : { x: 0, y: 5000, width: 10, height: 10 }),
    );

    const result = await screenshot({ refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('viewport size could not be read');
    expect(note).toContain('ref=12 button "Log in" 40,20,80,30');
    expect(note).toContain('ref=13 link "Far below" 0,5000,10,10');
  });

  it('omits a fullPage table rather than mislabel viewport coordinates as document ones', async () => {
    const { page } = makePage({ pageSizeThrows: true });
    getPage.mockResolvedValue(page);
    listRefEntriesMock.mockReturnValue(ENTRIES);
    resolveRefMock.mockResolvedValue(boxed({ x: 40, y: 20, width: 80, height: 30 }));

    const result = await screenshot({ fullPage: true, refs: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('Ref boxes omitted');
    expect(note).not.toContain('ref=12');
  });
});
