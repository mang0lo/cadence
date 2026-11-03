import { skipPause, type Prepared } from './streams';
import { Store } from './store';

/** Playback speeds (activity seconds per real second); 'fit' plays the whole activity in about 30 s. */
export const SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300, 'fit'] as const;
export type Speed = (typeof SPEEDS)[number];
export const FIT_SECONDS = 30;

export interface PlaybackState {
  playing: boolean;
  speed: Speed;
  /** True once the user started or scrubbed (the map then dims the part not travelled yet). */
  started: boolean;
}

/** What the clock needs to know: its length and the intervals to skip (an activity, or two on a common clock). */
export type PlaybackTrack = Pick<Prepared, 'duration' | 'pauses'>;

/**
 * Animation clock for the activity replay. `time` (seconds since start) changes every animation frame and is
 * consumed imperatively (map, chart playheads); `state` changes rarely and drives React controls.
 * Stopped / paused intervals are skipped.
 */
export class Playback {
  readonly time = new Store<number>(0);
  readonly state = new Store<PlaybackState>({ playing: false, speed: 'fit', started: false });
  private raf: number | null = null;
  private last = 0;

  constructor(private readonly P: PlaybackTrack) {}

  get duration(): number {
    return this.P.duration;
  }

  /** Activity seconds per real second for the current speed. */
  rate(speed: Speed = this.state.get().speed): number {
    return speed === 'fit' ? Math.max(1, this.P.duration / FIT_SECONDS) : speed;
  }

  private patch(p: Partial<PlaybackState>): void {
    this.state.set({ ...this.state.get(), ...p });
  }

  play(): void {
    if (this.state.get().playing) return;
    if (this.time.get() >= this.P.duration - 0.01) this.time.set(0);
    this.patch({ playing: true, started: true });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.state.get().playing) this.patch({ playing: false });
  }

  toggle(): void {
    if (this.state.get().playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(this.P.duration, t));
    this.time.set(clamped);
    if (!this.state.get().started) this.patch({ started: true });
  }

  /** Jump by a fraction of the activity (keyboard ←/→). */
  step(fraction: number): void {
    this.seek(this.time.get() + fraction * this.P.duration);
  }

  setSpeed(speed: Speed): void {
    this.patch({ speed });
  }

  faster(dir: 1 | -1): void {
    const i = SPEEDS.indexOf(this.state.get().speed);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))]!;
    this.setSpeed(next);
  }

  /** Back to the start, nothing highlighted. */
  reset(): void {
    this.pause();
    this.time.set(0);
    this.patch({ started: false });
  }

  dispose(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private tick = (now: number) => {
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let t = this.time.get() + dt * this.rate();
    t = skipPause(this.P, t);
    if (t >= this.P.duration) {
      this.time.set(this.P.duration);
      this.raf = null;
      this.patch({ playing: false });
      return;
    }
    this.time.set(t);
    this.raf = requestAnimationFrame(this.tick);
  };
}
