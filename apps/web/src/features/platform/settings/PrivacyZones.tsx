import { useEffect, useRef } from 'react';
import { MapPin, Trash2 } from 'lucide-react';
import type { Map } from 'maplibre-gl';
import type { Page, PrivacyZone, WorkoutSummary } from '@cadence/shared';
import { BaseMap } from '@/components/map/BaseMap';
import { featureCollection, isStyleReady, pointFeature, setGeoJSON } from '@/components/map/layers';
import { IconButton, Skeleton, Slider } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { decodePolyline } from '@/lib/polyline';
import { useDraft } from './useDraft';
import { coordsText, zonesBounds } from './validate';

/** A radius is saved once the slider rests this long (one request instead of one per step). */
const SAVE_RADIUS_MS = 400;
/** The second click of a double click (MapLibre zooms in) does not add another zone. */
const DOUBLE_CLICK_MS = 400;

/**
 * Settings → privacy zones: a map to add zones by clicking, and the list with radius and delete. Loaded on demand
 * (MapLibre is large). Zones are edited as a local draft: adding and deleting save at once, a radius when the slider
 * rests; every request carries the latest draft, so quick edits cannot overwrite each other.
 */
export default function PrivacyZones({ zones, onChange }: { zones: PrivacyZone[]; onChange: (z: PrivacyZone[]) => void }) {
  const t = useT();
  const fmt = useFormat();
  const { draft, edit, done } = useDraft(zones);
  const latest = useRef(draft);
  latest.current = draft;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mapRef = useRef<Map | null>(null);
  const timer = useRef<number | null>(null);
  const lastClick = useRef(0);

  // opens over the zones there are; without zones where the newest route starts (usually home), else the world
  const initialBounds = useRef(zonesBounds(zones)).current;
  const newest = useApi<Page<WorkoutSummary>>(['platform', 'newest-route'], initialBounds ? null : '/workouts', {
    hasRoute: true,
    limit: 1,
  });
  const start = newest.data?.items[0]?.polyline ? decodePolyline(newest.data.items[0].polyline)[0] : undefined;

  const save = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    done();
    onChangeRef.current(latest.current);
  };
  /** A change of the user: shown at once, saved now or when the radius slider rests. */
  const change = (next: PrivacyZone[], later = false) => {
    latest.current = next;
    edit(next);
    if (!later) save();
    else {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(save, SAVE_RADIUS_MS);
    }
  };
  const changeRef = useRef(change);
  changeRef.current = change;

  // a radius that is still waiting is saved when the page is left
  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      onChangeRef.current(latest.current);
    },
    [],
  );

  const draw = (map: Map) => {
    setGeoJSON(
      map,
      'privacy-zones',
      featureCollection(latest.current.map((z) => pointFeature([z.lon, z.lat], { r: z.radiusM }))),
    );
    if (!map.getLayer('privacy-zones')) {
      map.addLayer({
        id: 'privacy-zones',
        type: 'circle',
        source: 'privacy-zones',
        paint: {
          // radius in pixels approximated from meters at the current zoom/latitude
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'r'], 120], 16, ['/', ['get', 'r'], 1.9]],
          'circle-color': '#e8590c',
          'circle-opacity': 0.18,
          'circle-stroke-color': '#e8590c',
          'circle-stroke-width': 2,
        },
      });
    }
  };
  // isStyleReady, not isStyleLoaded: the latter is false while tiles load, and the redraw was dropped (a new zone
  // was missing from the map). While a style loads, onStyleLoad draws the latest zones.
  useEffect(() => {
    const map = mapRef.current;
    if (map && isStyleReady(map)) draw(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (!initialBounds && newest.isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="grid gap-3">
      <BaseMap
        className="h-64"
        bounds={initialBounds}
        center={start ? [start[1], start[0]] : [10, 30]}
        zoom={start ? 12 : 1}
        switcher={false}
        onReady={(map) => {
          mapRef.current = map;
          map.on('click', (e) => {
            const now = Date.now();
            const second = now - lastClick.current < DOUBLE_CLICK_MS;
            lastClick.current = now;
            if (second) return;
            changeRef.current([...latest.current, { lat: e.lngLat.lat, lon: e.lngLat.lng, radiusM: 300 }]);
          });
          map.getCanvas().style.cursor = 'crosshair';
        }}
        onStyleLoad={draw}
      >
        <div className="pointer-events-none absolute left-2 top-2 rounded-lg bg-surface/90 px-2 py-1 text-xs text-fg-2 shadow-card">
          {t('platform.settings.addZone')}
        </div>
      </BaseMap>
      {draft.map((z, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <MapPin size={15} className="shrink-0 text-accent-fg" />
          <span className="w-40 shrink-0 tabular text-fg-2">{coordsText(fmt.num, z.lat, z.lon)}</span>
          <span className="shrink-0 text-xs text-fg-3">{t('platform.settings.radius')}</span>
          <Slider
            value={z.radiusM}
            min={100}
            max={2000}
            step={50}
            label={t('platform.settings.radius')}
            onChange={(v) => change(latest.current.map((x, j) => (j === i ? { ...x, radiusM: v } : x)), true)}
          />
          <span className="w-16 shrink-0 text-right tabular text-fg-2">{fmt.shortDistance(z.radiusM)}</span>
          <IconButton icon={Trash2} label={t('common.delete')} onClick={() => change(latest.current.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  );
}
