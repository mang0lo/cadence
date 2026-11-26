/**
 * Heatmap time-lapse position outside React state (apps/web/src/features/maps/lib/timelapse.ts): the page re-rendered
 * on every animation frame; the caption and scrubber now follow the position throttled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, useThrottledStore } from '@/features/maps/lib/timelapse';
import { renderHook } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).fakeReact);

describe('time-lapse caption', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-renders at most every 100 ms while the position changes every frame, and ends on the last position', () => {
    const position = new Store(0);
    const shown: number[] = [];
    const h = renderHook(() => {
      shown.push(useThrottledStore(position, 100));
    }, {});
    for (let frame = 1; frame <= 60; frame++) {
      vi.advanceTimersByTime(1000 / 60);
      position.set(frame / 10);
    }
    vi.advanceTimersByTime(100);
    // one second of frames: the first render, then at most one per 100 ms (instead of 60)
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThanOrEqual(12);
    expect(shown.at(-1)).toBe(6);
    h.unmount();
    position.set(7);
    vi.advanceTimersByTime(200);
    expect(shown.at(-1)).toBe(6); // unsubscribed
  });

  it('shows a change at once after a quiet moment (a click on restart while paused)', () => {
    const position = new Store(5);
    const shown: number[] = [];
    renderHook(() => {
      shown.push(useThrottledStore(position, 100));
    }, {});
    vi.advanceTimersByTime(1000);
    position.set(0);
    expect(shown).toEqual([5, 0]);
  });
});
