<p align="center">
  <img src="apps/web/public/favicon.svg" width="88" alt="Cadence logo" />
</p>

<h1 align="center">Cadence</h1>

<p align="center">
  A self-hosted, Strava-style training log fed by your <b>complete Apple Health export</b> — and by COROS watches
  and FIT files.<br/>
  A desktop app for Mac, Linux and Windows; the same code runs as a server for your browser, anywhere.
</p>

## Highlights

<!-- FEATURES:START -->
- **Imports everything** in Apple Health's export: every record type, workouts (incl. iOS 16+ multi-sport
  activities and events), GPS routes, ECGs, activity rings, blood-pressure correlations, audiograms and clinical
  records — lossless, streamed (multi-GB exports in seconds) and idempotent: re-importing a newer export only adds
  what is new. After every import a **what's new** summary lists the new activities, records, trophies, explorer
  tiles, route best times and segment PRs.
- **Other watches**: connect a **COROS** account (activities, resting heart rate, HRV, sleep with stages, VO2max,
  steps, daily goals) or import **FIT files** from any watch. *Settings → My watch* decides which source wins when
  Apple Health and the watch recorded the same thing; duplicates of a workout are merged.
- **Dashboard**: activity feed with route thumbnails, PR medals and sport-specific stats; athlete card with this
  week and all-time totals; widgets for this week, readiness, fitness & form, power, streaks, goals, the last 18
  weeks, a health snapshot and explorer tiles.
- **Activities**: filterable, sortable list (sport, period, search, GPS) with quick actions and **CSV export**; every
  activity shows where it took place (offline place names, "Rostock → Berlin" for one-way trips) and small tags for
  the estimated **kind of training** (intervals, long, tempo, easy, recovery), the **country** and the
  **temperature**. The search also finds every place and country a route passes through. The activity page has a
  **map replay** (1×–300×, follow camera, 3D flyover, route colored by pace, heart rate, grade or HR zones), synced
  elevation / pace / heart-rate / cadence / power charts with section selection, splits, laps, HR zones, best efforts
  with medals, aerobic decoupling, efficiency factor, grade-adjusted pace, power (NP, IF, TSS, peaks), climbs,
  distributions, a comparison with similar activities, the route rank and segment efforts, and GPX export.
  **Compare two activities** on one map with a synchronized replay and the time gap over the distance, and create a
  **share image** (map, route, the stats you pick and small charts; privacy zones cut out).
- **Progress over time**: weekly / monthly / yearly volume, year over year, period comparison, per-activity trends
  (pace, heart rate, efficiency, cadence, power, running dynamics) with trend lines, pace at a given heart rate and
  intensity distribution; records per distance with progression, top 10 and a race predictor; fitness, fatigue &
  form with ramp-rate warnings, VO2max with fitness level, resting HR and HRV; a **power curve** (1 s – 5 h) with FTP
  estimate, critical power and FTP history.
- **Consistency**: calendar heatmap with day details, daily / weekly / activity-ring streaks, a consistency score,
  active days per month, a weekday × hour punchcard and ring history; daily, weekly, monthly and yearly goals per
  sport (distance, time, calories, elevation, activities …) that fill in from your activities or are checked off by
  hand, with on-track projection, history and suggestions; about 100 trophies (bronze / silver / gold) and monthly
  challenges; a Wrapped-style year in review.
- **Maps**: personal heatmap with glow themes and time-lapse, explorer tiles (zoom 14 and 17, max square and max
  cluster), automatically detected recurring routes with time trends, and personal segments with leaderboards that
  are matched against all your activities.
- **Health**: a daily **readiness** estimate from HRV, resting HR, sleep and training load against your personal
  baselines; key metrics with 30-day trends; sleep (nights merged from all sources, stages, hypnogram, regularity,
  overnight vitals); heart (resting and walking HR, HRV, recovery, daily range, intraday, notifications); body
  (weight, BMI, body fat, blood pressure); an explorer for every record type in the export and an ECG viewer on
  paper grid.
<!-- FEATURES:END -->
- **English and German** interface, metric or imperial units, light & dark mode; works on phone-sized windows too.
- **Private by design**: no account, no cloud, no tracking. Maps load public map tiles (no API key); place names
  come from a bundled offline gazetteer. Nothing else leaves the machine — unless you connect a COROS account, which
  talks to COROS.

## Install

Download from the [latest release](https://github.com/mang0lo/cadence/releases/latest)
(release notes: [CHANGELOG.md](CHANGELOG.md)):

| System | File | Notes |
| --- | --- | --- |
| **macOS** 14+, Apple silicon | `Cadence-<version>.dmg` | Drag Cadence into Applications. Not notarized yet: on the first launch open **System Settings → Privacy & Security** and click **Open Anyway**. |
| **Linux** x86-64 | `Cadence-<version>-linux-x86_64.AppImage` or the `.deb` | `./install.sh path/to/Cadence.AppImage` adds the AppImage to your launcher (see below). |
| **Windows** x64 | `Cadence-Setup-<version>-win-x64.exe` or the portable `.exe` | Not code-signed: SmartScreen may ask before the first start. |
| **Server** | `ghcr.io/mang0lo/cadence` | See [Run it as a server](#run-it-as-a-server). |

### Build the Mac app yourself

Requirements: macOS 14+, [Node.js](https://nodejs.org) 24+ and the Xcode Command Line Tools
(`xcode-select --install`):

```bash
git clone https://github.com/mang0lo/cadence.git && cd cadence
npm install
npm run mac -- --install      # builds build/Cadence.app and copies it to /Applications
```

`npm run mac -- --dmg` also produces a disk image. The app bundles the official Node.js runtime, so the built app
runs on Macs without Node. Data lives in `~/Library/Application Support/Cadence`, logs in `~/Library/Logs/Cadence`.

### Build the Linux and Windows apps yourself

The same app for Linux and Windows is built with Electron (requirements: [Node.js](https://nodejs.org) 24+):

```bash
npm install
npm run desktop          # build and open it
npm run desktop:dist     # Linux: build/desktop/Cadence-<version>-linux-x86_64.AppImage and .deb
npm run desktop:win      # Windows: installer + portable .exe (on Linux this needs Wine)
```

Data lives in `~/.config/Cadence` (Linux) or `%APPDATA%\Cadence` (Windows), the server log in its `logs` folder.

On Linux, `./install.sh` installs the built AppImage for your user (app, `cadence` command, launcher entry and icon; it
shows up in Noctalia, GNOME, KDE, rofi … right away). `./install.sh --build` builds it first, `./install.sh
path/to/Cadence.AppImage` installs a downloaded one, `./install.sh --uninstall` removes it.

## Import your data

**Apple Health**

1. iPhone → **Health** app → tap your profile picture → **Export All Health Data**.
2. Send the `export.zip` to your computer (AirDrop, Files, iCloud Drive).
3. In Cadence: **File → Import Apple Health Export…** (⌘I) on the Mac, **File → Import…** (Ctrl+O) on Linux and
   Windows, or drag the zip into the Import page (on the Mac also onto the Dock icon).

**Other watches**: drop `.fit` files (or a zip of them) into the Import page, or connect a COROS account on the
**Watches** page — new activities and health values are then synced automatically. COROS has no public API for this:
Cadence uses the same private interface as COROS' own web app, which can change at any time.

Re-import a newer export whenever you like — duplicates are detected, and a summary shows what is new.
**Import → Rebuild analysis** recomputes all statistics (heart-rate setting changes are applied automatically).

## Run it as a server

The desktop apps are just a window around a normal web server, so moving to a server needs no code changes:

```bash
cd deploy
CADENCE_PASSWORD=choose-something docker compose up -d     # → http://<server>:8787
```

- Data is stored in the `cadence-data` volume; new `export.zip` files dropped into `deploy/import/` are imported
  automatically.
- `CADENCE_PASSWORD` protects the server with one password (repeated wrong passwords are locked out for a few
  minutes). Put it behind HTTPS (a reverse proxy) before you expose it to the internet.
- While the repository is private, `docker login ghcr.io` with a token that may read packages before pulling the
  image; `docker compose up -d --build` builds it from the source instead.
- **Move your data**: Settings → *Backup & moving to a server* → download the backup in the app, restore it on the
  server (keeps renamed activities, goals and segments; watch-account logins are not part of a backup).
- Point the desktop app at the server in **Settings → Server** (Mac also **Cadence → Connect to Server…**).

Configuration is done with environment variables (`PORT`, `HOST`, `CADENCE_DATA_DIR`, `CADENCE_PASSWORD`,
`CADENCE_IMPORT_DIR`, …) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#runtime-modes--configuration).

## Development

```bash
npm install
npm run sample                              # synthetic 2-year Apple Health export (Vienna) → data/sample/export.zip
npm run import -- data/sample/export.zip    # ~10 s (import + every analysis step)
npm run dev                                 # API on :8787 + web UI on http://localhost:5173
npm run typecheck && npm test && npm run build
```

| Path | |
| --- | --- |
| `packages/shared` | API contract (TypeScript types), sport catalogue, units |
| `apps/server` | Fastify + `node:sqlite`, Apple Health importer (worker thread), analytics, feature modules |
| `apps/web` | React 19, Vite, Tailwind 4, ECharts, MapLibre |
| `apps/macos` | Native SwiftPM shell (WKWebView, native menus and import panel) |
| `apps/desktop` | Electron shell for Linux and Windows |
| `deploy` | Dockerfile and docker-compose |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (conventions, feature modules, data model) and
[docs/APPLE_HEALTH.md](docs/APPLE_HEALTH.md) (the export format and how it maps to the database).

**Releases**: set the version (`npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`), add
a `## [x.y.z]` section to [CHANGELOG.md](CHANGELOG.md) (it becomes the release notes), merge to `main`, then publish a
release with the tag `v<x.y.z>` on GitHub (or run the **Release** workflow from the Actions tab). The workflow
builds the DMG, the Linux and Windows apps and the `ghcr.io/mang0lo/cadence` image.

## Roadmap

- Multi-user accounts and sharing on the server (the schema is already athlete-scoped)
- Live sync from the iPhone (e.g. via the *Health Auto Export* app's REST integration) instead of manual exports
- Native iOS companion reading HealthKit directly (automatic sync to the server)
- Imports for other common health devices and services, next to Apple Health and COROS / FIT files: Garmin Connect,
  Polar Flow, Suunto, Wahoo, Fitbit, Samsung Health / Google Health Connect, Oura, Whoop, Withings (scales, blood
  pressure) and GPX / TCX files from any app
- Regions (states, provinces) next to countries, and your own tags on activities
- Apply privacy zones to GPX exports (share images already use them)

## License

[MIT](LICENSE). Map data © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap; imagery © Esri; terrain © Mapzen/AWS.
Place names: [GeoNames](https://www.geonames.org) (CC BY 4.0), bundled offline — positions are never sent anywhere.
Not affiliated with Strava, Apple or COROS.
