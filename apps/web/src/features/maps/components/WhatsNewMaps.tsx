import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Grid3x3, Map as MapIcon, Route, Trophy, Waypoints, type LucideIcon } from 'lucide-react';
import type { ImportHighlight, MapsRouteSummary } from '@cadence/shared';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { WhatsNewProps } from '../../types';
import { routeTitle } from '../lib/routeName';

function Row({ icon: Icon, to, children }: { icon: LucideIcon; to: string; children: ReactNode }) {
  return (
    <li>
      <Link to={to} className="group flex items-start gap-2.5 py-2 text-sm text-fg-2">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-fg">
          <Icon size={13} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 group-hover:text-fg">{children}</span>
      </Link>
    </li>
  );
}

/** Explorer tiles, recurring routes, route bests and segment PRs of the new activities (import summary). */
export default function WhatsNewMaps({ items }: WhatsNewProps) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const name = (h: ImportHighlight) =>
    routeTitle(
      {
        customName: (h.data.customName as string | null) ?? null,
        area: (h.data.area as string | null) ?? null,
        areaEnd: (h.data.areaEnd as string | null) ?? null,
        kind: h.data.routeKind as MapsRouteSummary['kind'],
        distanceM: Number(h.data.distanceM),
        startLat: null,
        startLon: null,
      },
      t,
      fmt,
      lang,
    );
  const strong = (s: string) => <strong className="font-medium text-fg">{s}</strong>;
  const rows: ReactNode[] = [];
  for (const h of items) {
    const key = `${h.kind}-${String(h.data.routeId ?? h.data.segmentId ?? '')}`;
    if (h.kind === 'explorerTiles')
      rows.push(
        <Row key={key} icon={Grid3x3} to="/maps/explorer">
          {strong(t('maps.whatsNew.tiles', { count: Number(h.data.count) }))}
          {Number(h.data.squadratinhos) > 0 && (
            <span className="text-fg-3">
              {' · '}
              {t('maps.whatsNew.squadratinhos', { count: Number(h.data.squadratinhos) })}
            </span>
          )}
        </Row>,
      );
    else if (h.kind === 'newRoute')
      rows.push(
        <Row key={key} icon={Route} to={`/maps/routes/${String(h.data.routeId)}`}>
          {t('maps.whatsNew.newRoute')} {strong(name(h))}
          <span className="text-fg-3"> · {t('maps.whatsNew.efforts', { count: Number(h.data.efforts) })}</span>
        </Row>,
      );
    else if (h.kind === 'routeBest')
      rows.push(
        <Row key={key} icon={Trophy} to={`/maps/routes/${String(h.data.routeId)}`}>
          {t('maps.whatsNew.routeBest')} {strong(name(h))}: {strong(fmt.duration(Number(h.data.timeS)))}
          <span className="text-fg-3">
            {' '}
            ({t('maps.whatsNew.faster', { time: fmt.duration(Number(h.data.previousS) - Number(h.data.timeS)) })})
          </span>
        </Row>,
      );
    else if (h.kind === 'segmentPr')
      rows.push(
        <Row key={key} icon={Waypoints} to={`/maps/segments/${String(h.data.segmentId)}`}>
          {t('maps.whatsNew.segmentPr')} {strong(String(h.data.name))}: {strong(fmt.duration(Number(h.data.elapsedS)))}
          <span className="text-fg-3">
            {' '}
            ({t('maps.whatsNew.faster', { time: fmt.duration(Number(h.data.previousS) - Number(h.data.elapsedS)) })})
          </span>
        </Row>,
      );
    else if (h.kind === 'segmentEfforts')
      rows.push(
        <Row key={key} icon={Waypoints} to="/maps/segments">
          {t('maps.whatsNew.segmentEfforts', { count: Number(h.data.count) })}
          <span className="text-fg-3"> · {t('maps.whatsNew.onSegments', { count: Number(h.data.segments) })}</span>
        </Row>,
      );
  }
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
        <MapIcon size={14} aria-hidden />
        {t('maps.whatsNew.title')}
      </h3>
      <ul className="divide-y divide-border">{rows}</ul>
    </section>
  );
}
