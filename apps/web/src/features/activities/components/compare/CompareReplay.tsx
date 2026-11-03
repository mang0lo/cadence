import { Pause, Play, RotateCcw } from 'lucide-react';
import { Button, IconButton, Select, Slider, cn } from '@/components/ui';
import { clock, useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { replayAt, type Alignment } from '../../lib/compare';
import { SPEEDS, type Playback, type Speed } from '../../lib/playback';
import { useStore, useThrottledStore } from '../../lib/store';
import type { Prepared } from '../../lib/streams';
import { SIDE_VAR } from './CompareMap';

/** "230 m" below a kilometer (mile), else "1.24 km". */
export function gapDistance(m: number, fmt: Formatter): string {
  return m < (fmt.units === 'imperial' ? 1609.344 : 1000) ? fmt.shortDistance(Math.round(m)) : fmt.distance(m);
}

function Readout({ label, value, color, wrap }: { label: string; value: string; color?: string; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 truncate text-[11px] text-fg-3">
        {color && <span className="h-1 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />}
        {label}
      </div>
      <div className={cn('text-sm font-semibold tabular text-fg', !wrap && 'whitespace-nowrap')}>{value}</div>
    </div>
  );
}

/** Play/pause, speed, timeline and who leads at the replay time. */
export function CompareReplay({ A, B, al, playback }: { A: Prepared; B: Prepared; al: Alignment; playback: Playback }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const state = useStore(playback.state);
  const time = useThrottledStore(playback.time, 120);
  const r = replayAt(A, B, al, time);
  const speedLabel = (s: Speed) => (s === 'fit' ? t('activities.playback.fit') : `${s}×`);
  let lead = '–';
  if (r.lead !== null) {
    if (Math.abs(r.lead) < 1) lead = t('activities.compare.level');
    else {
      const gap = r.gap !== null && Math.abs(r.gap) >= 1 ? ` · ${clock(Math.abs(r.gap))}` : '';
      lead = t('activities.compare.aheadBy', { name: r.lead > 0 ? 'A' : 'B', value: `${gapDistance(Math.abs(r.lead), fmt)}${gap}` });
    }
  }
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
          {clock(time)} / {clock(playback.duration)}
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
      <Slider
        value={Math.round(time)}
        min={0}
        max={Math.max(1, Math.round(playback.duration))}
        onChange={(v) => playback.seek(v)}
        label={t('activities.playback.timeline')}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-[repeat(3,minmax(0,0.8fr))_minmax(0,1.6fr)]" aria-live="off">
        <Readout label={t(`activities.compare.${al.base}`)} value={clock(time)} />
        <Readout label={t('activities.compare.replay.distanceOf', { name: 'A' })} value={fmt.distance(r.dA)} color={SIDE_VAR.a} />
        <Readout label={t('activities.compare.replay.distanceOf', { name: 'B' })} value={fmt.distance(r.dB)} color={SIDE_VAR.b} />
        <Readout label={t('activities.compare.replay.lead')} value={lead} wrap />
      </div>
      <p className="text-[11px] text-fg-3">
        {t('activities.compare.replay.hint')} <span className="hidden sm:inline">· {t('activities.playback.keys')}</span>
      </p>
    </div>
  );
}
