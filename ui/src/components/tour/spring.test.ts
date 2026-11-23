// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { springStep, type Spring } from './tour';

const run = (from: number, goal: number, frames: number, dt = 1 / 60) => {
  const xs: number[] = [];
  let s: Spring = { x: from, v: 0 };
  for (let i = 0; i < frames; i++) xs.push((s = springStep(s, goal, dt)).x);
  return xs;
};

describe('tour spring', () => {
  it('starts gently, never overshoots and settles within ~0.4 s', () => {
    const xs = run(0, 600, 40);
    const steps = xs.map((x, i) => x - (i ? xs[i - 1] : 0));
    expect(steps[0]).toBeLessThan(steps[3]); // accelerates from rest
    expect(Math.max(...steps)).toBeLessThan(80); // no big per-frame jump at 60 fps
    expect(xs.every((x, i) => x <= 600 && (i === 0 || x >= xs[i - 1]))).toBe(true); // monotonic, no overshoot
    expect(xs.findIndex((x) => x === 600)).toBeLessThanOrEqual(26); // snapped onto the goal
  });

  it('stays stable with long frames (background tab, slow device)', () => {
    const xs = run(0, 300, 30, 0.2);
    expect(xs.every((x) => x <= 300 && Number.isFinite(x))).toBe(true);
    expect(xs.at(-1)).toBe(300);
  });

  it('retargets without jerking: velocity carries over', () => {
    let s: Spring = { x: 0, v: 0 };
    for (let i = 0; i < 6; i++) s = springStep(s, 500, 1 / 60);
    const before = s.v;
    s = springStep(s, 100, 1 / 60);
    expect(s.v).toBeGreaterThan(0); // still moving the same way for a moment
    expect(s.v).toBeLessThan(before);
  });
});
