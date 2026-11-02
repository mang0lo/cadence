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
  what is new.
- **Activities** with map playback, synced charts, splits, zones, best efforts and analysis.
- **Progress over time**: volume, trends, personal records, fitness & freshness, VO2max.
- **Consistency**: calendar heatmap, streaks, goals, trophies and a yearly review.
- **Maps**: personal heatmap, explorer tiles, recurring routes and personal segments.
- **Health**: sleep, heart, body and a data explorer for every metric in the export.
<!-- FEATURES:END -->
- **Bilingual** (Deutsch / English), metric or imperial units, light & dark mode.
- **Private by design**: no account, no cloud, no tracking. Maps load public map tiles; nothing else leaves the machine.

## Install the Mac app

Requirements: macOS 14+, [Node.js](https://nodejs.org) 24+ and the Xcode Command Line Tools (`xcode-select --install`)
to build it.

```bash
git clone https://github.com/Devine-Coder/cadence.git && cd cadence
npm install
npm run mac -- --install      # builds build/Cadence.app and copies it to /Applications
```

`npm run mac -- --dmg` also produces a disk image. The app bundles the official Node.js runtime, so the built app
runs on Macs without Node. Data lives in `~/Library/Application Support/Cadence`, logs in `~/Library/Logs/Cadence`.

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
- Point the Mac app at the server via **Cadence → Connect to Server…**.
- Every `v*` tag builds a DMG and pushes `ghcr.io/devine-coder/cadence` (see `.github/workflows/release.yml`).

Configuration is done with environment variables (`PORT`, `HOST`, `CADENCE_DATA_DIR`, `CADENCE_PASSWORD`,
`CADENCE_IMPORT_DIR`, …) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#runtime-modes--configuration).

## Development

```bash
npm install
npm run sample                              # synthetic 2-year Apple Health export (Vienna) → data/sample/export.zip
npm run import -- data/sample/export.zip    # ~8 s
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
- Native iOS companion reading HealthKit directly
- Apply privacy zones to shared/exported routes

## License

[MIT](LICENSE). Map data © OpenStreetMap contributors, OpenFreeMap, CARTO; imagery © Esri; terrain © Mapzen/AWS.
Not affiliated with Strava or Apple.
