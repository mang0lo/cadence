import type { MapsRouteSummary } from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { TFunction } from '@/lib/i18n';

/** Display name of a route: the user's own name, else "<area> loop · 10.2 km" generated from the data. */
export function routeTitle(
  r: Pick<MapsRouteSummary, 'customName' | 'area' | 'kind' | 'distanceM' | 'startLat' | 'startLon'>,
  t: TFunction,
  fmt: Formatter,
): string {
  if (r.customName) return r.customName;
  const area =
    r.area ?? (r.startLat != null && r.startLon != null ? `${fmt.num(r.startLat, 2)}°, ${fmt.num(r.startLon, 2)}°` : null);
  const distance = fmt.distance(r.distanceM, 1);
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

export const kindLabel = (kind: MapsRouteSummary['kind'], t: TFunction): string => t(`maps.routes.kind.${kind}`);
