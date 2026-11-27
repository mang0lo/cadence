# Cadence architecture

Cadence is a Strava-style training log fed by the complete Apple Health export (`export.zip` from the Health app →
profile → "Export All Health Data"), by FIT files from any watch and by COROS' cloud.

It is **local-first** but built as a classic **client/server web app**: the desktop apps start the bundled Node server
on `127.0.0.1` and show the web UI in a window, and the very same server runs on a home server (the Docker image
`ghcr.io/mang0lo/cadence`, or `npm start`) for any browser. Installing, importing and self-hosting are described in the
[README](../README.md); this file is for working on the code.

```
Mac app (apps/macos, Swift)           WKWebView     ─http─▶  Node runtime bundled in the app  ┐
Linux / Windows app (apps/desktop)    BrowserWindow ─http─▶  Electron's own Node              ├▶ server/index.js
Server: Docker image or `npm start`   any browser   ─http─▶  Node 24+                          ┘  + the web UI
```

## Repository layout

| Path | What |
| --- | --- |
| `packages/shared` | TypeScript API contract (DTOs per feature), the shell contract (`src/shell.ts`), sport and health catalogues, unit conversions, activity tags, track parts. Imported as TS source by the server and the web app; bundled into the desktop app. |
| `apps/server` | Fastify 5 HTTP API + SQLite (`node:sqlite`, no native addons) + importer (worker thread) + derive pipeline + feature modules. `scripts/`: sample generator, CLI import and developer tools (see *Developer scripts*). |
| `apps/web` | React 19 + Vite + Tailwind 4 UI, MapLibre maps, ECharts charts. |
| `apps/desktop` | Linux / Windows app (Electron): runs the server bundle on Electron's own Node (`ELECTRON_RUN_AS_NODE`), native open / save dialogs and menus, a preload bridge for the web UI. |
| `apps/macos` | Native macOS shell (SwiftPM, not an npm workspace): starts the bundled server, shows the UI in a WKWebView, native import panel and menus. Built by `npm run mac` (`scripts/build-macos.sh`). |
| `deploy` | Dockerfile + docker-compose for server deployments. |
| `scripts`, `install.sh` | `build-macos.sh` (Mac app and DMG); `install.sh` adds an AppImage to a Linux user's launcher. |
| `.github/workflows` | `ci.yml` (typecheck, tests, build, Docker image, desktop and Mac apps with a smoke start), `release.yml` (a release per `v*` tag, notes from `CHANGELOG.md`). |
| `docs` | This file, the Apple Health export format (`APPLE_HEALTH.md`), proposals for the next versions (`IDEAS.md`). |

## Configuration

The server is configured only through environment variables (`apps/server/src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADENCE_MODE` | `dev` when the TypeScript sources run (`tsx`), `server` for the bundle | `dev`, `desktop` (set by the apps) or `server`, see below |
| `PORT` | `8787` | `0` picks a free port. Every start prints `CADENCE_LISTENING {"url","port"}` on stdout, which the apps read |
| `HOST` | `127.0.0.1`; `0.0.0.0` only in server mode with `CADENCE_PASSWORD` | Address to listen on (the Docker image sets `0.0.0.0`). A server on a non-loopback address without a password warns at startup |
| `CADENCE_DATA_DIR` | `<repo>/data` (Docker: `/data`) | `cadence.db` (+ `-wal` / `-shm`), `uploads/`, the COROS FIT cache `connect/coros/`, backup snapshots while they download, restore files (`cadence.db.restore`, `cadence.db.before-restore-<time>`, `cadence.db.failed-restore-<time>`) |
| `CADENCE_WEB_DIR` | `apps/web/dist` (Docker: `/app/web`) | Built UI, served with an SPA fallback; without an `index.html` there the server is API only |
| `CADENCE_PASSWORD` | – | One shared password for every `/api` route except `status`, `auth/login` and `auth/logout`; the UI files are public. See *Request trust policy* |
| `CADENCE_TRUST_PROXY` | off | The reverse proxy's addresses or networks, comma separated (`127.0.0.1`, `172.16.0.0/12`, `loopback`, `uniquelocal`), or `true` for every peer. Only then are `X-Forwarded-For` / `-Proto` / `-Host` believed. A bare hop count is refused at startup |
| `CADENCE_ALLOWED_HOSTS` | see *Request trust policy* | Further host names a server answers to, comma separated; `.example.org` includes its subdomains, `*` allows any name |
| `CADENCE_ALLOW_LOCAL_IMPORT` | on, except in server mode | Only `1` allows `POST /api/import/local {path}`; any other non-empty value turns it off. Where it is off, a queued import is resumed after a restart only when its file is in the uploads, the watch folder or `<data>/connect` |
| `CADENCE_IMPORT_DIR` | – | Watch folder: `*.zip`, `*.xml` and `*.fit` files are imported once their size and mtime stayed the same between two polls (every 60 s). Files are never moved or deleted; imported ones are remembered by name, size and mtime (settings key `core.importWatch`, kept by "Delete all data"); an interrupted import is tried again, up to 3 attempts in all |
| `CADENCE_PARENT_PID` | – | The server exits when this process is gone (checked every 2 s; set by both apps) |
| `LOG_LEVEL` | `info` in dev, `warn` otherwise | Fastify log level; request logs need `info` (tests use `silent`) |
| `TZ` | the system's zone (compose file: `UTC`) | IANA zone of the server process: "today" where a request sends no `?today=`, sleep nights, the intraday heart rate, FIT workouts without a local time. In server mode a process without `TZ` warns at startup |
| `CADENCE_DEBUG` | – | Any value prints the import worker's log lines (`[import <id>] …`) |

`CADENCE_MODE` sets the defaults above:

- `server`: listens on `0.0.0.0` only with a password, local-path import off, `warn` logs, a startup line with version,
  address and data folder, the `TZ` warning. A restored backup restarts the server: it exits with code 75 and needs a
  supervisor that starts it again (Docker `restart: unless-stopped`, systemd `Restart=always`).
- `desktop` (set by the apps, see *Shells*): `127.0.0.1`, local import, `warn` logs, no startup line besides
  `CADENCE_LISTENING`; the apps start the server again after a restore.
- `dev`: `127.0.0.1`, local import, `info` logs; a restored backup is applied at the next manual start.

`npm start` runs the bundle, so it is server mode: without `CADENCE_PASSWORD` it stays on `127.0.0.1` unless `HOST` is
set.

Used only by the apps, the dev server and the build:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CADENCE_DATA_DIR` | both apps | Another data folder (tests, smoke runs); it then also holds `logs/server.log` |
| `CADENCE_DEV_URL` | both apps | Show this URL (e.g. `http://localhost:5173` of `npm run dev`) instead of the built-in server |
| `CADENCE_DESKTOP_SMOKE` / `CADENCE_SMOKE` | desktop app / Mac app | `=<file.png>`: start, wait until the app shell rendered, save a screenshot, quit (CI) |
| `VITE_PORT` / `CADENCE_API_PORT` | `npm run dev:web` | Vite's port (`5173`, `strictPort`) and the API port it proxies `/api` to (`8787`) |
| `CADENCE_NODE_VERSION` / `CADENCE_CACHE_DIR` | `npm run mac` | Node.js version bundled into Cadence.app (default: your `node`) and where its download is cached (`~/Library/Caches/cadence`) |

## Request trust policy

`registerAuth` (`apps/server/src/core/auth.ts`) adds one `onRequest` hook on the root instance, before any route:

1. **Host**: the desktop and dev modes, and a server without a password on a loopback address, answer only under
   `localhost`, `*.localhost`, IP addresses and the names in `CADENCE_ALLOWED_HOSTS` (otherwise 403
   `forbidden_host`), so a DNS-rebinding page cannot use the API under its own name. A server with a password or on
   another address answers to any name, or only to these when `CADENCE_ALLOWED_HOSTS` is set. With
   `CADENCE_TRUST_PROXY` the proxy's `X-Forwarded-Host` is checked as well.
2. **Origin**: `POST` / `PATCH` / `PUT` / `DELETE` from another site are refused (403 `cross_site_request`):
   `Sec-Fetch-Site` must be `same-origin` or `none`; browsers without Fetch Metadata are checked by `Origin` against
   the `Host`. Scripts send neither header and pass.
3. **Password** (`CADENCE_PASSWORD`): decided on the route the router matched, so percent-encoded or absolute-form
   targets cannot get past it. Every `/api` route needs a login unless it declares `config: { public: true }`
   (`GET /api/status`, `POST /api/auth/login`, `POST /api/auth/logout`); unknown `/api` paths ask for a login before
   they are a 404.

Browsers log in with `POST /api/auth/login` and get a random session cookie `cadence_auth` (30 days, `HttpOnly`,
`SameSite=Lax`; `Secure` when the request came over https: the socket, a trusted proxy's `X-Forwarded-Proto` or the
page's `Origin`). Sessions
are stored as an HMAC of cookie and password with their expiry in the settings key `core.sessions` (at most 100); a
new password ends them all, logout ends one, backups leave them out (a restore logs everyone out). Scripts send
`Authorization: Bearer <password>`. Eight wrong passwords (logins or Bearer requests) from one client within 15
minutes lock its logins for 5 minutes (429); IPv6 clients count per /64. Without `CADENCE_TRUST_PROXY` the client is
the socket's peer — behind a proxy every client is the proxy, which a password-protected server says once in its log.

Every response also carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Content-Security-Policy: frame-ancestors 'self'` and `Referrer-Policy: same-origin`.

## Data conventions (important for every module)

- **Timestamps**: unix seconds (UTC) everywhere (`*_ts` columns, `…Ts` DTO fields).
  `tz_min` / `tzMin` = local UTC offset in minutes *at that moment* (from Apple's date strings).
  Local wall clock = `new Date((ts + tzMin * 60) * 1000)` read with the `getUTC*` methods.
- **Days**: `'YYYY-MM-DD'` strings in local time (`day` columns). In SQL:
  `date(start_ts + tz_min * 60, 'unixepoch')`. Routes validate days with `zDay` (`apps/server/src/lib/params.ts`): a
  day that does not exist (`2026-02-30`) is a 400 `invalid_request`.
- **Units**: canonical SI-ish units everywhere in DB and API: meters, seconds, m/s, kcal, °C, kg, bpm, W, liters.
  Apple's exported units (km, mi, lb, kJ, degF, fl oz …) are normalised on import (`normalizeUnit` in
  `packages/shared/src/units.ts`). The UI converts for display only.
- **Athlete scoping**: every table with per-athlete rows has `athlete_id`, except child tables scoped through their
  parent (`workout_activities`, `workout_events`, `workout_routes`, `workout_streams`, `workout_splits`,
  `workout_samples` via `workout_id`; `consistency_goal_checks` via `goal_id`) and the shared dictionaries
  `record_types`, `sources`, `devices`. Requests carry `req.athleteId` (always 1 for now). Always filter by it so a
  future multi-user server needs no data migration.
- **Sports**: `workouts.sport` is a normalised key from `packages/shared/src/sports.ts`
  (`run`, `ride`, `walk`, `hike`, `swim`, …); the raw `HKWorkoutActivityType…` value is kept in `activity_type`. Look
  sports up with own keys only (`'toString'` is no sport).
- **Hidden & duplicates**: analytics must exclude `hidden = 1` and `duplicate_of IS NOT NULL` workouts
  unless explicitly asked otherwise.
- **Places and tags of a workout** are stored by the derive step from the offline gazetteer (`lib/places`):
  `place` / `place_end` (start, and the end of one-way activities), `places_via` and `countries` (`|Hannover|Berlin|`,
  `|DE|AT|` — every place and country the route passes through, searchable with `LIKE`), `hard_reps` (repetitions for
  the estimated training kind, `trainingKind()` in `packages/shared/src/tags.ts`). `workouts.name` stays empty unless
  the user renamed the activity or a COROS download named it (the FIT file's `.json` sidecar); the UI shows
  `workoutTitle()`.
- **node:sqlite binding**: only `number | bigint | string | null | Uint8Array` can be bound. The helpers in
  `apps/server/src/db/db.ts` (`all/get/run/tx`) convert booleans and `undefined`; raw prepared statements do not.

## Database

Core tables are created by `apps/server/src/db/schema.ts`. Highlights:

- `records` – every `<Record>` (tens of millions for long-time Apple Watch users). `WITHOUT ROWID`, clustered by
  `(athlete_id, type_id, start_ts, hash)`: range queries by type and time are cheap; `hash` makes re-imports idempotent.
  `record_type_stats` keeps count and range per type (with a checkpoint so that a re-import recounts only the end).
- `workouts` (+ `workout_events`, `workout_activities`, `workout_routes`, `workout_streams`, `workout_splits`,
  `workout_samples` from FIT files, `best_efforts`).
- `daily_metrics` – one row per (metric, local day) for every record type; `daily_activity` – workout totals per day & sport.
- `activity_summaries` (activity rings), `correlations`, `ecg_readings`, `health_items` (everything else, lossless).
- `settings` – JSON key/value per athlete (`core.settings` holds the `AthleteSettings` keys the athlete changed;
  features use `<feature>.<key>`).
- `import_jobs` – import / rederive job history and progress.

Feature tables (`*` = kept by "Delete all data", `Feature.keepOnReset`):

| Feature | Derive steps | Tables |
| --- | --- | --- |
| activities | `activities.analysis` | `activities_analysis` |
| progress | `progress.workout-caches` | `progress_workout_metrics`, `progress_power_bests`, `progress_power_state` |
| connect | `connect.coros` | `connect_activities`, `connect_rings` |
| consistency | `consistency.achievements` | `consistency_goals`*, `consistency_goal_checks`*, `consistency_achievements` |
| maps | `maps.geometry`, `maps.routes`, `maps.segments` | `maps_workout_tiles`, `maps_workout_geo`, `maps_routes`, `maps_segments`*, `maps_segment_efforts` |
| health | `health.sleep`, `health.ecg`, `health.record-sources` | `health_sleep_nights`, `health_external_nights`, `health_ecg_stats`, `health_record_sources`, `health_record_sources_stamp` |

Migrations are code (`Migration { id, up }`, `db/migrate.ts`) applied in order — core, then each feature in
registration order — and recorded in `_migrations`; ids (`<feature>_<nnn>_<what>`) are never renamed.

Version constants make stored results stale when their computation changes; bump the right one:

- `DERIVE_VERSION` (`derive/context.ts`, now 4): workouts derived by an older version are added to every derive, and
  the server queues a full rebuild at startup (`origin: 'upgrade'`).
- `STREAMS_VERSION` (`derive/context.ts`): format of `workout_streams`.
- `EFFORT_VERSION` (`derive/effort.ts`): part of the stored effort basis (`core.effortBasis`); a change recomputes zones
  and relative effort of every workout once.
- `ANALYSIS_VERSION` (`features/activities/store.ts`), `METRICS_VERSION` (`features/progress/workout-metrics.ts`),
  `POWER_CURVE_VERSION` (`features/progress/power-curve.ts`): rows of an older version are recomputed; at startup the
  activities and progress routes queue a small `upgrade` derive when rows are missing or outdated.
- `ACHIEVEMENTS_VERSION` (`features/consistency/achievements.ts`): bump when trophy rules or the catalog change;
  stored results are recomputed on the next read.

## Import and derive

1. `POST /api/import/upload` (multipart, streamed to `<data>/uploads`), `POST /api/import/local {path}` (apps and
   dev), the watch folder or a COROS sync queue a job in `import_jobs`. Jobs run one at a time.
2. A **worker thread** (same bundle entry, `src/index.ts`) streams the zip / folder / `export.xml`, parses it with a
   fast streaming XML scanner, batch-inserts with `INSERT OR IGNORE`, then parses the referenced GPX routes and ECG
   CSVs. Anything that is not the Health app's `export.xml` (e.g. `export_cda.xml`) fails as `invalid_input`; a route
   or ECG file in a zip that declares more than 256 MB, or inflates beyond what it declares, is refused.
3. **Derive**: the core steps (`apps/server/src/derive/pipeline.ts`) run in this order — `core.workouts` (streams of
   GPS + HR + cadence + power, moving time, splits, best efforts, polylines, places and tags), `core.duplicates`,
   `core.daily-metrics` (`daily_metrics`, `record_type_stats`), `core.effort` (HR zones, relative effort),
   `core.daily-activity` — then every feature's `deriveSteps` in registration order. A failing core step fails the job;
   a failing feature step only adds a warning.
4. The UI polls `GET /api/import/jobs` every 1.5 s while a job is queued or running (every 15 s otherwise);
   `GET /api/import/jobs/:id` returns one job.

**FIT files** (other watches): the same job imports a `.fit` file, a folder of them or a zip without `export.xml`
(`src/import/fit`, Garmin's `@garmin/fitsdk` decoder). Each file becomes a workout (`ext_key` `fit:<serial>:<start>`)
with its GPS track (`workout_routes`, `linked_by = 'fit'`) and the device's own sensor samples in `workout_samples`
(HR, power, cadence, distance); virtual rides and runs (Zwift …) get no track. `core.workouts` prefers those samples
over Apple Health records. When the vendor app also wrote the workout to Health, `core.duplicates` keeps the copy of
the preferred source (Settings → My watch): the FIT copy with *COROS* / *Other*, the Apple Health copy with the
default *Apple Watch*.

**Jobs** (`ImportJob` in `packages/shared/src/core.ts`): `kind` import or rederive, `status` queued → running → done /
failed / cancelled, `phase` upload / scan / parse / routes / ecg / derive / finalize. `message`, `step` and `error`
are English for logs; the UI translates by `stepId` (the running derive step's id; a test in
`apps/web/test/features/platform/import-jobs.test.ts` fails when a server step has no translation) and by `errorCode`:
`interrupted` (the server stopped during the job), `not_resumed` (a queued local import where local imports are off),
`source_gone`, `worker_crashed`, `invalid_input`, `failed`. On startup `JobManager.start()` marks running jobs
interrupted, resumes queued imports, and queues a full rebuild after a `DERIVE_VERSION` change and a recovery derive
for pending changes (below). A derive request (settings change, workout edit, "Rebuild analysis") joins a rederive of
the athlete that is still queued instead of queueing another.

**Derive scope** (`import/scope.ts`): what still has to be derived is kept in the database, so a cancelled, failed or
interrupted job loses nothing.

- A `ChangeScope` says what changed: everything (`all`), workouts (new, new route or samples, edited sport, hidden …),
  record types with their earliest changed `start_ts`, every record type from a day on (`typesFrom`), the earliest
  timestamp of any change (`minTs`) and days named explicitly (`minDay`).
- Importers add what they write to the athlete's pending scope (settings key `core.pendingDerive`) in the same
  transaction as the data (`notePending`).
- A job claims the pending scope plus its own request (`claimScope` → `core.deriveClaim`) before `runDerive` and drops
  the claim only after the derive returned (`releaseClaim`); a derive that does not finish leaves it to the next job of
  the athlete. Server start and a cancelled or failed import queue a recovery derive (`origin: 'recover'`) when
  something is pending; "Delete all data" clears both keys.
- "Rebuild analysis" (`POST /api/import/rederive`, `origin: 'api'`) is a request, not a change: it is not claimed, so
  cancelling it really stops it. Full rebuilds caused by a change (another workout source, an update, a reset) are
  claimed and resume.

Steps get a `DeriveContext` (`apps/server/src/features/types.ts`): `workoutIds` (`'all'` or the changed workouts plus
those of an older `DERIVE_VERSION`, the athlete's own only), `sinceDay` (earliest local day touched by new records,
null = every day), `report`, `checkCancelled`, `log`, and `changes`: `recordTypes` (`'all'` or identifier → earliest
changed `start_ts`; an empty map = no health record changed), `effortBasis` (zones and relative effort of every
workout were recomputed; `workoutIds` is not widened for it) and `duplicateFlips` (workouts outside `workoutIds` whose
`duplicate_of` changed). A step that depends on effort, zones or duplicate marks must look at `changes`.

**Writes while a job runs**: node:sqlite is synchronous, and the job worker writes in back-to-back transactions. Writes
of the HTTP thread through `run()` / `tx()` announce themselves in a counter shared with the worker
(`SharedArrayBuffer`, `db.ts`), and the worker lets them through (up to 2 s) before it takes the write lock again.
Statements prepared and run directly on the main thread are not announced. A write that still finds the database
locked after `busy_timeout` (15 s) answers 503 `busy` with `Retry-After: 2`. The worker saves a running job's
progress itself (on phase changes, at most every 5 s).

**Backup and restore** (`core/backup-routes.ts`): `GET /api/backup` streams a `VACUUM INTO` snapshot made on a
read-only connection in a worker thread; parallel downloads within 30 s share it, a later one gets 409 `busy` while it
still streams. Logins of other services (`Feature.secretSettings`) and `core.sessions` are removed from the copy.
`POST /api/backup/restore` (not while a job runs) accepts only a Cadence database (core tables and `core_001_init`),
saves it as `cadence.db.restore` and — in desktop and server mode — exits with code 75; on the next start the old
database is kept as `cadence.db.before-restore-<time>` (never deleted automatically), and a restored file that cannot
be opened or migrated is set aside as `cadence.db.failed-restore-<time>` while the previous database comes back.

## Feature modules

Each product area is a vertical slice with three parts that a single owner can change without touching shared files:

| Part | Location | Registered in |
| --- | --- | --- |
| Server | `apps/server/src/features/<name>/index.ts` default-exports a `Feature` (`migrations`, `routes`, `deriveSteps`, optional `keepOnReset`, `onReset`, `whatsNew`, `secretSettings`) | `features` in `apps/server/src/features/index.ts` |
| Web | `apps/web/src/features/<name>/index.tsx` default-exports a `FeatureModule` (`name` = i18n namespace, `routes`, `nav`, `messages`, optional `widgets` and `whatsNew`); widget components live in `widgets.tsx` | `featureModules` in `apps/web/src/features/registry.ts` |
| Contract | `packages/shared/src/features/<name>.ts` | `packages/shared/src/index.ts` |

Routes of a feature are mounted under `/api/<name>`. Migration ids are prefixed `<name>_`, derive step ids `<name>.`.
The server registers the features as `activities`, `progress`, `connect`, `consistency`, `maps`, `health`: the order of
migrations and derive steps (`connect` before `consistency`, so that `connect.coros` settles the rings that
`consistency.achievements` reads). The web app has the same modules (`connect` is the Watches page) plus `platform`
(import, settings).

- "Delete all data" (`POST /api/import/reset`) empties every table with an `athlete_id` column except `settings`,
  `import_jobs` (only finished jobs are deleted) and the tables a feature lists in `keepOnReset` (user-written data
  such as goals and segments); `onReset` lets a feature clear references from kept rows to deleted workouts.
- `whatsNew(input)` returns highlights of the workouts an import added (records, trophies, explorer tiles …).
  `input.workoutIds` are the new visible workouts, `input.importedIds` every workout the import added (hidden ones and
  duplicates included). They are stored with the job (`ImportStats.summary`) and rendered on the import screen by the
  web module's `whatsNew` component of the same feature.
- `secretSettings` lists setting keys that hold logins of other services (`connect.coros`); backups leave them out.
- **Dashboard widgets**: `FeatureModule.widgets` lists `{ id, order, component, available? }`, where `component`
  loads the component from the feature's `widgets.tsx` (`() => import('./widgets').then((m) => m.StreakWidget)`). The
  registry collects them sorted by `order` (`dashboardWidgets`); the dashboard shows each in an error boundary, and a
  widget renders its own `Card` (or nothing when there is nothing to show).

### Adding a feature module

1. **Contract**: `packages/shared/src/features/<name>.ts`, and `export * from './features/<name>';` in
   `packages/shared/src/index.ts`.
2. **Server**: `apps/server/src/features/<name>/index.ts` default-exports a `Feature`:
   - `migrations`: `{ id: '<name>_001_<what>', up: sql | (db) => … }`.
   - `routes`: a Fastify plugin mounted at `/api/<name>`. Validate with zod (`zDay` for days), throw `HttpError` /
     `badRequest` / `notFound` (`lib/http.ts`), filter by `req.athleteId`, accept `?today=YYYY-MM-DD` where "today"
     matters.
   - `deriveSteps`: `{ id: '<name>.<step>', label, weight?, run(ctx) }`; add the id to `STEP_KEYS` in
     `apps/web/src/features/platform/importJobs.ts` and its name to `platform.import.steps` (en + de).
   - Settings with `getSetting` / `setSetting` (`core/settings.ts`) under `<name>.<key>`.
   - Append it to `features` in `apps/server/src/features/index.ts` (the order is the migration and derive order).
3. **Web**: `apps/web/src/features/<name>/index.tsx` default-exports a `FeatureModule`: lazy `routes` without a leading
   slash, `nav` items (`path`, `labelKey`, `icon`, `group`: `training` | `habits` | `explore` | `health` | `app`,
   `order`, `end?`, `available(sources)?` to hide pages without data), `messages` (en + de), optional `widgets` and
   `whatsNew`. Add it to `featureModules` in `registry.ts`. Query keys start with `'<name>'`.
4. **Tests**: server tests in `apps/server/test/<name>*.test.ts`, pure web helpers in `apps/web/test/features/<name>/`.
   Run `npm run typecheck && npm test && npm run build`; existing data gets the new derive steps with the next import
   or "Rebuild analysis".

### Notes per feature

**Goals** (`consistency`): a goal is a period (day / week / month / year), an optional sport, a measure and a target in
canonical units; `goalMetricsFor(sport, period)` in the shared package says which measures exist for a sport and is
used by the form and the API alike. Progress is computed from `daily_activity`, never stored. Weekly, monthly and
yearly goals are judged as of the last day the data covers (any source: records, workouts, rings, the newest Apple
export; `core/coverage.ts`); a daily goal is about the real today, and days the data does not cover yet are
`pending`, not missed. `consistency_goal_checks` holds the check marks set by hand, keyed by the first day of the
period (weekly goals: the fourth day of the week, so either week start finds it); a checked period counts as reached
everywhere, also for the consistency score.

**Sidebar**: built from the `nav` of every web module. The athlete's own order lives in the settings (`navOrder`:
paths, `navGroups`: groups) and is applied by `components/layout/navOrder.ts`: pages the saved order does not know
(added by a newer version) follow in their default order, and pages hidden for an athlete keep their slot.

**connect** pulls activities and daily values from vendor clouds. COROS uses two private, unofficial APIs:

- Training Hub (`features/connect/coros-client.ts`): activities as FIT files, cached in `<data>/connect/coros/` (with a
  `<file>.json` sidecar for name and device) and imported by a regular import job (`origin: 'connect'`,
  `options.files`). `connect_activities` tracks each activity: the import job of its cached file (re-imported from the
  cache when that job did not finish, up to 3 times) and failed downloads (retried after 3 h, 12 h, 1 d, 3 d, 7 d;
  then only by a full sync). Daily values from `analyse/dayDetail/query` in 168-day windows (a first or full sync walks
  back until two windows in a row are empty, later syncs start 7 days before the last synced day; VO₂max and stamina
  from `dashboard/detail/query`, last 7 days only) go into records of their own types — `COROSRestingHeartRate`,
  `COROSSleepHRV`, `COROSSleepHRVBaseline`, `COROSTrainingLoad`, `COROSAcuteLoad`, `COROSBaseFitness`,
  `COROSLoadRatio`, `COROSFatigue`, `COROSVO2Max`, `COROSStaminaLevel` (source `COROS`, one value per day), and their
  `daily_metrics` are refreshed directly (`coros-health.ts`).
- The COROS phone app's API (`coros-mobile.ts`; own login, its token kept as `mobileToken`; the first login can sign
  the phone app out once), unless *Sleep, steps & all-day heart rate* is off on the Watches page (`mobileData`,
  `PATCH /api/connect/coros`): 31-day windows of `COROSSteps`, `COROSCalories`, `COROSActiveMinutes` (daily totals
  that add up over weeks and months),
  `COROSHeartRate` with `COROSHeartRateMin` / `Max` as its daily band, sleep nights per stage in
  `health_external_nights` (merged into `health_sleep_nights` by `features/health/sleep.ts`: they fill days without an
  Apple night and replace Apple's when the watch is preferred), and the daily goals as rings in `connect_rings` (Move =
  calories, Exercise = active time), shown in `activity_summaries` where Apple has no rings or the watch is preferred
  (`connect.coros` re-applies the choice after every derive).

The settings key `connect.coros` holds the e-mail, the MD5 of the password (what COROS' login takes — it logs in like
the password, so protect the data folder), the tokens and the sync state. It is never sent to the browser, left out of
backups, written with `secure_delete`, and deleted (with a WAL truncate) on disconnect. Requests are spaced (Training
Hub 400 ms, phone app 800 ms) and retried on 429 / 5xx / network errors; a sync logs in again only when COROS rejects
the token, and a refused login pauses the automatic sync (`needsReconnect`) until the account is connected again.
Automatic sync runs 90 s after start and every 3 h. COROS values are never averaged with Apple's.

**Data sources** (Settings → My watch, `AthleteSettings.watch` + `sources.{workouts,heart}`): `core/sources.ts` decides
which source wins. `heartMetric(db, athleteId, 'restingHr' | 'hrv' | 'vo2max' | 'steps' | 'heartRate')` returns the
daily_metrics key to read (the preferred source if it has data, else the other) — use it instead of hard-coding the
HealthKit identifier; the identifiers read by name and the Apple / watch keys of these metrics are in
`packages/shared/src/features/health-catalogue.ts`. Duplicate detection keeps the preferred copy of a workout (`fit:`
= the watch's own file). Changing the workout preference queues a full rederive. Connecting COROS for the first time
sets `watch: 'coros'` while `core.settings` has no `watch` key yet (settings saved before this version contain every
key, so there the athlete chooses in Settings) and queues the same rederive.

## API conventions

- JSON only, under `/api`. Errors: `{ "error": { "code": "...", "message": "..." } }` (throw `HttpError` from
  `apps/server/src/lib/http.ts`; zod errors become 400 `invalid_request` automatically). Messages are English; the web
  app translates by `code` (`busy`, `not_found`, `unauthorized`, `too_many_attempts` …).
- Lists: `?limit=&offset=` → `Page<T>` (`{ items, total, limit, offset }`).
- Time filters: `from` / `to` as unix seconds, or `fromDay` / `toDay` as `YYYY-MM-DD` (local days; activities are
  matched by their own `tz_min`).
- "Today": pages send the browser's day as `?today=YYYY-MM-DD`; without it the server uses its own zone (`TZ`).
- Values in canonical units (see above). Never localise on the server.

Endpoints outside the feature modules: `GET status` (public), `POST auth/login`, `POST auth/logout`;
`GET|PATCH athlete`, `GET|PATCH settings`, `GET sources`; `GET workouts`, `GET|PATCH workouts/:id`,
`GET workouts/:id/streams`, `GET workouts/:id/gpx`, `GET meta/sports`; `GET metrics/types`, `GET metrics/daily`,
`GET metrics/samples`; `GET backup`, `POST backup/restore`; `POST import/upload`, `POST import/local`,
`GET import/jobs`, `GET import/jobs/:id`, `POST import/jobs/:id/cancel`, `POST import/rederive {workoutIds?, sinceDay?}`
and `POST import/reset {confirm: 'DELETE'}`. Feature endpoints are in each feature's `routes.ts` (or `*-routes.ts`).

## Web app conventions (apps/web)

**Stack**: React 19, React Router 7 (data router, `lazy` routes), TanStack Query 5, Tailwind 4, ECharts 6, MapLibre 6,
lucide-react icons. Path alias `@/` = `apps/web/src`.

- **Design tokens** (`src/styles.css`): use semantic classes only — `bg-bg`, `bg-surface`, `bg-surface-2`, `border-border`,
  `text-fg`, `text-fg-2`, `text-fg-3`, `text-accent-fg`, `bg-accent-soft`, `text-good-fg`, `text-critical-fg`, … — never raw
  hex. Dark mode is automatic (`<html data-theme>`); `dark:` variants exist but are rarely needed.
- **Primitives** (`src/components/ui.tsx`): `Page`, `PageHeader`, `FilterBar`, `Grid`, `Card`, `CardHeader`, `Stat`,
  `StatRow`, `Delta`, `Badge`, `Tabs`, `SegmentedControl`, `Select`, `Input`, `Textarea`, `Switch`, `Slider`, `Field`,
  `Button`, `IconButton`, `Table/TH/TD`, `Dialog`, `EmptyState`, `ErrorState`, `Skeleton`, `Spinner`, `ProgressBar`,
  `KeyValues`, `Hint`. Form controls (`Input`, `Select`, `Textarea`) are full width unless you pass a `w-*` class.
  `Input`, `Select`, `Button` and `IconButton` take `size="sm"` (smaller height and text) — never override their
  height with an important modifier. A sortable `TH` (`onClick`, `sorted`, `title`) renders its own button, so it
  works with the keyboard. `cn` is plain `clsx` (no tailwind-merge), so never pass a utility that conflicts with one a
  primitive already sets.
- **Data**: `useApi<T>(['<feature>', …key], '/path', params)` (src/lib/api.ts). Query keys start with the feature name.
  Requests get TanStack's `AbortSignal`, so superseded ones are cancelled. Failures are `ApiError(status, code)`
  (`status` 0 / `network` when no answer came; only 4xx are not retried); show them with `ErrorState`, which translates
  known codes (`lib/errors.ts`) and keeps the server's text as a small detail — pass translated text for other errors.
  Mutations: `api.post/put/patch/delete`. Previous data stays visible while refetching (no skeleton flash).
- **Settings**: `useSettings()` (`src/lib/settings.tsx`): `update()` shows a change at once and saves changes in
  order. Only keys the server reads (`DATA_KEYS`: week start, heart rate, zones, FTP, sex, birth date, watch, sources)
  reload the data; add a key there when the server starts reading it.
- **Formatting** — always via `const fmt = useFormat()` (src/lib/format.ts): `fmt.distance(m)`, `fmt.distanceParts(m)`,
  `fmt.pace(mps, sport)`, `fmt.speed`, `fmt.duration(s)`, `fmt.durationShort(s)`, `fmt.elevation(m)`, `fmt.hr`,
  `fmt.energy`, `fmt.weight`, `fmt.temperature`, `fmt.date(ts, tzMin, style)` (the record's own zone),
  `fmt.browserDate(ts)` (times without a zone of their own: jobs, syncs), `fmt.day('YYYY-MM-DD', style)`,
  `fmt.dayHint` / `fmt.dayRange` / `fmt.dateRange` (with the year only where it is not the current one or the range
  spans years), `fmt.relative(ts)`, `fmt.num/int/pct/compact/signed`. It respects metric/imperial and the locale (de:
  "5,21 km"). Read numbers the user typed with `fmt.parseNumber(text)` (the locale's separators; NaN when it is none),
  never `Number(text)`. Pace or speed: `showsPace(sport)`, `speedLabel(t, sport)`, `speedFormat(fmt, sport)` from the
  same file — one rule for every chart, table and comparison.
- **Dates**: `src/lib/time.ts` (`dayKey(ts, tzMin)`, `todayKey()`, `addDays`, `startOfWeek(day, weekStart)`, `eachDay`, …).
  Respect `settings.weekStart` from `useSettings()`.
- **i18n**: every visible string goes through `const t = useT()`; feature strings live in `features/<name>/messages.ts`
  (`en` + `de`, nested). Plurals: `{ one: '…', other: '…' }` + `t(key, { count })`. `t()` writes numeric variables the
  way the locale does (`1,234` / `1.234`, at most 3 decimals), so pass numbers (`{ count: n }`), not `fmt.int(n)`;
  calendar years must be named `year`, `prev` or `…Year` (printed as they are) or passed as strings. Shared strings:
  `t('common.…')` (src/lib/messages.ts). Workout titles: `workoutTitle(w, lang)` from @cadence/shared. `createT(lang,
  locale, namespaces)` is the pure `t()` for tests.
- **URL state**: filters that belong in the address go through `useUrlParams(apply?)` (`src/lib/urlParams.ts`) →
  `[params, patch, clear]`; `null` or `''` deletes a key, and changes replace the history entry.
- **Files**: save what the page makes (share image, CSV) with `saveFile(filename, text | blob, type)`
  (`src/lib/download.ts`): the apps save it themselves, browsers download a `blob:` link.
- **Per-frame values** (replay time, time-lapse position): a `Store` from `src/lib/store.ts`; maps and chart overlays
  subscribe imperatively, text re-renders throttled (`useThrottledStore`). Per-viewer conveniences (a remembered tab or
  filter) use `useStoredState` (`src/lib/storage.ts`), which never throws.
- **Sports**: `SportIcon`, `SportBadge`, `sportLabel`, `sportColorVar(sport)` (DOM) / `sportColor(theme, sport)` (charts),
  `sortSports()` (src/lib/sports.tsx). Sport colors are fixed per sport — never assign colors by rank.
- **Charts** (`src/components/charts`): ECharts is loaded modularly — a new chart type or option component must be
  registered in `EChart.tsx` (`echarts.use`), unregistered ones are silently ignored. Pointer positions are corrected
  for page zoom there too (`pointer.ts`); use `pointerInElement` for own pointer math instead of `offsetX`.
  `<EChart option=… height=…/>` + builders in `options.ts` (`timeAxis`, `valueAxis`, `categoryAxis`, `axisTooltip`,
  `itemTooltip`, `tooltipHtml`, `lineSeries`, `areaSeries`, `barSeries`, `stackedBarSeries`, `scatterSeries`,
  `legend`, `grid`) and `const theme = useChartTheme()` for colors (`theme.series[0..7]`, `theme.seq`, `theme.seqBlue`,
  `theme.zones`, `theme.diverging`, `theme.status`). `EChart` localizes value axes and month / weekday names by
  itself (a custom `axisLabel.formatter` wins); changing the language re-creates the chart, so `onReady` runs again.
  Health measures keep a fixed color everywhere: `measureColor(theme, key)` (`measures.ts`). Wrap charts in
  `<ChartCard title … table={…}>` and provide the table view; `table` may be a function, called only while the table
  is open (use it for long tables). Also `CalendarHeatmap`, `Sparkline`.
  Rules (validated palette, see dataviz guidance): one y-axis per chart (never dual axis — use two charts); categorical
  colors assigned by entity in fixed order, max 8, fold the rest into "other"; sequential = one hue; HR zones use
  `theme.zones`; legends for ≥ 2 series; tooltips on everything; text never in series colors; thin marks.
- **Maps** (`src/components/map`): `<BaseMap bounds=… onStyleLoad={(map) => …}/>` follows the user's map style and
  theme, has a style switcher + 3D terrain toggle; its `terrain` prop applies terrain without moving the camera. Add
  sources/layers in `onStyleLoad` (called again after every style load: a style or theme switch, and the style MapLibre
  rebuilds after a lost WebGL context). Overlays that change with React state use `useMapOverlay()` +
  `useOverlayEffect(overlay, draw, deps)` (`useMapOverlay.ts`): they draw only while the style is ready (`isStyleReady`
  / `whenStyleReady` in `layers.ts`) and again after every style load. Same file: `useOverlayStore` (per-frame values
  without renders), `useFitBounds`, `useMapPopup`, `shownStylePref(map)` for overlay colors on the basemap actually
  shown. Helpers:
  `setGeoJSON`, `addRouteLayers`, `gradientExpression`, `addCircleLayer`, `lineFeature`, `pointFeature`,
  `featureCollection`, `fitTo`, `overlayColors(pref, theme)`. For lists use `<RouteThumbnail polyline/>` (the route
  over a map image rendered once by one hidden map and cached, `snapshot.ts`) — never many WebGL maps on one page.
  `decodePolyline` in `src/lib/polyline.ts`.
- **Native shell**: `src/lib/native.ts` (`isNativeShell`, `shellInfo`, `postNative`, `onNativeImport`,
  `onNativeCancelled`), typed by `packages/shared/src/shell.ts`.
- **Layout**: grid items may shrink below their content (base rule in `styles.css`), so a long line never widens a
  column; check pages at phone width (390 px) too. The content area is the viewport minus a 240 px sidebar (784 px at a
  1024 px window). Use `minmax(0,1fr)` instead of `1fr` in custom grid templates and `min-w-0` on flex children so long
  content never forces horizontal scrolling; put fixed-width side columns behind `xl:`. Check pages at 1024 px and
  ~1440 px. Custom breakpoints must be in rem (`min-[85rem]:`): px arbitrary breakpoints sort before `lg:` and lose.
- **Pitfalls**: MapLibre's stylesheet (imported with its theme overrides in `components/map/map.css`, loaded by
  `BaseMap`) is not in a cascade layer, so its rules beat Tailwind utilities on MapLibre elements (use inline styles
  there); a map without `BaseMap` must import `map.css` itself. ECharts 6 shrinks grids whose labels touch the edge
  unless `containLabel` is set — use `outerBoundsMode: 'none'` on grids that need a fixed plot area (e.g. stacked,
  synced charts). `@cadence/shared` is marked `sideEffects: false`: a shared module must not rely on import-time side
  effects.

## Shells

What the server, the web UI and the apps agree on lives in `packages/shared/src/shell.ts`: the restart exit code (`75`),
the listening line (`CADENCE_LISTENING {"url","port"}`), the messages the page posts (`pickImportFile {folder?}`,
`importReady`, `openDataFolder`, `saveFile {filename, base64}`, `connectServer {url}`), the events the apps answer with
(`cadence:native-import {path, confirm?}`, `cadence:native-cancelled {type}`), the file types `saveFile` accepts
(`SAVE_FILE_TYPES`) and `ShellInfo`. The server, `apps/web/src/lib/native.ts` and `apps/desktop/src/shell-contract.ts`
import it; the Mac app keeps a copy in `apps/macos/Sources/Cadence/ShellContract.swift`, which
`apps/desktop/test/shell-contract.test.ts` compares.

Both apps start the server with `CADENCE_MODE=desktop`, `HOST=127.0.0.1`, `CADENCE_DATA_DIR`, `CADENCE_WEB_DIR`,
`CADENCE_PARENT_PID` and `NODE_ENV=production`, on the port of the last launch (first `28787`; once more with `PORT=0`
when that port is taken), read the port from the listening line and start it again on exit code 75. The bridge works
only for the main frame of the server's own pages; links to other sites open in the browser. No URL can start a local
import: the app hands a picked or dropped file to its import page (`importReady` → `cadence:native-import`), with
`confirm` when another page was open. `saveFile` keeps the page's file name (folders stripped) and only the types in
`SAVE_FILE_TYPES`. Settings → Server (`connectServer`) shows a remote server after a native confirmation; the apps
then upload files to it instead of passing paths.

- **Mac** (`apps/macos`): data in `~/Library/Application Support/Cadence`, log `~/Library/Logs/Cadence/server.log`
  (File → Show Server Log), both under `CADENCE_DATA_DIR` when it is set. The import panel and the Dock icon take
  `export.zip`, `export.xml`, the unzipped folder and `.fit` files. `scripts/build-macos.sh` bundles the official Node
  runtime and signs ad hoc. Tests: `swift test --package-path apps/macos`.
- **Linux / Windows** (`apps/desktop`): `src/main.ts` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` on
  `resources/server/index.js`; data in `~/.config/Cadence` or `%APPDATA%\Cadence`, log `<data>/logs/server.log`
  (Help → Server log). File → Import… (Ctrl+O) and File → Import folder… (Ctrl+Shift+O). Electron has no install
  script, so `npm ci` does not download it: `electron .` (e.g. `npm run desktop`) fetches it on first run, and
  electron-builder brings its own copy for packaging.

## Testing

`npm test` runs Vitest in every workspace that has a `test` script, all in a Node environment:

- `packages/shared/test` — units, sports, health catalogue.
- `apps/server/test` (plus `src/**/*.test.ts`; forks pool, 60 s timeout) — API, importer, derive and feature tests.
  API tests (e.g. `test/api.test.ts`) generate data with `generateSample({ out, size: 'small', seed, endDate })` from
  `scripts/sample/generate`, then `loadConfig({ CADENCE_DATA_DIR: tmp, CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' })`,
  `openDb` + `migrateAll`, `buildApp(config, db, { jobRunner: 'inline' })` and `app.inject(…)`; pin dates with
  `?today=YYYY-MM-DD`. Fixtures: `test/health-fixture.ts`, `test/maps-fixtures.ts`, `test/fit-fixture.ts`. A few
  tests import DOM-free web helpers by relative path (`navOrder`, the share image layout).
- `apps/web/test` — pure logic of `lib/`, `components/` and `features/*/lib` with the `@/` alias; no DOM, React
  components are not rendered (keep such logic in plain modules). Small fakes for MapLibre and React hooks live in
  `test/features/maps/`.
- `apps/desktop/test` — the Electron main process's logic that needs no Electron (server lifecycle, URL policy,
  import picker, shell contract).
- The Mac shell has XCTest (`swift test --package-path apps/macos`), run by CI's Mac job.

One file: `cd apps/server && npx vitest run test/<file>.test.ts` (likewise in the other workspaces). Pages are checked
by hand at 390 px, 1024 px and ~1440 px with the sample data; CI builds both apps and starts them once
(`CADENCE_DESKTOP_SMOKE`, `CADENCE_SMOKE`).

## Developer scripts

The everyday commands (`npm run dev`, `sample`, `import`, the checks) are in the README. Beyond them:

| Command | What |
| --- | --- |
| `npm run sample -- [--size small\|medium\|large] [--seed N] [--end YYYY-MM-DD] [--out path]` | Synthetic Apple Health export of one athlete in Vienna (70 days / 2 years / 5 years) → `data/sample/export.zip` |
| `npm run import -- <export.zip \| folder \| export.xml \| .fit> [--db path]` | Import + derive in-process into `CADENCE_DATA_DIR` or the given database |
| `npm run coros-probe -w @cadence/server` | Saves raw Training Hub responses of the connected COROS account (the login stored in the data folder) to `connect/coros/probe-<day>.json` in the data folder. Read-only towards COROS; the file holds health data |
| `cd apps/server && npx tsx scripts/bench-xml.ts <export.zip>` | Benchmark of the XML scanner |
| `npm install --no-save all-the-cities@3.1.0`, then `node apps/server/scripts/build-places.mjs <path to all-the-cities>` | Rebuilds the bundled gazetteer `apps/server/src/lib/places/places.bin.gz` (GeoNames, CC BY 4.0) |
| `npm run format` | Prettier over the whole repository. Most files are not Prettier-formatted: format only the lines you change and never commit a whole-file reformat |
