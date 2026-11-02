# Feature: progress (F = progress) — the user's #1 priority, "improvements over time"
Existing stubs: ProgressPage ('/progress'), RecordsPage ('/progress/records'), FitnessPage ('/progress/fitness'), widgets `WeeklySnapshotWidget` + `FitnessWidget` (placed on the dashboard by the activities feature; each renders its own Card). Server under `/api/progress`, DTOs in packages/shared/src/features/progress.ts; cache expensive series via derive steps.

1. **Progress page** with one filter row (sport — default the most frequent; period presets; metric) scoping everything below:
   - Volume: distance / time / elevation / count / effort per week, month or year; stacked by sport for "all sports" (fixed colors, canonical order) or single sport with a rolling-average line.
   - Year over year: cumulative distance (or time/elevation) by day of year, one line per year (current emphasised, earlier muted), today marker, "ahead/behind last year by X".
   - Per-activity trends: scatter of average pace/speed over time with rolling median + trend line + "improved by X %"; same for average HR, efficiency factor (speed/HR), cadence, running power, stride length, ground contact time, vertical oscillation (records during runs).
   - "Pace at heart rate": pace within a selectable HR band (e.g. 140–150 bpm) per month from streams (cache per workout).
   - Period comparison (week/month/year/custom vs previous) with deltas for all key metrics.
   - Intensity distribution: weekly time in HR zones (zone colors) + easy vs hard share.
2. **Records ('/progress/records')**: PRs per sport for every BEST_EFFORTS distance (all-time, this year, last 12 months; time, pace, date, link), progression chart per distance (attempts as dots + running-PR step line), top-10 per distance, longest / biggest climb / fastest records, race predictor (Riegel from recent best efforts + Apple-VO2max-based estimate).
3. **Fitness ('/progress/fitness')**: CTL (42-day EWMA of daily effort), ATL (7-day), TSB = CTL − ATL from `daily_activity.effort` (missing days = 0); form-zone background bands (transition / fresh / optimal / tired / overreaching), ramp rate with warnings, acute:chronic ratio, weekly load bars; VO2max (daily_metrics 'HKQuantityTypeIdentifierVO2Max') trend with fitness level for age/sex; resting HR and HRV as small context charts.
4. **Widgets**: `WeeklySnapshotWidget` (this vs last week: distance, time, activities, elevation with deltas + 12-week sparkline), `FitnessWidget` (fitness / fatigue / form + label + mini chart).
Pure, unit-tested math: EWMA, rolling median, trend fit, Riegel, period bucketing with weekStart, pace-at-HR.
