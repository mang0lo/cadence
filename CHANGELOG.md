# Changelog

All notable changes to Cadence. Versions follow [semantic versioning](https://semver.org); every `v*` tag builds a
release (see `.github/workflows/release.yml`), whose notes are taken from the matching section below.

## [0.1.0] – 2026-11-02

First release: a self-hosted, Strava-style training log for your complete Apple Health export.

> 🇩🇪 **Erste Version.** Exportiere auf dem iPhone „Alle Gesundheitsdaten“, zieh die `export.zip` in Cadence –
> Trainings mit Karten-Replay, Fortschritt über die Zeit, Konstanz, Bestleistungen und alle Gesundheitswerte.
> Läuft lokal als Mac-App (deine Daten bleiben auf deinem Rechner) oder per Docker auf deinem eigenen Server.
> Oberfläche auf Deutsch und Englisch.

### Install

- **Mac app**: download `Cadence-0.1.0.dmg` below and drag Cadence into Applications. Requires macOS 14+ on a Mac
  with Apple silicon (M1 or newer). The app is not notarized yet: on first launch macOS blocks it — open
  **System Settings → Privacy & Security** and click **Open Anyway** (or run
  `xattr -dr com.apple.quarantine /Applications/Cadence.app`).
- **Server**: `ghcr.io/devine-coder/cadence:v0.1.0` (also `:latest`) — see *Run it as a server* in the README.
  While the repository is private, `docker login ghcr.io` with a token that can read packages first.

### Features

- **Apple Health import**: every record type, workouts incl. multi-sport activities and events, GPS routes, ECGs,
  activity rings, blood pressure, audiograms and clinical records — streamed, multi-GB exports in seconds,
  re-imports only add what is new. Import window (⌘I), drag & drop, watch folder on servers.
- **Dashboard**: activity feed with route thumbnails, PR medals and sport-specific stats; athlete card; widgets for
  this week, fitness & form, streaks, goals, the last 18 weeks, a health snapshot and explorer tiles.
- **Activities**: filterable, sortable list with quick actions. Activity page with **map replay** (1×–300×, follow
  camera, 3D flyover, route colored by pace / heart rate / grade / HR zones), synced elevation, pace, heart-rate,
  cadence and power charts with section selection, splits, laps, HR zones, best efforts, decoupling, efficiency,
  grade-adjusted pace, power metrics, climbs, distributions, similar activities, route rank, segment efforts and
  GPX export.
- **Progress**: volume per week / month / year, year over year, period comparison, per-activity trends incl.
  running dynamics, pace at heart rate, intensity distribution, records per distance with progression and a race
  predictor, fitness / fatigue / form with load warnings, VO2max, resting HR and HRV.
- **Consistency**: calendar heatmap, daily / weekly / activity-ring streaks, consistency score, punchcard, ring
  history, goals with projection, about 100 trophies and monthly challenges, and a year in review.
- **Maps**: personal heatmap with time-lapse, explorer tiles (max square and cluster), recurring routes with time
  trends, and personal segments with leaderboards.
- **Health**: overview with 30-day trends, sleep (stages, hypnogram, regularity, overnight vitals), heart, body and
  blood pressure, an explorer for every metric in the export, and an ECG viewer.
- **Everywhere**: Deutsch / English, metric or imperial, light and dark mode; backup & restore to move from the Mac
  app to a server; optional password for server deployments.

### Known limitations

- Mac app: Apple silicon only and not notarized (see Install).
- Route names come from the time-zone city of the start (shown in English, e.g. "Vienna").
- One athlete per installation; multi-user accounts are on the roadmap.
