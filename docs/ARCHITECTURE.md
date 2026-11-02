# Cadence architecture

Cadence is a Strava-style training log that is fed by the complete Apple Health export
(`export.zip` from the Health app → profile → "Export All Health Data").

It is **local-first** (runs as a Mac app on your own machine) but built as a classic
**client/server web app**, so the very same code can later run on a server (Docker) and be used
from any browser.

```
┌──────────────── macOS app (apps/macos, Swift) ───────────────┐
│  WKWebView  ──http──▶  bundled Node runtime running the server │
└───────────────────────────────────────────────────────────────┘
          same server, same UI ⇣
┌──────────── Docker / any Linux box (deploy/) ─────────────────┐
│  browser  ──http──▶  node apps/server/dist/index.js            │
└───────────────────────────────────────────────────────────────┘
```

## Repository layout

| Path | What |
| --- | --- |
| `packages/shared` | TypeScript API contract (DTOs), sport catalogue, unit conversions. Imported as TS source by server and web. |
| `apps/server` | Fastify HTTP API + SQLite (`node:sqlite`, no native addons) + Apple Health importer (worker thread) + analytics. |
| `apps/web` | React 19 + Vite + Tailwind 4 UI, MapLibre maps, ECharts charts. |
| `apps/macos` | Native macOS shell (SwiftPM): starts the bundled server, shows the UI in a WKWebView, native import panel/menus. |
| `deploy` | Dockerfile + docker-compose for server deployments. |
| `scripts` | Build scripts (e.g. `build-macos.sh`). |
| `docs` | This file, Apple Health format notes. |

## Runtime modes & configuration

The server is configured only through environment variables (`apps/server/src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADENCE_MODE` | `dev` from source, `server` when bundled | `dev`, `desktop` or `server` |
| `PORT` / `HOST` | `8787` / `127.0.0.1` (`0.0.0.0` in server mode) | `PORT=0` picks a free port and prints `CADENCE_LISTENING {"url","port"}` |
| `CADENCE_DATA_DIR` | `<repo>/data` | SQLite database (`cadence.db`) and uploads |
| `CADENCE_WEB_DIR` | `apps/web/dist` | Built UI, served with SPA fallback |
| `CADENCE_PASSWORD` | – | Enables a single shared password for all `/api` routes (server deployments) |
| `CADENCE_ALLOW_LOCAL_IMPORT` | `1` unless server mode | Allows `POST /api/import/local {path}` |
| `CADENCE_IMPORT_DIR` | – | Folder watched for new exports (server deployments) |
| `CADENCE_PARENT_PID` | – | Server exits when this process disappears (used by the Mac shell) |

## Data conventions (important for every module)

- **Timestamps**: unix seconds (UTC) everywhere (`*_ts` columns, `…Ts` DTO fields).
  `tz_min` / `tzMin` = local UTC offset in minutes *at that moment* (from Apple's date strings).
  Local wall clock = `new Date((ts + tzMin * 60) * 1000)` read with the `getUTC*` methods.
- **Days**: `'YYYY-MM-DD'` strings in local time (`day` columns). In SQL:
  `date(start_ts + tz_min * 60, 'unixepoch')`.
- **Units**: canonical SI-ish units everywhere in DB and API: meters, seconds, m/s, kcal, °C, kg, bpm, W.
  Apple's exported units (km, mi, lb, kJ, degF…) are normalised on import (`normalizeUnit` in
  `packages/shared/src/units.ts`). The UI converts for display only.
- **Athlete scoping**: every table has `athlete_id`; requests carry `req.athleteId` (always 1 for now).
  Always filter by it so a future multi-user server needs no data migration.
- **Sports**: `workouts.sport` is a normalised key from `packages/shared/src/sports.ts`
  (`run`, `ride`, `walk`, `hike`, `swim`, …); the raw `HKWorkoutActivityType…` value is kept in `activity_type`.
- **Hidden & duplicates**: analytics must exclude `hidden = 1` and `duplicate_of IS NOT NULL` workouts
  unless explicitly asked otherwise.
- **node:sqlite binding**: only `number | bigint | string | null | Uint8Array` can be bound. The helpers in
  `apps/server/src/db/db.ts` (`all/get/run/tx`) convert booleans and `undefined`; raw prepared statements do not.

## Database

Core tables are created by `apps/server/src/db/schema.ts`. Highlights:

- `records` – every `<Record>` (tens of millions for long-time Apple Watch users). `WITHOUT ROWID`, clustered by
  `(athlete_id, type_id, start_ts, hash)`: range queries by type and time are cheap; `hash` makes re-imports idempotent.
- `workouts` (+ `workout_events`, `workout_activities`, `workout_routes`, `workout_streams`, `workout_splits`, `best_efforts`).
- `daily_metrics` – one row per (metric, local day) for every record type; `daily_activity` – workout totals per day & sport.
- `activity_summaries` (Apple activity rings), `correlations`, `ecg_readings`, `health_items` (everything else, lossless).
- `settings` – JSON key/value per athlete (`core.settings` holds `AthleteSettings`; features use `<feature>.<key>`).
- `import_jobs` – import / rederive job history and progress.

Migrations are code (`Migration { id, up }`) applied in order: core, then each feature in registration order.

## Import pipeline

1. `POST /api/import/upload` (multipart, streamed to `DATA_DIR/uploads`) or `POST /api/import/local {path}` (desktop).
2. A job is queued; a **worker thread** (same bundle entry, `src/index.ts`) streams the zip/xml, parses it with a
   fast streaming XML scanner, batch-inserts with `INSERT OR IGNORE`, then parses the referenced GPX routes and ECG CSVs.
3. **Derive**: core steps (`apps/server/src/derive`) build workout streams (GPS + HR + cadence + power), splits,
   best efforts, HR zones, relative effort, polylines, names, `daily_metrics`, `daily_activity`; then every feature's
   `deriveSteps` run in registration order with a `DeriveContext` (changed workout ids / earliest changed day).
4. Progress is polled by the UI via `GET /api/import/jobs/:id`.

## Feature modules

Each product area is a vertical slice with three parts that a single owner can change without touching shared files:

| Part | Location | Registered in |
| --- | --- | --- |
| Server | `apps/server/src/features/<name>/index.ts` exports a `Feature` (`migrations`, `routes`, `deriveSteps`) | `apps/server/src/features/index.ts` |
| Web | `apps/web/src/features/<name>/index.tsx` exports `routes`, `nav`, `messages`; `widgets.tsx` exports dashboard widgets | `apps/web/src/features/registry.ts` |
| Contract | `packages/shared/src/features/<name>.ts` | `packages/shared/src/index.ts` |

Routes of a feature are mounted under `/api/<name>`. Migration ids are prefixed `<name>_`.
Derive step ids are prefixed `<name>.`.

Current features: `activities`, `progress`, `consistency`, `maps`, `health` (+ `platform` in the web app for import/settings).

## API conventions

- JSON only, under `/api`. Errors: `{ "error": { "code": "...", "message": "..." } }` (throw `HttpError` from
  `apps/server/src/lib/http.ts`; zod errors become 400 automatically).
- Lists: `?limit=&offset=` → `Page<T>` (`{ items, total, limit, offset }`).
- Time filters: `from` / `to` as unix seconds, or `fromDay` / `toDay` as `YYYY-MM-DD`.
- Values in canonical units (see above). Never localise on the server.

## Web app conventions (apps/web)

**Stack**: React 19, React Router 7 (data router, `lazy` routes), TanStack Query 5, Tailwind 4, ECharts 6, MapLibre 6,
lucide-react icons. Path alias `@/` = `apps/web/src`.

- **Design tokens** (`src/styles.css`): use semantic classes only — `bg-bg`, `bg-surface`, `bg-surface-2`, `border-border`,
  `text-fg`, `text-fg-2`, `text-fg-3`, `text-accent-fg`, `bg-accent-soft`, `text-good-fg`, `text-critical-fg`, … — never raw
  hex. Dark mode is automatic (`<html data-theme>`); `dark:` variants exist but are rarely needed.
- **Primitives** (`src/components/ui.tsx`): `Page`, `PageHeader`, `FilterBar`, `Card`, `CardHeader`, `Stat`, `StatRow`,
  `Delta`, `Badge`, `Tabs`, `SegmentedControl`, `Select`, `Input`, `Switch`, `Slider`, `Field`, `Button`, `IconButton`,
  `Table/TH/TD`, `Dialog`, `EmptyState`, `ErrorState`, `Skeleton`, `Spinner`, `ProgressBar`, `KeyValues`, `Hint`.
- **Data**: `useApi<T>(['<feature>', …key], '/path', params)` (src/lib/api.ts). Query keys start with the feature name.
  Mutations: `api.post/patch/delete`. Previous data stays visible while refetching (no skeleton flash).
- **Formatting** — always via `const fmt = useFormat()` (src/lib/format.ts): `fmt.distance(m)`, `fmt.distanceParts(m)`,
  `fmt.pace(mps, sport)`, `fmt.speed`, `fmt.duration(s)`, `fmt.durationShort(s)`, `fmt.elevation(m)`, `fmt.hr`,
  `fmt.energy`, `fmt.weight`, `fmt.temperature`, `fmt.date(ts, tzMin, style)`, `fmt.day('YYYY-MM-DD', style)`,
  `fmt.relative(ts)`, `fmt.num/int/pct/compact/signed`. It respects metric/imperial and the locale (de: "5,21 km").
- **Dates**: `src/lib/time.ts` (`dayKey(ts, tzMin)`, `todayKey()`, `addDays`, `startOfWeek(day, weekStart)`, `eachDay`, …).
  Respect `settings.weekStart` from `useSettings()`.
- **i18n**: every visible string goes through `const t = useT()`; feature strings live in `features/<name>/messages.ts`
  (`en` + `de`, nested). Plurals: `{ one: '…', other: '…' }` + `t(key, { count })`. Shared strings: `t('common.…')`
  (src/lib/messages.ts). Workout titles: `workoutTitle(w, lang)` from @cadence/shared.
- **Sports**: `SportIcon`, `SportBadge`, `sportLabel`, `sportColorVar(sport)` (DOM) / `sportColor(theme, sport)` (charts),
  `sortSports()` (src/lib/sports.tsx). Sport colors are fixed per sport — never assign colors by rank.
- **Charts** (`src/components/charts`): `<EChart option=… height=…/>` + builders in `options.ts` (`timeAxis`, `valueAxis`,
  `categoryAxis`, `axisTooltip`, `itemTooltip`, `tooltipHtml`, `lineSeries`, `areaSeries`, `barSeries`,
  `stackedBarSeries`, `scatterSeries`, `legend`, `dataZoom`, `grid`) and `const theme = useChartTheme()` for colors
  (`theme.series[0..7]`, `theme.seq`, `theme.seqBlue`, `theme.zones`, `theme.diverging`, `theme.status`). Wrap charts in
  `<ChartCard title … table={…}>` and provide the table view. Also `CalendarHeatmap`, `Sparkline`.
  Rules (validated palette, see dataviz guidance): one y-axis per chart (never dual axis — use two charts); categorical
  colors assigned by entity in fixed order, max 8, fold the rest into "other"; sequential = one hue; HR zones use
  `theme.zones`; legends for ≥ 2 series; tooltips on everything; text never in series colors; thin marks.
- **Maps** (`src/components/map`): `<BaseMap bounds=… onStyleLoad={(map) => …}/>` follows the user's map style and
  theme, has a style switcher + 3D terrain toggle. Add sources/layers in `onStyleLoad` (called again after every style
  switch). Helpers: `setGeoJSON`, `addRouteLayers`, `gradientExpression`, `addCircleLayer`, `lineFeature`,
  `pointFeature`, `featureCollection`, `fitTo`, `overlayColors(pref, theme)`. For lists use `<RouteThumbnail polyline/>`
  (SVG) — never many WebGL maps on one page. `decodePolyline` in `src/lib/polyline.ts`.
- **Native shell**: `src/lib/native.ts` (`isNativeShell`, `postNative`).

## Development

```bash
npm install
npm run sample            # writes data/sample/export.zip (synthetic Apple Health export)
npm run import -- data/sample/export.zip
npm run dev               # server :8787 + web :5173 (proxy /api)
npm run typecheck && npm test
npm run build && npm start
```

Ports can be changed with `PORT` (server) and `VITE_PORT` + `CADENCE_API_PORT` (web dev server).
