<p align="center">
  <img src="apps/web/public/favicon.svg" width="88" alt="Cadence logo" />
</p>

<h1 align="center">Cadence</h1>

<p align="center">
  A self-hosted, Strava-style training log fed by your <b>complete Apple Health export</b>.<br/>
  Mac app first — the same code runs as a server for your browser, anywhere.
</p>

> 🇩🇪 **Kurz:** Cadence ist ein Strava-Klon für deine eigenen Apple-Health-Daten. Exportiere auf dem iPhone
> „Alle Gesundheitsdaten“, zieh die `export.zip` in die App – fertig: Trainings mit Karten-Playback, Fortschritt über
> die Zeit, Konstanz, Bestleistungen und alle Gesundheitswerte. Läuft lokal als Mac-App (deine Daten verlassen
> nie deinen Rechner) und später unverändert per Docker auf deinem eigenen Server. Oberfläche auf Deutsch und Englisch.

## Highlights

<!-- FEATURES:START -->
- **Imports everything** in Apple Health's export: every record type, workouts (incl. iOS 16+ multi-sport
  activities and events), GPS routes, ECGs, activity rings, blood-pressure correlations, audiograms and clinical
  records — lossless, streamed (multi-GB exports in seconds) and idempotent: re-importing a newer export only adds
  what is new. After every import a **what's new** summary lists the new activities, records, trophies, explorer
  tiles, route best times and segment PRs.
- **Dashboard**: activity feed with route thumbnails, PR medals and sport-specific stats; athlete card with this
  week and all-time totals; widgets for this week, fitness & form, streaks, goals, the last 18 weeks, a health
  snapshot and explorer tiles.
- **Activities**: filterable, sortable list (sport, period, search, GPS) with quick actions and **CSV export**; every
  activity shows where it took place (offline place names, "Rostock → Berlin" for one-way trips). The activity page has a
  **map replay** (1×–300×, follow camera, 3D flyover, route colored by pace, heart rate, grade or HR zones), synced
  elevation / pace / heart-rate / cadence / power charts with section selection, splits, laps, HR zones, best efforts
  with medals, aerobic decoupling, efficiency factor, grade-adjusted pace, power (NP, IF, TSS, peaks), climbs,
  distributions, a comparison with similar activities, the route rank and segment efforts, and GPX export.
  **Compare two activities** on one map with a synchronized replay and the time gap over the distance, and create a
  **share image** (map, route and stats; privacy zones cut out).
- **Progress over time**: weekly / monthly / yearly volume, year over year, period comparison, per-activity trends
  (pace, heart rate, efficiency, cadence, power, running dynamics) with trend lines, pace at a given heart rate and
  intensity distribution; records per distance with progression, top 10 and a race predictor; fitness, fatigue &
  form with ramp-rate warnings, VO2max with fitness level, resting HR and HRV; a **power curve** (1 s – 5 h) with FTP
  estimate, critical power and FTP history.
- **Consistency**: calendar heatmap with day details, daily / weekly / activity-ring streaks, a consistency score,
  active days per month, a weekday × hour punchcard and ring history; goals with on-track projection, history and
  suggestions; about 100 trophies (bronze / silver / gold) and monthly challenges; a Wrapped-style year in review.
- **Maps**: personal heatmap with glow themes and time-lapse, explorer tiles (zoom 14 and 17, max square and max
  cluster), automatically detected recurring routes with time trends, and personal segments with leaderboards that
  are matched against all your activities.
- **Health**: a daily **readiness** estimate from HRV, resting HR, sleep and training load against your personal
  baselines; key metrics with 30-day trends; sleep (nights merged from all sources, stages, hypnogram, regularity,
  overnight vitals); heart (resting and walking HR, HRV, recovery, daily range, intraday, notifications); body
  (weight, BMI, body fat, blood pressure); an explorer for every record type in the export and an ECG viewer on
  paper grid.
<!-- FEATURES:END -->
- **Bilingual** (Deutsch / English), metric or imperial units, light & dark mode.
- **Private by design**: no account, no cloud, no tracking. Maps load public map tiles; nothing else leaves the machine.

## Install the Mac app

**Download**: get `Cadence-<version>.dmg` from the
[latest release](https://github.com/mang0lo/cadence/releases/latest) (macOS 14+, Apple silicon) and drag Cadence
into Applications. The app is not notarized yet, so macOS blocks the first launch: open **System Settings → Privacy &
Security** and click **Open Anyway**. Release notes: [CHANGELOG.md](CHANGELOG.md).

**Build it yourself** — requirements: macOS 14+, [Node.js](https://nodejs.org) 24+ and the Xcode Command Line Tools
(`xcode-select --install`):

```bash
git clone https://github.com/mang0lo/cadence.git && cd cadence
npm install
npm run mac -- --install      # builds build/Cadence.app and copies it to /Applications
```

`npm run mac -- --dmg` also produces a disk image. The app bundles the official Node.js runtime, so the built app
runs on Macs without Node. Data lives in `~/Library/Application Support/Cadence`, logs in `~/Library/Logs/Cadence`.

### Linux and Windows

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

## Import your Apple Health data

1. iPhone → **Health** app → tap your profile picture → **Export All Health Data**.
2. Send the `export.zip` to your Mac (AirDrop, Files, iCloud Drive).
3. In Cadence: **File → Import Apple Health Export…** (⌘I), drag the zip into the window, or drop it on the Dock icon.

Re-import a newer export whenever you like — duplicates are detected. **Import → Rebuild analysis** recomputes
all statistics (heart-rate setting changes are applied automatically).

## Run it as a server (later)

The Mac app is just a window around a normal web server, so moving to a server needs no code changes:

```bash
cd deploy
CADENCE_PASSWORD=choose-something docker compose up -d     # → http://<server>:8787
```

- Data is stored in the `cadence-data` volume; new `export.zip` files dropped into `deploy/import/` are imported
  automatically.
- **Move your data**: Settings → *Backup & moving to a server* → download the backup in the Mac app, restore it on
  the server (keeps renamed activities, goals and segments).
- Point the Mac or desktop app at the server in **Settings → Server** (Mac also **Cadence → Connect to Server…**).
- Releases: push a `v*` tag or run the **Release** workflow from the Actions tab (with the version from
  `package.json`); it builds the DMG and pushes `ghcr.io/mang0lo/cadence` (see `.github/workflows/release.yml`).

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
| `deploy` | Dockerfile and docker-compose |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (conventions, feature modules, data model) and
[docs/APPLE_HEALTH.md](docs/APPLE_HEALTH.md) (the export format and how it maps to the database).

## Roadmap

- Multi-user accounts and sharing on the server (the schema is already athlete-scoped)
- Live sync from the iPhone (e.g. via the *Health Auto Export* app's REST integration) instead of manual exports
- Native iOS companion reading HealthKit directly (automatic sync to the server)
- Imports for other common health devices and services, next to Apple Health and COROS / FIT files: Garmin Connect,
  Polar Flow, Suunto, Wahoo, Fitbit, Samsung Health / Google Health Connect, Oura, Whoop, Withings (scales, blood
  pressure) and GPX / TCX files from any app
- Apply privacy zones to GPX exports (share images already use them)

## License

[MIT](LICENSE). Map data © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap; imagery © Esri; terrain © Mapzen/AWS.
Place names: [GeoNames](https://www.geonames.org) (CC BY 4.0), bundled offline — positions are never sent anywhere.
Not affiliated with Strava or Apple.
