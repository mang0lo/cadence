# Ideas for the next versions

Proposals, not promises: twelve features that would make Cadence more useful week after week, ranked, plus the ideas
that were considered and dropped. They complement the [Roadmap](../README.md#roadmap) in the README (multi-user
servers, live sync, more import sources), which stays as it is.

**How they were ranked.** Three views were combined: what comparable apps (Strava, Garmin, Apple Fitness, intervals.icu,
Oura …) offer that Cadence lacks, which data the Apple Health export and FIT files already bring that Cadence imports
but does not use, and how often people would use the feature. The score is *share of users who would use it weekly ×
value (1–5) ÷ effort* (S = 1, M = 2, L = 4); it orders the list, it is not a measurement. Figures about "the sample"
refer to the synthetic two-year export of `npm run sample`.

Every idea keeps the existing rules: data stays on the machine, values in canonical units, athlete-scoped tables, a
feature module per product area ([ARCHITECTURE.md](ARCHITECTURE.md#adding-a-feature-module)), en + de texts.

## Ranked ideas

### 1. Sleep score, sleep debt and tonight's sleep need (effort S)

- **What**: every night — past ones too, from Apple, COROS or another sleep app — gets a 0–100 score from three parts:
  duration against the sleep goal (50 points), bedtime consistency against the median of the last 14 nights (30) and
  interruptions / time awake (20). COROS nights have no bed and wake times, so they are scored on the other parts,
  re-weighted. The Sleep page shows a score ring with its parts in the night detail, a score trend and a 14-night
  sleep-debt chart (both with a table view). Debt is the sum of *goal − asleep* over 14 nights; nights above the goal
  pay part of it back, up to a cap. *Sleep need tonight* = goal + a share of the debt + an add-on after an unusually
  hard training day. The dashboard's health snapshot shows e.g. "Last night 82 · debt 3.1 h". The goal defaults to the
  iPhone sleep schedule goal when the export has one; breathing disturbances get a row in the overnight vitals.
  Readiness stays as it is in a first version (it already compares sleep with the goal).
- **Data and code**: no new table, computed on read from `health_sleep_nights`, `HealthSettings.sleepGoalMin` and the
  workouts' relative effort per day; the records `HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances` and
  `HKDataTypeSleepDurationGoal` are imported today but only show up in the explorer. Server: pure scoring functions in
  `features/health/sleep.ts` (unit tests), score and parts added by `toNight()` to `GET /api/health/sleep/nights` and
  `/sleep/night`, debt and need on `GET /api/health/snapshot`. Web: `NightDetail.tsx`, `SleepCharts.tsx`,
  `SleepPage.tsx`, the snapshot card in `health/widgets.tsx`.
- **Why not niche**: everyone who sleeps with a watch or a sleep app (the sample has a night for each of its 730 days).
  It is the health number Apple, Garmin, Fitbit and Oura put first, and Apple's own sleep score is not part of the
  export, so Cadence has to compute it. Score ≈ 65 % × 4 ÷ 1 = 2.6.

### 2. Readiness and recovery around every activity (effort S)

- **What**: a "Body" card on the activity page. *Before*: that morning's readiness (score and band), the night before
  (asleep against the goal, and the score from #1) and HRV / resting heart rate against the personal baseline.
  *After*: Apple's one-minute heart-rate recovery measured right after the workout, the next night's sleep and the next
  morning's HRV / resting heart rate against the baseline. One line of interpretation ("started on an easy-day
  readiness", "HRV back to baseline the next morning"). Hidden when there is no overnight data.
- **Data and code**: no new data. Server: `GET /api/health/context?workoutId=`, built on `buildReadiness` /
  `loadReadinessInput` (`features/health/readiness-routes.ts`, which can already evaluate any past day) and `toNight`
  (`features/health/sleep.ts`); recovery from `HKQuantityTypeIdentifierHeartRateRecoveryOneMinute` records in the
  15 minutes after the workout. Web: a card exported from `health/widgets.tsx` and placed in
  `activities/components/detail/AnalysisSections.tsx`, the way the maps card (`WorkoutMapsCard`) is.
- **Why not niche**: every Apple Watch or COROS user who wears the watch at night sees it on every activity they open.
  It explains bad days and shows what hard sessions cost; today the activity page has no link to readiness or sleep.
  Score ≈ 55 % × 3 ÷ 1 = 1.7.

### 3. Hands-free imports in the desktop apps (effort S)

- **What**: Settings → Import → *Watch a folder* with a native folder picker. Suggested folder: Downloads (where an
  AirDropped `export.zip` lands); an iCloud Drive or Syncthing folder works too. New Apple Health exports and `.fit`
  files are imported by themselves, with the usual job, "What's new" summary and a toast; unrelated zips are skipped.
  When the newest data is more than 7 days old, every page shows a hint ("Your data ends 9 days ago — export it from
  the Health app", with the three iPhone steps); today such a note (`AsOfNote`) is only on the consistency pages.
- **Data and code**: no new table; the folder is a new settings key next to `core.importWatch` (which remembers the
  imported files). Server: `app.ts` starts and restarts `startImportWatcher` (`import/watch.ts`) from that setting —
  today the watcher only runs when `CADENCE_IMPORT_DIR` is set, which keeps precedence for Docker; the watcher looks
  into each zip's directory and queues only zips that contain an `export.xml` or `.fit` files. Shells: a
  folder-picker message in both apps (`packages/shared/src/shell.ts`, `apps/web/src/lib/native.ts`). Web: an
  *Automatic import* card in `platform/SettingsPage.tsx`, the stale-data hint in `components/layout/AppShell.tsx`. The
  Mac app is not sandboxed; macOS asks once for access to Downloads. Nothing leaves the machine.
- **Why not niche**: every Apple Health user of the desktop apps re-imports regularly, typically weekly; it is the
  biggest recurring chore (COROS users already sync automatically). Score ≈ 45 % × 2.5 ÷ 1 = 1.1.

### 4. Everyday health goals and streaks (effort M)

- **What**: the goal dialog gets an *Everyday* group of goals without a sport: steps per day (e.g. 10,000), sleep per
  night (or nights ≥ 7 h per week), exercise minutes per week (WHO: 150), mindful minutes and a target weight by a
  date. They get the same progress, history, streaks, on-track projection, check-off and dashboard widget as activity
  goals, so goals also fill up on rest days. The weight goal shows the 7-day mean against the target and an arrival
  date from a linear trend. Suggestions come from Apple's ring goals and the sleep schedule goal; trophies gain streak
  ladders for step days and sleep nights.
- **Data and code**: no new table or endpoint: `consistency_goals` (kept by "Delete all data") stores the new measures,
  `/api/consistency/goals` and `/trophies` return them. Shared: `GoalMetric` (today only workout measures) gains steps,
  exercise minutes, sleep, weight and mindful minutes, which `goalMetricsFor()` allows only without a sport. Server:
  readers for `daily_metrics` (step count via `heartMetric(…, 'steps')` so COROS counts, exercise time, body mass,
  mindful sessions) and `health_sleep_nights` next to `daily_activity` in `features/consistency/data.ts`;
  `goalValue()` / `goalHistory()` in `goals.ts`; ladders in `achievements.ts`. A sleep goal uses
  `HealthSettings.sleepGoalMin`, so readiness, sleep debt and the goal agree. Web: `GoalDialog.tsx`, `GoalParts.tsx`,
  the goals widget, `TrophiesPage.tsx`.
- **Why not niche**: steps come from every iPhone and COROS watch, sleep and exercise minutes from every Apple Watch.
  Step and sleep targets are the most common everyday goals and make goals useful for people who train only a few times
  a week. Score ≈ 50 % × 3.5 ÷ 2 = 0.9.

### 5. Gear: shoes and bikes with mileage and retirement alerts (effort M)

- **What**: a Gear page (training group) lists each pair of shoes or bike with distance, time and activities, a
  retirement bar (e.g. 612 / 700 km) and km per month. Each item has sports, an in-use-from date, an optional retired
  date, starting km and an alert km. A default per sport plus simple rules (indoor / treadmill, trail by sub-sport or
  climbing per km) assign new activities, and past ones inside the in-use window; the activity page has a picker to
  override it. A dashboard widget shows items near retirement, "What's new" says when a pair passes its limit, the
  activity list gets a gear filter and the CSV export a gear column.
- **Data and code**: a new feature module `gear` with tables `gear_items` and `gear_assignments` (keyed by the
  workout's `ext_key`, so assignments survive "Delete all data" and a re-import; both in `keepOnReset`), a derive step
  `gear.assign` after the core steps, a `whatsNew` hook, routes `/api/gear` and `PUT /api/gear/assignments/:workoutId`,
  a contract in `packages/shared/src/features/gear.ts` and a web module with page, widget, picker
  (`activities/components/detail/ActivityHeader.tsx`), list filter and export column
  (`apps/server/src/features/activities/export.ts`). No export carries gear, so it is local user data; backups carry it.
- **Why not niche**: runners and cyclists are the core audience (runs and rides are 57 % of the sample's activities);
  the sample's 1,400 running km a year wear out two or three pairs. Strava, Garmin, intervals.icu and Runalyze all have
  it.
  Score ≈ 40 % × 4 ÷ 2 = 0.8.

### 6. Perceived effort and feel on every activity, filled in from the watch (effort M)

- **What**: each activity shows "Perceived effort 7/10" and a feel rating (1–5) next to Cadence's heart-rate based
  *Effort*, pre-filled from the Apple Watch effort rating (or Apple's estimate, marked as such) and from a FIT file's
  RPE and feel, and changeable with one tap. FIT activities also show the device's aerobic / anaerobic training effect
  and TSS. Perceived effort becomes a feed chip, a sortable list column and a Progress trend "felt vs. heart rate".
  Workouts without heart rate (strength apps, iPhone-only, manual entries) get a session-RPE load (RPE × minutes,
  calibrated per athlete against heart-rate based efforts) instead of today's flat estimate per sport, which makes
  fitness and fatigue more accurate.
- **Data and code**: the records `HKQuantityTypeIdentifierWorkoutEffortScore` / `…EstimatedWorkoutEffortScore` are
  imported but unused (linked to a workout by time overlap); the FIT session fields `workoutRpe` / `workoutFeel` are in
  the bundled `@garmin/fitsdk` profile but not read; `import/fit/parse.ts` already stores `FitAerobicTrainingEffect`,
  `FitAnaerobicTrainingEffect` and `FitTrainingStressScore` in `workouts.meta` without showing them. A core migration
  adds `rpe`, `rpe_source` (apple, apple_est, fit, user) and `feel` to `workouts`; values the user set are never
  overwritten. `derive/effort.ts` uses the session RPE before falling back to `effortPerMinute(sport)`;
  `PATCH /api/workouts/:id` accepts rpe / feel. Labelled *Perceived effort* so it does not clash with the TRIMP-based
  *Effort*.
- **Why not niche**: shown on every activity; nothing to type for watchOS 11+ users or FIT users. Strength, yoga and
  HIIT (about a sixth of the sample's activities) finally get a real training load. Score ≈ 50 % × 3 ÷ 2 = 0.75,
  ranked above #7 at the same score because it also corrects the load model.

### 7. Week and month in review (effort M)

- **What**: a review page for every finished week and month, with previous / next: totals against the previous
  period and the 4-week / 3-month average, by sport; each day with its activities and notes; the biggest activity, new
  records and medals, trophies, new explorer tiles, goals reached or missed, the change in fitness and form, and the
  average sleep, resting heart rate, HRV and readiness. On Mondays (and on the 1st) a "Last week" card on the dashboard
  links to it. The page prints cleanly for a coach and can be shared as an image, privacy zones respected.
- **Data and code**: no new table. Generalise the helpers behind the year review (`features/consistency/year.ts`:
  totals, efforts, metric aggregates, sleep and health averages) to any range of days; a new
  `GET /api/consistency/review?period=week|month&key=…` with a `PeriodReview` type in the shared consistency contract.
  Web: a review page reusing `components/YearParts.tsx`, a dashboard widget, the share image helpers of
  `activities/lib/shareImage.ts` and a print stylesheet.
- **Why not niche**: built for the weekly look back most athletes do, plus a monthly one; Garmin, Apple, Polar and
  WHOOP all send weekly reports. Today there is a year in review, a four-number weekly snapshot widget and bare totals
  in Progress → Compare. Score ≈ 50 % × 3 ÷ 2 = 0.75.

### 8. Trends, highlights and health bests (effort M)

- **What**: a *Trends* card on the Health page compares the last 90 days with the last 365 for resting heart rate,
  HRV, VO2max, steps, walking speed, sleep, running pace and pace at the same heart rate. A dashboard *Highlights*
  widget states the few significant findings in plain language ("Resting HR 4 bpm below your usual for 3 weeks", "You
  ran 25 % more this month than your 3-month average"). A list of health bests (lowest 7-day resting heart rate, best
  VO2max, longest step and sleep streaks, weight milestones). After every import — also one that brought only health
  records — "What's new" lists new health bests and highlights.
- **Data and code**: no new table, computed on read from `daily_metrics` (through `heartMetric()`, so the watch
  choice counts), `health_sleep_nights` and the progress trends, with the helpers of
  `packages/shared/src/features/health-analytics.ts` (`compareWindows`, `rollingMeanByDay`, `trailingChange`). Rules and
  thresholds (e.g. a change beyond one standard deviation of the 365-day values, a minimum number of days) in a
  `features/health/highlights.ts`; `GET /api/health/trends` and `/highlights` return message keys and canonical values.
  `import/summary.ts` must also ask the features for highlights when an import added no workouts (today it does not).
- **Why not niche**: everyone with an iPhone or a watch; read after every import and on the dashboard. Today the health
  cards compare 30 days with the 30 before, and an import without new workouts shows no highlights. Apple's Highlights
  and Trends, Strava's Athlete Intelligence and Oura do this. Score ≈ 45 % × 3 ÷ 2 = 0.7.

### 9. Training calendar with planned sessions and races (effort L)

- **What**: a `/calendar` page with one week per row: each activity a compact chip (sport color, distance or time,
  training kind), and per week the distance or time per sport, the effort and fitness / form at the end of the week.
  Future days take planned items: a session (sport, title, target duration or distance, kind, note), a rest day, a
  note or a race (distance, goal time, priority A/B/C). Finished activities are matched to the plan (same day and
  sport, races by distance ± 5 %) and marked done, partly done or missed. Items can be dragged to another day and a week
  copied. A dashboard *Today* widget shows today's session or the countdown to the next race with the predicted time
  (existing race predictor) against the goal and the projected form on race day; the Fitness chart projects fitness
  and fatigue from the planned load; races keep a results list. Ship the log view first, then planning and races.
- **Data and code**: a new feature module `calendar`: table `calendar_items` (day, kind, sport, targets, race fields,
  matched workout by `ext_key`; in `keepOnReset`), derive step `calendar.match`, routes for the weeks, the items,
  copying a week and the projection (future fitness from the planned load via `effortPerMinute` and
  `features/progress/fitness.ts`). Web: a calendar page reusing `consistency/components/DayPanel.tsx`, the Today
  widget, race markers on the Fitness page.
- **Why not niche**: the week-by-week log is how most athletes look back (Strava's training log, TrainingPeaks,
  intervals.icu, Garmin's calendar); planning and races matter daily to the ~30–40 % who train for an event. Today
  there is the per-year heatmap and the feed. Score ≈ 60 % × 4 ÷ 4 = 0.6.

### 10. Add and correct activities by hand (effort M)

- **What**: an *Add activity* dialog (activity list, dashboard, a calendar day) takes sport, start, duration,
  distance, elevation, calories, average heart rate, perceived effort and notes. *Edit stats* corrects distance,
  duration and elevation of recorded activities (treadmill, indoor). Totals, goals, streaks, trophies and the fitness
  model count them; manual activities get an estimated effort. When a later import brings the same session, the
  recorded copy wins and the manual name, notes and effort carry over. Cropping a workout where the watch kept running
  is a follow-up.
- **Data and code**: manual activities are `workouts` rows with `ext_key` `manual:<uuid>`; corrected values get lock
  flags (core migration). `core/workouts-routes.ts`: `POST /api/workouts` (does not exist today),
  `DELETE /api/workouts/:id` for manual rows, and `PATCH` accepts distance, duration and elevation; a derive of the
  changed workouts refreshes days, effort and goals. `import/reset.ts` keeps manual rows (user-written, like goals and
  segments); `derive/duplicates.ts` prefers the recorded copy and carries name and notes over.
- **Why not niche**: a training log has to be complete — a forgotten or flat watch, gym classes, team sports, treadmill
  calibration. Perhaps a quarter of users need it a few times a month, and without it every total, streak and goal is
  off; goal check-off (1.0.0) is only a workaround. Score ≈ 25 % × 4.5 ÷ 2 = 0.55.

### 11. Pace and power zones plus training paces (effort M)

- **What**: Settings get a threshold pace (entered, or estimated from recent best efforts via VDOT) and Coggan power
  zones from the FTP (the setting or the existing estimate). Every run shows its time in pace zones (grade adjusted),
  every ride with power its time in power zones, next to the heart-rate zones; the map can color the route by pace
  zone; Progress → Intensity gets a basis switch heart rate | pace | power; Records gets a *Training paces* card (easy,
  marathon, threshold, interval, repetition) from the current VDOT.
- **Data and code**: `workout_streams` (speed, grade-adjusted speed, power), `best_efforts`, `vdotFromPerformance` /
  `danielsVo2` in `features/progress/math.ts`, the FTP setting and estimate. `derive/workouts.ts` stores speed and power
  histograms per workout like the heart-rate histogram (`hr_hist`), so zones follow a settings change without a
  rebuild. `intensity()` in `features/progress/trends.ts` takes a basis; a new `GET /api/progress/paces`. Web:
  `activities/components/detail/Distributions.tsx`, the activity map, `progress/components/IntensityCard.tsx`,
  `progress/pages/RecordsPage.tsx`, the settings page.
- **Why not niche**: runners and cyclists are the core audience; zones are read on every run or ride, training paces
  when planning the week. Strava, Garmin, COROS, TrainingPeaks and intervals.icu all have them; Cadence has heart-rate
  zones only. Score ≈ 35 % × 3 ÷ 2 = 0.5.

### 12. Today's target and a weekly load range (effort M)

- **What**: a dashboard widget shows the week as a bar ("This week: effort 380–520, done 210") and a suggestion for
  today scaled by readiness ("easy run 40–55 min", "intervals ok", "rest"), picked from the athlete's own typical
  sessions. The Fitness page draws the weekly target band on its weekly load chart, and the readiness advice gets one
  concrete line. Optional preference: conservative / balanced / ambitious.
- **Data and code**: no new table; the preference lives in the progress preferences. A `features/progress/target.ts`
  and `GET /api/progress/target?today=`: the weekly range comes from the fitness model so that the acute:chronic ratio
  stays at 0.8–1.3 and the ramp below "elevated" (`features/progress/fitness.ts`); the day's range is the remaining
  weekly budget times a readiness factor (`features/health/readiness.ts`); the suggestion comes from relative effort,
  training-kind tags and typical durations per sport. Web: a widget in `progress/widgets.tsx`, a band on the Fitness
  page, a line in the readiness widget.
- **Why not niche**: it turns numbers Cadence already computes into a daily answer to "what should I do today?",
  without any input. Strava (weekly relative-effort range), Garmin (load ranges, suggested workouts) and WHOOP (target
  strain) offer it. Borderline: ≈ 30 % × 3 ÷ 2 = 0.45.

## Dropped ideas

| Idea | Why not now |
| --- | --- |
| Activity list power tools (structured filters, saved views, bulk edit) | Ranked 13th (≈ 0.38): sport, period, search and GPS filters and sorting cover most lookups; bulk edit matters mostly once, after the first import, and gear rules (#5) remove its main use. A stored training kind with a filter would be a good small follow-up. |
| Personal insights ("what moves your sleep and recovery") | Needs months of data and habits few people log (alcohol, caffeine); testing many habit × outcome pairs on noisy daily data invites spurious findings. |
| Command palette and keyboard shortcuts | A power-user convenience; the reorderable sidebar and the activity search (names, places, countries) cover navigation. |
| Heat and humidity impact on pace and heart rate | Seasonal and noisy, and the sample models no heat effect to check it against; at most a later line in the activity insights. |
| Cycle-aware health and readiness | Serves only athletes who log periods in Apple Health. The strongest of the dropped ideas: revisit it as a readiness correctness fix (phase-matched baselines) rather than a new page. |
| Installable phone app for server mode (PWA) | Only helps server users on phones, and the responsive UI already works in a mobile browser; a manifest and icons can come along as a small chore. |
| Energy balance and fueling | Useful only for the minority who log food in an app that writes to Health; the dietary types are already charted in the health explorer. |
| Sick, injured and vacation days (illness detection, pausing streaks and goals) | Used a few times a year; goal check-off already overrides missed periods, and detecting illness from vitals comes close to health claims. A candidate for a later small release. |
| Mobility page (walking speed, steadiness, gait) | Looked at monthly at most, little relevance to training; the metrics are charted in the health explorer. |
| Hearing and noise (headphone dose, loud places, audiogram) | Not training related; the data is reachable in the explorer. |
| First-run onboarding with demo data and a checklist | Used once per user; the empty dashboard links to the import, and demo data would need the sample generator bundled into the app. |
| Strava history import (archive with metadata) | A one-time migration for some users; it belongs with the roadmap's import work (GPX / TCX, Garmin, Polar …). |
| Monday digest by push, webhook or e-mail | Sends health data through third-party services and works only in server mode; the in-app "Last week" card (#7) covers the ritual. |
| Calendar subscription feed (.ics) | Calendar apps fetch subscribed feeds from their providers' clouds, which needs a publicly reachable server and conflicts with keeping data private; the Today widget (#9) covers the need. |
