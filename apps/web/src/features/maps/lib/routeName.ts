import type { MapsRouteSummary } from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { Lang, TFunction } from '@/lib/i18n';
import { placeName } from '@/lib/places';

export { placeName };

/** Display name of a route: the user's own name, else "<area> loop · 10.2 km" generated from the data. */
export function routeTitle(
  r: Pick<MapsRouteSummary, 'customName' | 'area' | 'kind' | 'distanceM' | 'startLat' | 'startLon'> &
    Partial<Pick<MapsRouteSummary, 'areaEnd'>>,
  t: TFunction,
  fmt: Formatter,
  lang: Lang,
): string {
  if (r.customName) return r.customName;
  const distance = fmt.distance(r.distanceM, 1);
  // a route from one place to another: "Rostock → Warnemünde · 12.4 km"
  if (r.kind === 'point_to_point' && r.area && r.areaEnd)
    return t('maps.routes.auto.fromTo', { from: placeName(r.area, lang), to: placeName(r.areaEnd, lang), distance });
  const area = r.area
    ? placeName(r.area, lang)
    : r.startLat != null && r.startLon != null
      ? `${fmt.num(r.startLat, 2)}°, ${fmt.num(r.startLon, 2)}°`
      : null;
  return area
    ? t(`maps.routes.auto.${r.kind}`, { area, distance })
    : t(`maps.routes.auto.${r.kind}NoArea`, { distance });
}

/** Relative change of the average speed between the first and the last effort (positive = faster), or null. */
export function trendChange(trend: number[]): number | null {
  if (trend.length < 3) return null;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  return first > 0 ? last / first - 1 : null;
}

export const kindLabel = (kind: MapsRouteSummary['kind'], t: TFunction): string =>
  t(`maps.routes.kind.${kind}`);
