/**
 * Observable values of the replay (apps/web/src/features/activities/lib/store.ts): the throttle behind
 * useThrottledStore, which drives the clock and the live values of the replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, throttledSubscribe } from '@/features/activities/lib/store';

describe('store: throttled notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies right away, then at most once per period and always for the last change', () => {
    const s = new Store(0);
    const notify = vi.fn();
    throttledSubscribe(s, 100, notify);
    s.set(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // a frame every 16 ms: coalesced into one notification when the period is over
    for (let i = 2; i <= 5; i++) {
      vi.advanceTimersByTime(16);
      s.set(i);
    }
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100 - 4 * 16);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(s.get()).toBe(5);
    // quiet afterwards: no more notifications
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(2);
    // and the next change after the quiet period is reported at once
    s.set(6);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('stops notifying after unsubscribing, also for a pending change', () => {
    const s = new Store(0);
    const notify = vi.fn();
    const off = throttledSubscribe(s, 100, notify);
    s.set(1);
    s.set(2); // pending
    off();
    vi.advanceTimersByTime(500);
    s.set(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps separate throttles per subscription (a new store starts fresh)', () => {
    const a = new Store(0);
    const b = new Store(0);
    const na = vi.fn();
    const nb = vi.fn();
    throttledSubscribe(a, 100, na);
    throttledSubscribe(b, 100, nb);
    a.set(1);
    b.set(1);
    expect(na).toHaveBeenCalledTimes(1);
    expect(nb).toHaveBeenCalledTimes(1);
  });
});
