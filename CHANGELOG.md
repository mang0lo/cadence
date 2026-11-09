# Changelog

All notable changes to Cadence. Versions follow [semantic versioning](https://semver.org); every `v*` tag builds a
release (see `.github/workflows/release.yml`), whose notes are taken from the matching section below.

## [0.3.0] – 2026-11-06

Other watches (COROS, FIT files), Cadence for Linux and Windows, a much more flexible share image and the apps can
show a Cadence server.

> 🇩🇪 **Neu in 0.3.0:** COROS-Uhren (Aktivitäten, Gesundheitswerte, Schlaf) und FIT-Dateien, Einstellung „Meine Uhr“,
> Cadence als App für Linux und Windows, Teilen-Bild mit frei wählbaren Werten (z. B. Pace *und* Tempo), kleinen
> Diagrammen und schaltbarer Strecke / Datum / Ort, **Einstellungen → Server** zum Verbinden der App mit einem
> Cadence-Server (z. B. Docker), Version in der Titelleiste.

### Install

- **Mac app**: `Cadence-0.3.0.dmg` below (macOS 14+, Apple silicon; not notarized: **System Settings → Privacy &
  Security → Open Anyway**).
- **Linux**: `Cadence-0.3.0-linux-x86_64.AppImage` or the `.deb` below; `./install.sh path/to/Cadence.AppImage` adds it
  to your launcher.
- **Windows**: the `Cadence-Setup-0.3.0.exe` installer or the portable `.exe` below.
- **Server**: `ghcr.io/mang0lo/cadence:v0.3.0` (also `:latest`).

### Added

- **Other watches**: connect a **COROS** account (activities as FIT files, resting heart rate, HRV, sleep with stages,
  VO2max, steps, daily goals as activity rings), or import **FIT files** from any watch. **Settings → My watch** chooses
  which source wins when Apple Health and the watch record the same thing; duplicates of the same workout are merged.
  Pages show the source of their data and only appear when there is data.
- **Linux and Windows apps** (Electron, same features as the Mac app): AppImage and .deb, installer and portable .exe;
  `install.sh` for Linux launchers. Releases now build all platforms.
- **Share image**: every value can be turned on or off (distance, moving / elapsed time, pace **and** speed, elevation,
  heart rate, power, cadence, calories, effort — up to six), up to three **small charts** (elevation, pace / speed,
  heart rate, power) along the activity, and the route line, date and place can be hidden; the choice is remembered
  per sport.
- **Settings → Server** in the Mac and desktop apps: show a Cadence server (e.g. Docker on a home server) instead of
  the built-in one, with a reachability check, and go back with one click. A server that does not answer offers
  "Try again" / "Use built-in server".
- **Version in the title bar** of the Mac and desktop apps; Settings → About shows the app and the server version.
- **Search by place**: the activity search also finds where an activity started or ended ("Warnemünde", "Rostock"),
  with German names for places stored in English ("Wien").

### Security

- **Login brake** on password-protected servers: eight wrong passwords from one address lock its logins for five
  minutes; sessions that are logged in keep working.
- **Backups no longer contain the COROS login** (email, password hash, tokens) — connect again on the Watches page
  after restoring a backup.
- Baseline protection headers (no embedding in other sites, no MIME sniffing, no activity URLs in referrers).

### Fixed

- Import in the apps while connected to a remote server opens the upload page (a remote server cannot read files on
  your computer).
- GPX file names keep umlauts and other letters ("Übungsfahrt-2026-06-20.gpx").
- Web app files are cached properly on servers (faster reloads; updates are picked up right away).
- Screen-reader labels of the theme switch, the menu button and loading spinners are translated.

## [0.2.1] – 2026-11-03

> 🇩🇪 **Karten in den Vorschauen ohne API-Key:** CARTO verlangt inzwischen einen API-Key und zeigte nur noch
> „API KEY REQUIRED“. Vorschauen, Teilen-Bild und die dunkle Karte nutzen jetzt OpenFreeMap – kostenlos, ohne
> Anmeldung. Jede Vorschau wird einmal gerendert und als Bild gespeichert.

### Install

- **Mac app**: download `Cadence-0.2.1.dmg` below and drag Cadence into Applications (your data is kept).
- **Server**: `ghcr.io/mang0lo/cadence:v0.2.1` (also `:latest`).

### Fixed

- **Map backgrounds of route previews and share images** showed "API KEY REQUIRED" tiles: CARTO's basemaps need an
  API key now. Previews and share images are rendered from the free OpenFreeMap vector maps instead (the same as the
  interactive maps) — once per preview, then kept as an image in the browser. Satellite previews keep Esri imagery.
- **Dark map style** uses OpenFreeMap as well (falls back to the light map if a style cannot be loaded).

## [0.2.0] – 2026-11-03

Compare activities, share them as an image, a power curve with FTP estimate, a daily readiness score and a summary
of what is new after every import — plus the fixes from testing 0.1.0.

> 🇩🇪 **Neu in 0.2.0:** Zwei Aktivitäten vergleichen (wer war wo vorne), Teilen-Bild mit Karte und Werten,
> Leistungskurve mit FTP-Schätzung, tägliche Erholungs-Einschätzung, „Was ist neu“ nach jedem Import, Ort an jeder
> Aktivität, CSV-Export, Kartenhintergrund in den Vorschauen, Marathon- und Ironman-Ziele. Behoben: Trainings, die
> pausiert und woanders fortgesetzt wurden (z. B. nach einer Zugfahrt), ziehen keinen Strich mehr über die Karte, und
> Strecken heißen nach dem echten Ort statt immer „Berlin“.

### Install

- **Mac app**: download `Cadence-0.2.0.dmg` below and drag Cadence into Applications (replaces 0.1.0, your data is
  kept). Requires macOS 14+ on Apple silicon. Not notarized yet: on first launch open **System Settings → Privacy &
  Security** and click **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Cadence.app`).
- **Server**: `ghcr.io/mang0lo/cadence:v0.2.0` (also `:latest`) — the repository moved to `mang0lo/cadence`, so the
  image moved as well.
- After the update Cadence rebuilds its analysis once in the background (progress on the Import page).

### Fixed

- **Workouts paused and continued elsewhere** (e.g. a train ride while the workout was paused) no longer draw a line
  across the map or count the jump as distance, climbing, explorer tiles, splits or best efforts. The parts are shown
  separately: activity map with part chips, gaps in the charts, heatmap and time-lapse, previews, one GPX segment per
  part; segments cannot span the jump.
- **Route names** come from the real place of the start (offline GeoNames gazetteer, nothing leaves your machine)
  instead of the time-zone city — before, every route in Germany was called "Berlin". Routes from A to B are named
  "A → B"; German names for big cities (Wien, München …).

### Added

- **Compare two activities**: pick another effort of the same route, a similar activity or any activity of the
  sport; both routes on one map with a synchronized replay ("A ahead by 67 m"), the time gap over the distance, pace,
  heart rate and elevation of both, and a side-by-side summary with the differences.
- **Share image**: a picture of an activity with the map, route and key stats — square, portrait or story format,
  map / plain / transparent sticker background, light or dark; privacy zones are cut out of the route by default.
  Save, copy or share it (the Mac app saves it to Downloads).
- **Power curve** (Progress → Power curve): best average power from 1 s to 5 h for rides and runs with power, per
  period and against your all-time bests or the previous period, in W or W/kg; an **FTP estimate** (95 % of the best
  20 minutes) you can adopt with one click, critical power and W′ when the data fits, and the FTP history.
- **Readiness** (Health → Readiness): a daily 0–100 estimate from HRV, resting heart rate, sleep, training load and
  overnight vitals, each compared with your own normal range of the last 60 days, with the factors, a trend and a
  dashboard widget. An estimate, not medical advice.
- **What's new after an import**: the import screen and a note in the sidebar show the new activities by sport, the
  newest ones, new personal records and podiums, trophies, explorer tiles, recurring routes, route best times and
  segment PRs.
- **Place of every activity** in the feed, the activity list and the activity page ("Warnemünde", "Rostock → Berlin"
  for one-way activities), from the offline gazetteer.
- **CSV export** of the activity list (current filters, your units and language; German files open directly in Excel).
- **Map background in route previews** (feed, lists, routes, segments, records), following your map style and theme;
  can be turned off in the settings (no tile requests).
- **Goals for a single activity** ("longest activity"): run a marathon this year, swim 3.8 km, ride 180 km … with quick
  picks for 5K to 100 km and the Olympic / 70.3 / Ironman distances; **bigger goals** presets per metric and period;
  a suggestion for your next classic distance.
- **More trophies**: Ironman bike, 70.3 and Olympic legs, triathlon days (all three legs on one day, also from
  multisport workouts), 100 km ultra, 300 km ride, 10 km swim and higher tiers for activities, distance, climbing,
  streaks and rings.

### Changed

- After an update Cadence rebuilds the analysis once in the background (see the Import page for progress).
- Releases can be started from the Actions tab; the release page no longer waits for the macOS build.

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
