import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotStore,
  snapshotKey,
  type Rendered,
  type SnapshotBackend,
  type SnapshotRequest,
} from '@/components/map/snapshot';

/** A preview request; the width makes the key (as while a window is resized). */
const req = (width: number): SnapshotRequest => ({
  base: 'light',
  width,
  height: 100,
  pixelRatio: 2,
  view: { cx: 0.5, cy: 0.3, scale: 4096 },
});

/** Backend whose renders finish when the test says so; images are named after the width they were rendered for. */
function fakeBackend(cached: Record<string, Blob> = {}) {
  const rendered: number[] = [];
  const revoked: string[] = [];
  const pending: (() => void)[] = [];
  const backend: SnapshotBackend = {
    get: async (key) => cached[key] ?? null,
    render: (r) =>
      new Promise<Rendered>((resolve) => {
        rendered.push(r.width);
        pending.push(() => resolve({ blob: new Blob([String(r.width)]), keep: true }));
      }),
    put: () => undefined,
    createUrl: (blob) => `blob:${(blob as Blob & { size: number }).size}-${Math.random().toString(36).slice(2, 7)}`,
    revokeUrl: (url) => void revoked.push(url),
  };
  /** Let the queue run until the current render waits again. */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Finish the render that is running now. */
  const finish = async () => {
    await settle();
    pending.shift()?.();
    await settle();
  };
  return { backend, rendered, revoked, finish, settle };
}

describe('route preview map images', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('skips queued renders that no preview waits for any more (window resize, scrolled away)', async () => {
    const f = fakeBackend();
    const store = createSnapshotStore(f.backend);
    // a resize drag: the preview asks for one size after the other and lets go of the previous one each time
    const first = store.hold(req(300));
    await f.settle();
    let last = first;
    for (const w of [301, 302, 303, 304, 305]) {
      last.release();
      last = store.hold(req(w));
    }
    await f.finish(); // 300 was already rendering
    await f.finish();
    expect(f.rendered).toEqual([300, 305]);
    await expect(last.promise).resolves.toMatch(/^blob:/);
    await expect(first.promise).resolves.toMatch(/^blob:/);
  });

  it('renders a skipped image when it is asked for again', async () => {
    const f = fakeBackend();
    const store = createSnapshotStore(f.backend);
    const a = store.hold(req(200));
    await f.settle();
    const b = store.hold(req(210));
    await f.settle();
    b.release();
    await f.finish();
    await f.settle();
    await expect(b.promise).resolves.toBeNull();
    const again = store.hold(req(210));
    await f.finish();
    expect(f.rendered).toEqual([200, 210]);
    await expect(again.promise).resolves.toMatch(/^blob:/);
    a.release();
  });

  it('frees the URLs of images no preview shows beyond the reserve, oldest first, never one on screen', async () => {
    const f = fakeBackend({
      [snapshotKey(req(1))]: new Blob(['1']),
      [snapshotKey(req(2))]: new Blob(['2']),
      [snapshotKey(req(3))]: new Blob(['3']),
      [snapshotKey(req(4))]: new Blob(['4']),
    });
    const store = createSnapshotStore(f.backend, 2);
    const holds = [1, 2, 3, 4].map((w) => store.hold(req(w)));
    const urls = await Promise.all(holds.map((h) => h.promise));
    expect(f.revoked).toEqual([]);
    // all four are shown: nothing is freed although the reserve is 2
    holds[0]!.release();
    holds[1]!.release();
    expect(f.revoked).toEqual([]);
    holds[2]!.release();
    expect(f.revoked).toEqual([urls[0]]);
    expect(store.peek(snapshotKey(req(1)))).toBeNull();
    expect(store.peek(snapshotKey(req(2)))).toBe(urls[1]);
    // looked at again (scrolled back): now the most recently used one
    holds[3]!.release();
    expect(f.revoked).toEqual([urls[0], urls[2]]);
    expect(store.peek(snapshotKey(req(4)))).toBe(urls[3]);
  });

  it('keeps an image asked for without a hold (share image) rendered and valid for a minute', async () => {
    const f = fakeBackend({ [snapshotKey(req(7))]: new Blob(['7']), [snapshotKey(req(8))]: new Blob(['8']) });
    const store = createSnapshotStore(f.backend, 0);
    const share = store.get(req(500));
    await f.finish();
    const url = await share;
    expect(f.rendered).toEqual([500]);
    expect(url).toMatch(/^blob:/);
    const h = store.hold(req(7));
    await h.promise;
    h.release();
    expect(f.revoked).not.toContain(url);
    vi.setSystemTime(Date.now() + 61_000);
    const h2 = store.hold(req(8));
    await h2.promise;
    h2.release();
    expect(f.revoked).toContain(url);
  });
});
