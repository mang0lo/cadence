# Changelog

All notable changes to Cadence. Versions follow [semantic versioning](https://semver.org); every `v*` tag builds a
release (see `.github/workflows/release.yml`), whose notes are taken from the matching section below.

## [Unreleased]

Mostly fixes from a review of 1.0.0: a server and apps that other websites cannot misuse, imports and analyses that
stay correct when a job is interrupted, duplicates and health values that add up, faster pages for long histories,
and texts, numbers and errors in your language.

### Updating

- **One-time rebuild**: after the update Cadence rebuilds its analysis once in the background (progress on the Import
  page), so existing activities get the corrected duplicates, cadence, start points, countries, training kinds,
  relative effort and activity analyses below. Water intake stored in imperial units is converted to litres.
- **COROS**: with *Sleep, steps & all-day heart rate* on, the first sync after the update reads the COROS app history
  once more (a few minutes) to repair stored activity rings.
- **Password-protected servers**: browsers log in once more (every login now gets a session of its own).
- **Self-hosting** — check your setup (see *Run it as a server* in the README):
  - A server started without `CADENCE_PASSWORD` (e.g. `npm start`) now listens on `127.0.0.1` unless `HOST` is set,
    and warns at startup when it is reachable from the network without a password. The Docker image sets
    `HOST=0.0.0.0` itself.
  - Set `TZ` to your time zone (e.g. `TZ=America/New_York` in `deploy/.env`): the compose file defaults to UTC instead
    of Europe/Vienna, without a warning (a server started without any `TZ` warns at startup). The zone decides
    "today", sleep nights, the intraday heart rate and FIT workouts without a local time.
  - Behind a reverse proxy, set `CADENCE_TRUST_PROXY` to the proxy's address: only then does the login brake count each
    client on its own instead of everyone as the proxy. A proxy that rewrites the `Host` header should pass the
    original one (nginx: `proxy_set_header Host $host`), or older browsers cannot save changes.
  - Servers without a password on `127.0.0.1`, the desktop apps and `npm run dev` answer only under `localhost`,
    `*.localhost` and IP addresses; add other host names (e.g. `my-mac.local`) to `CADENCE_ALLOWED_HOSTS`.
  - A container started with `docker run` needs a restart policy (`--restart unless-stopped`): restoring a backup
    restarts the server.

### Security

- **The server password protects every API route**, however the path is written (percent-encoded or absolute-form
  request targets could get past it).
- **Login sessions**: every login gets its own random cookie. Logging out ends that session, a new `CADENCE_PASSWORD`
  ends all of them, and a stolen cookie no longer reveals the password. The cookie is marked `Secure` whenever the page
  is served over https, also behind a reverse proxy; restoring a backup logs everyone out. The login brake counts IPv6
  clients per network (/64).
- **Websites cannot use a Cadence on your computer**: the Mac and desktop apps and `npm run dev` ignore requests under
  foreign host names (DNS rebinding), and every server refuses changes (uploads, restores, edits) that other websites
  send (403; scripts using `Authorization: Bearer` are not affected).
- **Mac and desktop apps**: pages of other sites can no longer use the app's bridge, open local files or other
  programs, or save files to Downloads. No link can start the import of a file on your computer any more: the app hands
  the file you picked to its own import page, which asks first when another page was open. Switching to another server
  in Settings → Server asks for confirmation. The apps save only the images and data files a page offers (PNG, JPEG,
  CSV, GPX, TCX, JSON, TXT), never programs, scripts or web pages.
- **Server status**: `/api/status` no longer tells visitors who are not logged in how much data there is, when the last
  import ran or which version runs.
- **Imports and backups**: crafted zip files (exports or FIT files) can no longer exhaust the server's memory. A backup
  must come from Cadence, a restored backup can no longer make a server import arbitrary files on its disk, and a
  restored file that cannot be opened is set aside so that the previous database is used again.
- **COROS**: disconnecting no longer leaves the saved login readable in the database file.

### Fixed

- **Duplicates**: a session one app split in two (e.g. the Watch stopped at a café) and another app recorded whole now
  counts both halves and marks only the whole copy as the duplicate. A long workout is no longer hidden as a copy of a
  much shorter one, hiding one copy lets the other count, hidden workouts are never marked as duplicates, and an import
  decides exactly like "Rebuild analysis".
- **Analysis of activities**:
  - Relative effort, and fitness and fatigue built on it, is no longer too low when the heart-rate strap lost contact
    for a while; hidden workouts with heart-rate spikes no longer set the observed max heart rate.
  - Runs without Apple's step statistics (e.g. Strava copies) no longer show cadences like 0.6 spm; steps recorded
    across the start or end count with their share inside the workout.
  - A stale GPS position from before the start (also repeated a few times) no longer becomes the start point, place
    name or map bounds.
  - Country tags: border towns keep their own country, and every country a route passes through is tagged.
  - Interval sessions with standing recoveries or auto-pause are recognised as intervals again.
  - A ride or hike paused for a cable car, train or car ride shows no climb across the transfer; climb time, VAM and
    lap elevation gain leave it out. Lap and segment elevation gain is smoothed like the activity's, so laps add up.
  - Power above 3000 W is ignored as a sensor glitch; the power peaks of an activity equal the bests of Progress →
    Power.
  - Aerobic decoupling and efficiency factor have one definition on the activity page, in Progress → Trends and in the
    comparison with similar activities (which compares only activities measured the same way), and also appear for
    sparse GPS recordings.
  - When two activities share the exact same best effort, the medal, the PR and the rank go to the earlier one.
- **Imports**:
  - An import that was cancelled, failed or interrupted (app quit, server stop) no longer leaves health charts, the
    metric explorer, record counts or activity analyses empty or outdated: what it saved is analysed by the next job
    or when the app starts. Cancelling "Rebuild analysis" really stops it.
  - The import page shows and cancels the job that is actually running and says how many wait; imports Cadence starts
    itself (COROS sync, watch folder, a rebuild after a settings change) show the running indicator and refresh the
    pages when they finish.
  - Dropping several FIT files imports all of them, files dropped during an upload are uploaded too, and a refused
    file is named with the reason.
  - Water intake exported in imperial (UK) fluid ounces, cups or pints, US pints or decilitres is converted to litres
    instead of showing about 35 times too high.
  - ECG recordings from iPhones in any language are imported, and their classification is shown also in French,
    Spanish and Japanese.
  - `export_cda.xml` or any other XML that is not the Health app's `export.xml` fails right away with a clear message;
    a corrupt zip says "Not a readable zip file", a full disk says so, and repeated warnings show how often they
    occurred. One activity the analysis fails on no longer leaves the activities after it without their analysis.
  - Watch folder (Docker): an export whose import was interrupted is imported again (up to 3 attempts). The upload of
    a failed or cancelled import is deleted right away instead of taking up disk space until a restart.
  - Virtual rides and runs from FIT files (Zwift, MyWhoosh …) get no game-world route, places, heatmap lines or
    explorer tiles; routes crossing the 180th meridian are stored correctly.
  - "Delete all data" no longer stays armed after cancelling and cannot be sent twice.
- **COROS**:
  - Rest days no longer show closed Move / Exercise rings (ring streaks, trophies and the year in review counted them),
    and COROS rings no longer replace Apple's for good when you switch Settings → My watch back.
  - Steps, calories and active time add up in weekly and monthly health charts; the all-day heart-rate band no longer
    disappears after a rebuild or a sync.
  - Syncs log in again only when COROS rejects the token, so other COROS sessions are not signed out for nothing; after
    a refused login (e.g. a changed password) the automatic sync pauses until you connect again.
  - Activities of a sync that was cancelled or cut short are imported from the cache by the next sync, failed downloads
    are retried (after 3 h, 12 h, 1 d, 3 d and 7 d), and "Full sync" imports only what is missing.
  - Connecting for the first time rebuilds the analysis like a change of Settings → My watch, so duplicates show the
    watch's copy right away; connecting again keeps your choice for *Sleep, steps & all-day heart rate* and does not
    fetch the whole history again.
  - Login and sync errors are shown in your language; the sidebar badge, Settings and the pages update without a
    reload.
- **Activities**:
  - Activity map: the 3D flyover tilts and follows the route again; a color mode picked during the replay applies at
    once; selection stats and the replay never treat the jump between two track parts as climbing or distance.
  - Splits, laps, zones and best efforts still show when an activity's streams cannot be loaded.
  - Similar activities: "#n of m on this route" matches the route card, and the "same route" filter lists that
    route's activities.
  - The list and its CSV export filter periods by each activity's own local day; a filter changed right after typing a
    search is kept; elevation gain shows also for activities without a route.
  - Swim pace is per 100 m / 100 yd on the map legend and in the effort trends, handcycle cadence reads rpm, and km/h
    values are labelled "Speed" instead of "Pace" (rides, nordic skiing, golf).
  - Dashboard: exact week chart axis, feed dates by calendar day ("yesterday"), loaded cards kept when "Load more"
    fails, and "training since" names the right month.
- **Progress**:
  - Volume totals no longer change with the week / month / year toggle, and volume, intensity and weekly load cover
    exactly the chosen period; a week across New Year names both years.
  - Trends, Pace at heart rate and Power no longer freeze the app while an import or sync runs.
  - Race predictions use the VO2max of the watch chosen in Settings → My watch.
  - Records: "This year" and "Last 12 months" rank the Top 10, attempts and highlights of that period; outdated
    `?sport=` links fall back to your default sport.
  - Power curve in W/kg: the comparison curve stays visible when no weight was logged in its period.
- **Goals and consistency**:
  - The goal form reads "1,000" or "10.000" with your language's separators, switching to a period or sport without the
    chosen measure falls back to time, and progress rounds down until a goal is reached; a longest-activity goal counts
    as reached within the GPS tolerance (42.15 km for a marathon).
  - Check-off applies to the period the card shows, also after midnight; weekly check marks keep their week when the
    week start changes.
  - Streaks, goals and the "as of" day follow COROS daily values too; day details and the year in review show the
    same sleep as the sleep pages.
  - Starting goals come from your real training even when the dashboard is open during the first import, and are round
    numbers in miles and feet with imperial units; goals for unknown sports are refused.
  - Trophies: "Delete all data" no longer hides the catalog, an import no longer flags old trophies as new, and ring
    trophies follow a change of Settings → My watch right away.
- **Maps**:
  - Switching light / dark mode no longer crashes the Explorer, route and segment pages, nor the heatmap during the
    time-lapse; a heatmap color theme picked while tiles load is applied.
  - Segments: an effort starts at the last crossing of the start line (no waiting time), efforts on the part of an
    activity after a train or car ride are found, and deleting a segment during an import no longer loses other
    segments' efforts. "Rebuild analysis" corrects existing efforts.
  - Explorer: no crash with very many visited tiles (from about 65,000 in the Mac app), a cancelled rebuild no longer
    leaves tiles missing, an activity across the 180th meridian no longer marks a row of tiles around the world, and
    "first visit" colors each activity's tiles alike.
  - Routes keep their names when their activities are hidden and shown again; "What's new" reports no false tiles,
    routes or segment efforts when a watch file replaces a known activity, and names a route new when it gets its
    second activity.
  - Routes & segments: dates show the year when it is not the current one, line colors follow the satellite or dark
    basemap, and sorting by pace lists the fastest first.
- **Health**:
  - Cumulative cards (steps, active energy, exercise …) no longer fall towards 0 while COROS keeps adding days, and
    leave out the partial day an export was taken on.
  - Stand hours count the hours stood, a second sleep app no longer doubles a night, and symptoms "not present" or
    flow "None" are not counted.
  - Switching the heart source between Apple and the watch switches every past sleep night, not only the last three.
  - The Body page shows the newest blood pressure readings of the selected range.
  - Bar charts keep days, weeks and months without data, category charts keep each value's color when the range
    changes, and event charts count the events of each week or month.
  - Day and night charts show the right clock times on daylight-saving days, also when the server runs in another time
    zone.
  - The ECG "Download CSV" button works in the Mac app and in Safari.
  - Dashboard: with a COROS watch the steps tile reads "Steps (COROS)" and opens the COROS steps; the sleep tile
    writes last night like the sleep pages ("6h 53m").
  - Readiness, Heart, Sleep and metric pages keep the picked day in the address, so a day can be linked; a day without a
    recorded night says so.
- **Settings**: theme, units, language and map style changes no longer reload every page and are saved in order;
  settings you never changed follow the app's defaults. A birth date is saved only as a real date, custom zone limits
  only when they ascend (the server refuses others too), and privacy-zone edits no longer undo each other.
- **Mac and desktop apps**: the theme, remembered choices (ranges, filters, map colors, share image options) and map
  thumbnails survive a restart, and the built-in server keeps its port. The Mac app no longer keeps a CPU core busy
  after switching servers and no longer reports a false start timeout; files saved from a page (CSV, the ECG CSV)
  keep their name and type instead of becoming `cadence.png`. Cancelling the confirmation in Settings → Server stops the
  spinning Connect button.
- **Your language everywhere**: error messages are translated (the server's technical text stays small below), chart
  axes use your number format and month names, counts in texts are grouped ("1,234" / "1.234") with the right
  singular or plural, typed numbers (heart rate, FTP, zone limits) are read with your separators, values no longer
  show as "-0 °C", and the close button of dialogs is labelled in German in the German interface.
- **Keyboard and screen readers**: sortable table headers (activities, route and segment efforts) work with the
  keyboard, and the consistency calendar reads out its days with their unit.

### Changed

- **License**: Cadence is now licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) (free for personal
  and other noncommercial use; commercial use needs a separate license). Versions up to and including 1.0.0 remain
  available under the MIT License.
- **File → Import while another page is open** (Mac and desktop apps) shows the picked file and asks before it
  starts.
- **An interrupted "Rebuild analysis"** (app closed while it ran) is not resumed at the next start: it shows as
  interrupted and can be started again. Rebuilds caused by an update, a reset or a changed workout source still resume.

### Performance

- **The app stays responsive during imports**: an import or "Rebuild analysis" no longer freezes edits for seconds or
  fails them with "database is locked" (a write that still cannot get the database answers "busy"), and downloading a
  backup no longer pauses the app.
- **Faster imports**: a newer export of the same account re-analyses only the new days; first imports of large
  histories no longer slow down with every workout (duplicate detection for 11,000 workouts: 2 s → 12 ms); a full
  rebuild is about a third faster (quicker compression of streams and routes) and the Progress step takes a third less
  time; FIT files import faster with less memory; first COROS syncs download faster.
- **Less recomputing**: changing max / resting heart rate or zones recomputes only zones and relative effort; hiding a
  workout or changing its sport re-analyses only that workout; quick successive edits run as one background job;
  imports without new sleep data leave the sleep nights alone.
- **Long histories**: the activity feed and list (about 4× faster at 11,000 activities), goals, overview and year in
  review (goals 438 → 22 ms at 15,000 workouts), the health explorer, a metric's sources and raw samples, route and
  segment links of an activity.
- **Segments**: creating and matching long segments is up to 50× faster, and creating one no longer blocks the app.
- **Heatmap**: the density layer uses about 20× fewer points and the time-lapse stays smooth with thousands of
  activities.
- **Web app**: fewer and smaller files at start, a chart bundle about 50 KB smaller, map styles only with the maps (the
  Settings page loads its privacy-zone map last), superseded requests cancelled, and route previews that render their
  map only near the screen and free it again.

### Added

- **Import folders and FIT files in the apps**: the Linux and Windows apps import an unzipped Apple Health export or a
  folder of FIT files (File → Import folder…, Ctrl+Shift+O, and *Choose folder…* on the import page). The Mac app's
  import panel and Dock icon take FIT files and the unzipped folder too, and the import page of both apps has *Choose
  FIT files…* for several at once. A file dropped on the Mac app while it shows a remote server opens that server's
  import page.
- **Server settings** `CADENCE_TRUST_PROXY` (believe a reverse proxy's `X-Forwarded-*` headers) and
  `CADENCE_ALLOWED_HOSTS` (host names a password-less local server answers to), and startup warnings for a server
  that is reachable without a password or runs without `TZ`.

### Developers

- Vitest in every workspace (`packages/shared`, `apps/server`, `apps/web`, `apps/desktop`) and XCTest for the Mac
  shell (`swift test --package-path apps/macos`); `npm test` runs all workspaces.
- The derive scope is persisted (`import/scope.ts`): a derive that does not finish hands its changes to the next job.
  Feature steps get `DeriveContext.changes`; jobs carry `stepId` and `errorCode`; impossible days are a 400.
- The contract between server, web UI and shells lives in `packages/shared/src/shell.ts`; feature modules register
  their own dashboard widgets (`FeatureModule.widgets`).
- New shared web helpers: `lib/urlParams`, `lib/download`, `lib/store`, `components/map/useMapOverlay`, measure colors,
  `fmt.parseNumber`; `t()` formats numbers itself. See docs/ARCHITECTURE.md.
- Releases: the app builds run without a token that can publish, the Mac, Linux and Windows apps are started once
  before they are attached, and a failing platform no longer holds back the others. The Docker build ignores health
  data in the source folder and reuses its layers when only other parts change; the image's health check follows
  `PORT`.

## [1.0.0] – 2026-11-13

Cadence 1.0: goals per day that fill in from your activities or are checked off by hand, goals by calories, a sidebar
in your own order, and charts, narrow windows and navigation behave as they should.

### Install

- **Mac app**: `Cadence-1.0.0.dmg` below (macOS 14+, Apple silicon; not notarized: **System Settings → Privacy &
  Security → Open Anyway**).
- **Linux**: `Cadence-1.0.0-linux-x86_64.AppImage` or the `.deb` below; `./install.sh path/to/Cadence.AppImage` adds it
  to your launcher.
- **Windows**: the `Cadence-Setup-1.0.0-win-x64.exe` installer or the portable `Cadence-1.0.0-win-x64-portable.exe`
  below.
- **Server**: `ghcr.io/mang0lo/cadence:v1.0.0` (also `:latest`).
- Updating from 0.3.0 needs nothing from you: your data, goals and settings stay, and nothing is analysed again.
- The tag `v0.3.1` of the same day has no release of its own (its `package.json` still said 0.3.0, so the release
  workflow refused it); its changes are part of 1.0.0.

### Added

- **Daily goals**: besides weekly, monthly and yearly goals there are now goals per day, e.g. "5 km run" or "30 min
  strength training" every day. They are about today, show the last 14 days and come first in the goals on the
  dashboard.
- **Goals by calories**, and the measures on offer now depend on the sport: distance and longest activity only where
  a sport records a distance, elevation only where it climbs; strength training, yoga and the like get time, calories
  and activities.
- **Check a goal off by hand**: goals fill in on their own from the activities of their sport. When something was
  done but not tracked, *Check off* marks today (or this week, month, year) as reached, and a click on a missed day or
  week of the history does the same afterwards. Check marks are shown as such, can be taken back, count for the
  consistency score and survive "Delete all data".
- **Your own order in the sidebar**: *Change order* at the end of the navigation lets you drag pages to their place
  inside a group or move them with the arrows (also by keyboard and on a phone), and move whole groups up and down.
  The order is saved with your settings, so it is the same in every app and browser; *Default order* brings the
  original one back.

### Changed

- **Faster start of the charts**: only the chart types in use are loaded (1.12 MB → 0.68 MB of JavaScript).
- **Sources of a metric** (All data → a metric) are computed about twice as fast and remembered until the next
  import — noticeable for heart rate with millions of samples.

### Fixed

- **Charts while the page is zoomed** (pinch or ⌘+ in the Mac app, browser zoom): the tooltip showed the value that
  would be under the pointer without zoom. Fixed for every chart, the range selection on the activity charts and the
  tooltip of the calendar heatmap; zooming keeps working.
- **Going back keeps your place**: returning from an activity to the feed or a list restores the scroll position
  instead of jumping to the top.
- **Narrow windows and phones**: no more sideways scrolling on Settings (also at 1024 px), Activities, Import,
  Consistency, route and segment pages.
- **Menu on phones**: the close button no longer covers the light/dark switch.

## [0.3.0] – 2026-11-06

Other watches (COROS, FIT files), Cadence for Linux and Windows, a much more flexible share image and the apps can
show a Cadence server.

### Install

- **Mac app**: `Cadence-0.3.0.dmg` below (macOS 14+, Apple silicon; not notarized: **System Settings → Privacy &
  Security → Open Anyway**).
- **Linux**: `Cadence-0.3.0-linux-x86_64.AppImage` or the `.deb` below; `./install.sh path/to/Cadence.AppImage` adds it
  to your launcher.
- **Windows**: the `Cadence-Setup-0.3.0-win-x64.exe` installer or the portable `Cadence-0.3.0-win-x64-portable.exe`
  below.
- **Server**: `ghcr.io/mang0lo/cadence:v0.3.0` (also `:latest`).
- After the update Cadence rebuilds its analysis once in the background (places, countries and training kinds).

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
- **Search by place**: the activity search finds every place an activity started in, ended in or **passed through**
  (a ride through Hannover, Berlin and München is found under all three; districts count for their city), with
  German names for places stored in English ("Wien").

- **Small tags on activities** (feed, list, activity page), each only when the data exists: the estimated **kind of
  training** (intervals, long, tempo, easy, recovery — from pace / power repetitions, length and heart-rate zones),
  the **country** (several for a route across borders; searchable by name, "Italien") and the **temperature** at
  the start as recorded by the watch.

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
