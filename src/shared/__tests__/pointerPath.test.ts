import { describe, expect, it } from 'vitest';
import {
  INNER_FRACTION,
  MAX_STEPS,
  MIN_STEPS,
  approachPath,
  clickPointInBox,
  defaultStartPoint,
  distance,
  pathPoints,
  stepsForDistance,
} from '../pointerPath';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How far along the from→to axis a point sits, as a fraction. */
function progress(
  from: { x: number; y: number },
  to: { x: number; y: number },
  point: { x: number; y: number },
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  return ((point.x - from.x) * dx + (point.y - from.y) * dy) / len2;
}

describe('stepsForDistance', () => {
  it('stays within the step band for any distance', () => {
    for (const d of [0, 1, 50, 200, 900, 5000, 100_000]) {
      const steps = stepsForDistance(d);
      expect(steps).toBeGreaterThanOrEqual(MIN_STEPS);
      expect(steps).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it('gives a long traverse more steps than a short one', () => {
    expect(stepsForDistance(600)).toBeGreaterThan(stepsForDistance(20));
  });
});

describe('pathPoints', () => {
  const from = { x: 40, y: 60 };
  const to = { x: 700, y: 420 };

  it('emits exactly the requested number of points', () => {
    expect(pathPoints(from, to, 12, seeded(1))).toHaveLength(12);
  });

  it('lands exactly on the target', () => {
    const points = pathPoints(from, to, 15, seeded(2));
    expect(points[points.length - 1]).toEqual(to);
  });

  it('advances monotonically along the from-to axis', () => {
    const points = pathPoints(from, to, 20, seeded(3));
    let previous = 0;
    for (const point of points) {
      const t = progress(from, to, point);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
    expect(previous).toBeCloseTo(1, 10);
  });

  it('leaves the straight line in between but not at the ends', () => {
    const points = pathPoints(from, to, 20, seeded(4));
    // Perpendicular offset is zero at the endpoint by construction.
    const last = points[points.length - 1];
    expect(distance(last, to)).toBe(0);
    // At least one mid-flight point is genuinely off the straight line.
    const offsets = points.slice(0, -1).map((p) => {
      const t = progress(from, to, p);
      const online = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      return distance(p, online);
    });
    expect(Math.max(...offsets)).toBeGreaterThan(0);
  });

  it('handles a zero-length move without producing NaN', () => {
    const points = pathPoints(from, from, 10, seeded(5));
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    expect(points[points.length - 1]).toEqual(from);
  });

  it('approachPath picks its own step count from the distance', () => {
    const points = approachPath(from, to, seeded(6));
    expect(points).toHaveLength(stepsForDistance(distance(from, to)));
    expect(points[points.length - 1]).toEqual(to);
  });
});

describe('clickPointInBox', () => {
  const box = { x: 100, y: 200, width: 240, height: 60 };

  it('never leaves the inner fraction of the box', () => {
    const rng = seeded(9);
    for (let i = 0; i < 5000; i++) {
      const point = clickPointInBox(box, rng);
      const spanX = (box.width * INNER_FRACTION) / 2;
      const spanY = (box.height * INNER_FRACTION) / 2;
      expect(point.x).toBeGreaterThanOrEqual(box.x + box.width / 2 - spanX);
      expect(point.x).toBeLessThanOrEqual(box.x + box.width / 2 + spanX);
      expect(point.y).toBeGreaterThanOrEqual(box.y + box.height / 2 - spanY);
      expect(point.y).toBeLessThanOrEqual(box.y + box.height / 2 + spanY);
    }
  });

  it('does not always land on the exact centre', () => {
    const rng = seeded(11);
    const centreX = box.x + box.width / 2;
    const points = Array.from({ length: 200 }, () => clickPointInBox(box, rng));
    expect(points.some((p) => p.x !== centreX)).toBe(true);
  });
});

describe('defaultStartPoint', () => {
  it('is inside the viewport and not the origin', () => {
    const point = defaultStartPoint({ width: 1000, height: 800 });
    expect(point.x).toBeGreaterThan(0);
    expect(point.y).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(1000);
    expect(point.y).toBeLessThan(800);
  });

  it('falls back to a plausible size when the viewport is unknown', () => {
    const point = defaultStartPoint();
    expect(point.x).toBeGreaterThan(0);
    expect(point.y).toBeGreaterThan(0);
  });
});
