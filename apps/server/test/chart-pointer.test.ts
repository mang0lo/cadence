import { describe, expect, it } from 'vitest';
import { pointerInElement } from '../../web/src/components/charts/pointer';

describe('pointer position in a chart while the page is zoomed', () => {
  const layout = { width: 800, height: 300 };
  it('is the plain offset without zoom', () => {
    expect(pointerInElement({ clientX: 500, clientY: 250 }, { left: 100, top: 100, width: 800, height: 300 }, layout)).toEqual({
      x: 400,
      y: 150,
    });
  });

  it('maps back to the chart’s own pixels at 150 % zoom (the chart is drawn 1.5× larger)', () => {
    // the point 400 / 150 of the chart is on screen at 100 + 400·1.5, 100 + 150·1.5
    const p = pointerInElement({ clientX: 700, clientY: 325 }, { left: 100, top: 100, width: 1200, height: 450 }, layout);
    expect(p.x).toBeCloseTo(400, 6);
    expect(p.y).toBeCloseTo(150, 6);
  });

  it('copes with a hidden (zero size) element', () => {
    expect(pointerInElement({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({
      x: 10,
      y: 10,
    });
  });
});
