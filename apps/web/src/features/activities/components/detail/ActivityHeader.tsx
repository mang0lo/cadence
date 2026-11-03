import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  GitCompareArrows,
  ImageDown,
  MapPinOff,
  NotebookPen,
  Pencil,
  Shapes,
  Waypoints,
} from 'lucide-react';
import { workoutTitle, type ActivityNav, type WorkoutDetail } from '@cadence/shared';
import { PlaceText } from '@/components/map/PlaceText';
import { Badge, Button, ErrorState, IconButton, Input, Textarea, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { usePatchWorkout } from '../../api';
import { tzLabel } from '../../lib/display';
import { CompareDialog } from '../compare/CompareDialog';
import { SportDialog } from '../SportDialog';

const ShareDialog = lazy(() => import('../share/ShareDialog'));

function InlineTitle({ w }: { w: WorkoutDetail }) {
  const { t, lang } = useI18n();
  const patch = usePatchWorkout();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(w.name);
  const input = useRef<HTMLInputElement>(null);
  const title = workoutTitle(w, lang);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = async () => {
    const name = text.trim();
    setEditing(false);
    if (name !== w.name.trim()) await patch.mutateAsync({ id: w.id, patch: { name } }).catch(() => undefined);
  };
  if (editing)
    return (
      <div className="min-w-0 flex-1">
        <Input
          ref={input}
          value={text}
          maxLength={200}
          placeholder={workoutTitle({ ...w, name: '' }, lang)}
          aria-label={t('activities.detail.titleLabel')}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              setText(w.name);
              setEditing(false);
            }
          }}
          className="h-10 text-xl font-semibold"
        />
        <p className="mt-1 text-xs text-fg-3">{t('activities.detail.titleHint')}</p>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">{title}</h1>
      <IconButton
        icon={Pencil}
        label={t('activities.detail.rename')}
        onClick={() => {
          setText(w.name);
          setEditing(true);
        }}
        className="shrink-0"
      />
      {patch.error && <ErrorState error={patch.error} className="ml-2" />}
    </div>
  );
}

function Notes({ w }: { w: WorkoutDetail }) {
  const { t } = useI18n();
  const patch = usePatchWorkout();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(w.notes ?? '');
  if (editing)
    return (
      <div className="grid gap-2">
        <Textarea
          autoFocus
          value={text}
          maxLength={20000}
          rows={4}
          placeholder={t('activities.detail.notesPlaceholder')}
          aria-label={t('activities.detail.notes')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={patch.isPending}
            onClick={async () => {
              await patch.mutateAsync({ id: w.id, patch: { notes: text.trim() ? text : null } });
              setEditing(false);
            }}
          >
            {t('common.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        </div>
        {patch.error && <ErrorState error={patch.error} />}
      </div>
    );
  if (!w.notes)
    return (
      <Button
        size="sm"
        variant="ghost"
        icon={NotebookPen}
        className="-ml-2.5 justify-self-start"
        onClick={() => {
          setText('');
          setEditing(true);
        }}
      >
        {t('activities.detail.addNotes')}
      </Button>
    );
  return (
    <div className="group flex items-start gap-2">
      <p className="min-w-0 flex-1 whitespace-pre-line text-sm text-fg-2 [overflow-wrap:anywhere]">{w.notes}</p>
      <IconButton
        icon={Pencil}
        label={t('activities.detail.editNotes')}
        onClick={() => {
          setText(w.notes ?? '');
          setEditing(true);
        }}
      />
    </div>
  );
}

function NavLink({ to, label, sub, dir }: { to: string | null; label: string; sub?: string; dir: 'prev' | 'next' }) {
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  const cls = 'grid size-8 place-items-center rounded-control text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg';
  if (!to)
    return (
      <span className={cn(cls, 'opacity-40')} aria-hidden>
        <Icon size={16} />
      </span>
    );
  return (
    <Link to={to} className={cls} aria-label={label} title={sub ? `${label}: ${sub}` : label}>
      <Icon size={16} />
    </Link>
  );
}

/** Title (inline editable), sport, date in the activity's time zone, device, notes and actions. */
export function ActivityHeader({ w, nav }: { w: WorkoutDetail; nav: ActivityNav | undefined }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const patch = usePatchWorkout();
  const [sportOpen, setSportOpen] = useState(false);
  const [dialog, setDialog] = useState<'compare' | 'share' | null>(null);
  const neighbor = (n: ActivityNav['prev']) =>
    n ? `${workoutTitle(n, lang)} · ${fmt.date(n.startTs, n.tzMin, 'day')}` : undefined;
  const zone = w.timezone ? `${w.timezone} (${tzLabel(w.tzMin)})` : tzLabel(w.tzMin);
  const device = [w.device, w.sourceName && w.sourceName !== w.device ? w.sourceName : null, w.sourceVersion]
    .filter(Boolean)
    .join(' · ');
  return (
    <header className="mb-5 grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <Link to="/activities" className="inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-fg">
          <ArrowLeft size={15} aria-hidden />
          {t('activities.detail.back')}
        </Link>
        <div className="flex items-center gap-0.5">
          <NavLink dir="prev" to={nav?.prev ? `/activities/${nav.prev.id}` : null} label={t('activities.detail.prev')} sub={neighbor(nav?.prev ?? null)} />
          <NavLink dir="next" to={nav?.next ? `/activities/${nav.next.id}` : null} label={t('activities.detail.next')} sub={neighbor(nav?.next ?? null)} />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full text-white"
          style={{ background: sportColorVar(w.sport) }}
          title={sportLabel(w.sport, lang)}
        >
          <SportIcon sport={w.sport} size={21} strokeWidth={2.25} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <InlineTitle key={`${w.id}-${w.name}`} w={w} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-3">
            <span className="font-medium text-fg-2">{sportLabel(w.sport, lang)}</span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(w.startTs * 1000).toISOString()}>{fmt.date(w.startTs, w.tzMin, 'weekday')}, {fmt.time(w.startTs, w.tzMin)}</time>
            <span className="text-xs">{zone}</span>
            {w.place && (
              <>
                <span aria-hidden>·</span>
                <PlaceText w={w} size={14} />
              </>
            )}
            {w.indoor && (
              <Badge icon={MapPinOff}>{t('activities.detail.indoor')}</Badge>
            )}
            {w.hidden && <Badge icon={EyeOff}>{t('activities.list.hiddenBadge')}</Badge>}
          </div>
          {device && (
            <div className="text-xs text-fg-3">
              {t('activities.detail.device')}: {device}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 max-xl:basis-full max-xl:pl-14">
          <Button size="sm" icon={GitCompareArrows} onClick={() => setDialog('compare')} title={t('activities.compare.actionHint')}>
            {t('activities.compare.action')}
          </Button>
          <Button size="sm" icon={ImageDown} onClick={() => setDialog('share')}>
            {t('activities.share.action')}
          </Button>
          <Button size="sm" icon={Shapes} onClick={() => setSportOpen(true)}>
            {t('activities.detail.changeSport')}
          </Button>
          <Button
            size="sm"
            icon={w.hidden ? Eye : EyeOff}
            loading={patch.isPending}
            onClick={() => void patch.mutateAsync({ id: w.id, patch: { hidden: !w.hidden } }).catch(() => undefined)}
          >
            {w.hidden ? t('activities.detail.unhide') : t('activities.detail.hide')}
          </Button>
          {w.hasRoute && (
            <>
              <a
                href={`/api/workouts/${w.id}/gpx?lang=${lang}`}
                download
                title={t('activities.detail.downloadGpx')}
                className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
              >
                <Download size={14} aria-hidden />
                {t('activities.detail.gpx')}
              </a>
              <Link
                to={`/maps/segments/new?workout=${w.id}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
              >
                <Waypoints size={14} aria-hidden />
                {t('activities.detail.createSegment')}
              </Link>
            </>
          )}
        </div>
      </div>

      {w.hidden && <p className="text-sm text-fg-3">{t('activities.detail.hiddenNotice')}</p>}
      {w.duplicateOf !== null && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-3">
          <Copy size={14} aria-hidden />
          {t('activities.detail.duplicateNotice')}
          <Link to={`/activities/${w.duplicateOf}`} className="font-medium text-accent-fg hover:underline">
            {t('activities.detail.openOriginal')}
          </Link>
        </p>
      )}
      {patch.error && <ErrorState error={patch.error} />}
      <Notes key={`${w.id}-${w.notes ?? ''}`} w={w} />
      <SportDialog
        workout={sportOpen ? { id: w.id, sport: w.sport, title: workoutTitle(w, lang) } : null}
        onClose={() => setSportOpen(false)}
      />
      {dialog === 'compare' && <CompareDialog w={w} onClose={() => setDialog(null)} />}
      {dialog === 'share' && (
        <Suspense fallback={null}>
          <ShareDialog w={w} onClose={() => setDialog(null)} />
        </Suspense>
      )}
    </header>
  );
}
