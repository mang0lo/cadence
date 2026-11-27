import { memo } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { Button, IconButton, Select } from '@/components/ui';
import { clock } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useStore, useThrottledStore } from '@/lib/store';
import { SPEEDS, type Playback, type Speed } from '../lib/playback';

/** "12:05 / 1:02:05" — the only part of the transport that re-renders while the replay runs. */
function ReplayClock({ playback }: { playback: Playback }) {
  const time = useThrottledStore(playback.time, 120);
  return (
    <span className="min-w-0 flex-1 text-xs tabular text-fg-2">
      {clock(time)} / {clock(playback.duration)}
    </span>
  );
}

/** Play/pause, restart, clock and speed of a replay (activity page and compare page). */
export const ReplayTransport = memo(function ReplayTransport({ playback }: { playback: Playback }) {
  const { t } = useI18n();
  const state = useStore(playback.state);
  const speedLabel = (s: Speed) => (s === 'fit' ? t('activities.playback.fit') : `${s}×`);
  return (
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
      <ReplayClock playback={playback} />
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
  );
});
