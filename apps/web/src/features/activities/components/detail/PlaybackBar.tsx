import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { Button, IconButton, Select } from '@/components/ui';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SPEEDS, type Playback, type Speed } from '../../lib/playback';
import { useStore, useThrottledStore } from '../../lib/store';
import { isPaceSport } from '../../lib/display';
import { zoneOf } from '../../lib/route';
import { buckets, bucketMean, indexAtTime, valueAt, type Prepared } from '../../lib/streams';

/** Timeline with pauses (hatched), the elevation profile as a silhouette and a draggable thumb. */
function Scrubber({ P, playback }: { P: Prepared; playback: Playback }) {
  const { t } = useI18n();
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const time = useThrottledStore(playback.time, 250);

  useEffect(() => {
    const paint = (time: number) => {
      const f = P.duration > 0 ? Math.max(0, Math.min(1, time / P.duration)) : 0;
      if (fill.current) fill.current.style.width = `${f * 100}%`;
      if (thumb.current) thumb.current.style.left = `${f * 100}%`;
    };
    paint(playback.time.get());
    return playback.time.subscribe(paint);
  }, [P, playback]);

  const silhouette = useMemo(() => {
    if (!P.ele) return null;
    const B = buckets(P.n, 240);
    const e = bucketMean(P.ele, B);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of e) if (v === v) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    if (!(hi > lo)) return null;
    const pts: string[] = [];
    for (let b = 0; b < e.length; b++) {
      const x = (P.t[B.mid[b]!]! / P.duration) * 1000;
      const y = 30 - ((e[b]! - lo) / (hi - lo)) * 22;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return `M0,30 L${pts.join(' L')} L1000,30 Z`;
  }, [P]);

  const seekAt = (e: ReactPointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    playback.seek(f * P.duration);
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={t('activities.playback.timeline')}
      aria-valuemin={0}
      aria-valuemax={Math.round(P.duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${clock(time)} / ${clock(P.duration)}`}
      className="relative h-10 w-full min-w-0 cursor-pointer touch-none select-none overflow-hidden rounded-control bg-surface-2"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => dragging.current && seekAt(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {silhouette && (
        <svg viewBox="0 0 1000 30" preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-fg-3" aria-hidden>
          <path d={silhouette} fill="currentColor" opacity={0.16} />
        </svg>
      )}
      <div ref={fill} className="absolute inset-y-0 left-0 bg-accent-soft" />
      {P.pauses.map(([a, b]) => (
        <div
          key={a}
          className="absolute inset-y-0"
          title={`${t('activities.playback.pauses')}: ${clock(a)}–${clock(b)}`}
          style={{
            left: `${(a / P.duration) * 100}%`,
            width: `${Math.max(0.3, ((b - a) / P.duration) * 100)}%`,
            background: 'repeating-linear-gradient(135deg, var(--axis) 0 2px, transparent 2px 5px)',
          }}
        />
      ))}
      <div ref={thumb} className="absolute inset-y-0 -ml-px w-0.5 bg-accent">
        <div className="absolute -left-[5px] top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-card" />
      </div>
    </div>
  );
}

function Readout({ label, value, unit, extra }: { label: string; value: string; unit?: string; extra?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-fg-3">{label}</div>
      <div className="whitespace-nowrap text-sm font-semibold tabular text-fg">
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-medium text-fg-3">{unit}</span>}
      </div>
      {extra && <div className="text-[11px] font-medium text-fg-2">{extra}</div>}
    </div>
  );
}

/** Live values at the replay position. */
function LiveReadout({ P, playback, sport, zoneBounds }: { P: Prepared; playback: Playback; sport: string; zoneBounds: number[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const time = useThrottledStore(playback.time, 120);
  const fi = indexAtTime(P, time);
  const items: { key: string; label: string; value: string; unit?: string; extra?: string }[] = [
    { key: 't', label: t('activities.readout.elapsed'), value: clock(time) },
  ];
  if (P.dist) {
    const d = fmt.distanceParts(valueAt(P.dist, fi), 2);
    items.push({ key: 'd', label: t('activities.readout.distance'), value: d.value, unit: d.unit });
  }
  if (P.speed) {
    const sp = valueAt(P.speed, fi);
    const moving = P.moving[Math.min(P.n - 1, Math.ceil(fi))];
    const p = fmt.paceParts(moving ? sp : null, sport);
    items.push({ key: 's', label: isPaceSport(sport) ? t('common.pace') : t('common.speed'), value: p.value, unit: p.unit });
  }
  if (P.hr) {
    const h = valueAt(P.hr, fi);
    items.push({
      key: 'hr',
      label: t('common.heartRate'),
      value: h === h ? fmt.int(h) : '–',
      unit: 'bpm',
      extra: h === h ? t('activities.readout.zone', { zone: zoneOf(h, zoneBounds) + 1 }) : undefined,
    });
  }
  if (P.ele) {
    const e = fmt.elevationParts(valueAt(P.ele, fi));
    items.push({ key: 'e', label: t('common.elevation'), value: e.value, unit: e.unit });
  }
  if (P.grade) {
    const g = valueAt(P.grade, fi);
    items.push({ key: 'g', label: t('activities.readout.grade'), value: g === g ? fmt.num(g * 100, 1) : '–', unit: '%' });
  }
  if (P.cadence) {
    const c = valueAt(P.cadence, fi);
    items.push({ key: 'c', label: t('activities.charts.cadence'), value: c === c ? fmt.int(c) : '–', unit: sport === 'ride' ? 'rpm' : 'spm' });
  }
  if (P.power) {
    const w = valueAt(P.power, fi);
    items.push({ key: 'w', label: t('activities.charts.power'), value: w === w ? fmt.int(w) : '–', unit: 'W' });
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-4 gap-y-2" aria-live="off">
      {items.map(({ key, ...r }) => (
        <Readout key={key} {...r} />
      ))}
    </div>
  );
}

/** Play/pause, speed, timeline and live values of the replay. */
export function PlaybackBar({ P, playback, sport, zoneBounds }: { P: Prepared; playback: Playback; sport: string; zoneBounds: number[] }) {
  const { t } = useI18n();
  const state = useStore(playback.state);
  const time = useThrottledStore(playback.time, 120);
  const speedLabel = (s: Speed) => (s === 'fit' ? t('activities.playback.fit') : `${s}×`);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={state.playing ? Pause : Play}
          onClick={() => playback.toggle()}
          aria-keyshortcuts="Space"
          className="w-28"
        >
          {state.playing ? t('activities.playback.pause') : t('activities.playback.play')}
        </Button>
        <IconButton icon={RotateCcw} label={t('activities.playback.restart')} onClick={() => playback.reset()} />
        <span className="min-w-0 flex-1 text-xs tabular text-fg-2">
          {clock(time)} / {clock(P.duration)}
        </span>
        <div className="w-28 shrink-0" title={state.speed === 'fit' ? t('activities.playback.fitHint') : undefined}>
          <Select
            value={String(state.speed)}
            onChange={(v) => playback.setSpeed((v === 'fit' ? 'fit' : Number(v)) as Speed)}
            options={SPEEDS.map((s) => ({ value: String(s), label: speedLabel(s) }))}
            aria-label={t('activities.playback.speed')}
            className="h-8"
          />
        </div>
      </div>
      <Scrubber P={P} playback={playback} />
      <LiveReadout P={P} playback={playback} sport={sport} zoneBounds={zoneBounds} />
      <p className="hidden text-[11px] text-fg-3 sm:block">{t('activities.playback.keys')}</p>
    </div>
  );
}
