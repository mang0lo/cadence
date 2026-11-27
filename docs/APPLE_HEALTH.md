# Apple Health export → Cadence

How the complete Apple Health export (Health app → profile → _Export All Health Data_) is read, where each
element ends up, and the quirks we handle. Code: `apps/server/src/import` (parsing, writing),
`apps/server/src/derive` (everything computed afterwards).

## The export

```
export.zip
└── apple_health_export/            (folder name may differ; we look for …/export.xml case-insensitively)
    ├── export.xml                  everything (Records, Workouts, …) – often several GB
    ├── export_cda.xml              HL7 CDA copy of part of the data – not imported
    ├── workout-routes/route_2024-05-01_7.30am.gpx   one GPX per workout route
    ├── electrocardiograms/ecg_2024-05-01.csv        Apple Watch ECG recordings
    └── clinical-records/*.json     FHIR resources referenced by <ClinicalRecord>
```

Accepted inputs (`openExportSource` in `import/source.ts`): the `.zip` (read with yauzl straight from disk:
zip64 and data descriptors are fine, nothing is extracted), the unzipped folder (or its parent), or a bare
`export.xml` (route/ECG files are looked up next to it). German exports may call the file `Export.xml`;
`export_cda.xml` is never mistaken for it. Choosing `export_cda.xml` itself (upload, local import) fails right away
with a message that asks for `export.xml` or the zip, the watch folder skips it, and any other XML file whose root
element is not `<HealthData>` fails the job as invalid input (`import/parser.ts`) instead of importing nothing. A
file that is no readable zip fails with "Not a readable zip file". Route and ECG files inside a zip are read only up
to the size the zip declares for them (at most 256 MB each, `READ_CAP`); a file beyond that is skipped with a warning.
Clinical FHIR files larger than 5 MB are left out without a warning (`import/importer.ts`). `export.xml` itself is
streamed and has no size limit.

## export.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [ …internal DTD subset… ]>
<HealthData locale="de_AT">
 <ExportDate value="2026-11-02 08:00:00 +0100"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1988-04-12" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" …/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch von Hannes" sourceVersion="10.1"
         device="&lt;&lt;HKDevice: 0x283a0d2c0&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.1&gt;"
         unit="count/min" creationDate="…" startDate="2024-05-01 07:30:12 +0200" endDate="…" value="72">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="0"/>
 </Record>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" …> <Record …/> <Record …/> </Correlation>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="45.2" durationUnit="min" …>
  <MetadataEntry key="HKTimeZone" value="Europe/Vienna"/>
  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="…" duration="5.1" durationUnit="min"/>
  <WorkoutActivity uuid="…" startDate="…" endDate="…" duration="…" durationUnit="min"> … </WorkoutActivity>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="…" endDate="…" sum="8.12" unit="km"/>
  <WorkoutRoute …><FileReference path="/workout-routes/route_2024-05-01_7.30am.gpx"/></WorkoutRoute>
 </Workout>
 <ActivitySummary dateComponents="2024-05-01" activeEnergyBurned="512" activeEnergyBurnedUnit="kcal" …/>
 <Audiogram …/> <ClinicalRecord …/> <VisionPrescription …/>
</HealthData>
```

It is read by a streaming scanner (`import/xml.ts`, ~600 MB/s on Apple Silicon) that never holds the file in memory,
skips the DTD subset, comments and PIs, and only decodes entities when a value contains `&`. Elements are mapped
by `import/parser.ts` (top-level `<Record>` has a fast path without building a tree) and written in batches of
~40 000 rows per transaction by `import/writer.ts`.

## Element → table mapping

| Element                                                                   | Table(s)                                                                                                                                          | Notes                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HealthData@locale`, `ExportDate@value`                                   | `import_jobs.stats` (`locale`, `exportDate`)                                                                                                      |                                                                                                                                                           |
| `Me`                                                                      | `athletes` (birth_date, sex `male`/`female`/`other`, blood_type `A+`…, skin_type `I`…`VI`) + `health_items` kind `Me`                             | `…NotSet` values are ignored; settings `sex`/`birthDate` override                                                                                         |
| `Record`                                                                  | `records`, dictionaries `record_types`, `sources`, `devices`                                                                                      | see below                                                                                                                                                 |
| `Record > MetadataEntry`                                                  | `records.meta` JSON `{key: value}`                                                                                                                | `HKMetadataKeyHeartRateMotionContext = 0` (not set) is dropped – it is on every heart rate sample                                                         |
| `Record > HeartRateVariabilityMetadataList > InstantaneousBeatsPerMinute` | `records.meta.beats` `[{bpm, time}]`                                                                                                              | `time` kept verbatim (locale formatted)                                                                                                                   |
| any other `Record` child                                                  | `records.meta._children`                                                                                                                          | lossless                                                                                                                                                  |
| `Correlation` (blood pressure, food)                                      | `correlations` (`items` JSON `[{type, value, unit, text}]`)                                                                                       | child `Record`s also go to `records` (Apple lists them at top level too → deduplicated)                                                                   |
| `Workout`                                                                 | `workouts`                                                                                                                                        | see below                                                                                                                                                 |
| `WorkoutEvent`                                                            | `workout_events` (`type` snake_case: `pause`, `resume`, `lap`, `marker`, `segment`, `motion_paused`, `motion_resumed`, `pause_or_resume_request`) | `duration` + `durationUnit` → seconds                                                                                                                     |
| `WorkoutStatistics`                                                       | `workouts.stats` JSON (`WorkoutStatistic[]`, canonical units) + columns                                                                           |                                                                                                                                                           |
| `WorkoutActivity` (iOS 16+)                                               | `workout_activities`                                                                                                                              | only stored for multi-activity workouts (swim-bike-run, intervals with different types); iOS 16+ wraps every workout in one activity that just mirrors it |
| `WorkoutRoute > FileReference@path`                                       | `workout_routes` (linked_by `reference`)                                                                                                          | GPX parsed in the routes phase                                                                                                                            |
| `WorkoutRoute > Location` (very old exports)                              | `workout_routes` (file `inline:<id>`)                                                                                                             |                                                                                                                                                           |
| `ActivitySummary`                                                         | `activity_summaries`                                                                                                                              | energy normalised to kcal; upsert (a newer export completes "today")                                                                                      |
| `Audiogram`, `ClinicalRecord`, `VisionPrescription`, any unknown element  | `health_items` (`kind` = element name, `data` = `{attrs, children}` JSON)                                                                         | lossless; ClinicalRecord gets its FHIR JSON as `data.resource`                                                                                            |
| `workout-routes/*.gpx`                                                    | `workout_routes.data`                                                                                                                             | gzip binary track (`import/track.ts`): Δt (ms), Δlat/Δlon (1e-7°, the short way across the 180th meridian) + float32 ele/speed/course/hAcc/vAcc            |
| GPX without a FileReference                                               | `workout_routes` (linked_by `overlap`)                                                                                                            | attached to the workout with the largest time overlap                                                                                                     |
| `electrocardiograms/*.csv`                                                | `ecg_readings`                                                                                                                                    | samples as gzip Float32Array (µV); Name / Date of Birth lines are never stored; header in any language (see quirks)                                        |
| `export_cda.xml`                                                          | –                                                                                                                                                 | not imported; choosing it as the file to import is refused                                                                                                |

### Records

- `type` → `record_types` (identifier, kind `quantity` / `category` / `other`, canonical `unit`, `aggregation`
  `sum` / `avg` / `duration`). Per-athlete counts and time ranges live in `record_type_stats` (maintained by derive).
- `startDate` / `endDate` / `creationDate` → `start_ts` / `end_ts` / `created_ts` (unix s) and `tz_min` (offset in the
  string). When the record has an `HKTimeZone` metadata entry (sleep, some third-party data) `tz_min` is recomputed for
  that zone, so the local day is right even after travelling.
- Quantity `value` → `value` in the canonical unit (`normalizeUnit` in `packages/shared/src/units.ts`: km/mi/yd/ft/in/
  cm/mm → m, lb/g/oz/st → kg, kJ/Cal/cal → kcal, degF → °C, km/hr, mi/hr, ft/s → m/s, and every volume — mL, dL, US
  and imperial (UK) fl oz, cups and pints — → L; anything else, e.g. `count/min`, `%`, `ms`, `dBASPL`, stays).
  Non-numeric quantity values are kept in `text`. Up to 1.0 dL, US pints and the imperial volumes were stored as
  exported (water in imperial fl oz showed about 35 times too high); migration `core_007_late_volume_units`
  (`import/unit-fix.ts`) converts such records once. A type whose history already mixed units (the import warned
  "mixed units") is only relabelled to litres, its old rows cannot be told apart.
- A record whose unit normalises to another canonical unit than the one its type is stored with is kept as exported
  and reported once per type ("…: mixed units"). Import warnings that repeat are listed once with their count
  ("(×1234)").
- Category `value` → `text` without the `HKCategoryValue` prefix and the type-specific part:
  `HKCategoryValueSleepAnalysisAsleepCore` → `AsleepCore`, `HKCategoryValueAppleStandHourStood` → `Stood`,
  `HKCategoryValueNotApplicable` → `NotApplicable`; `value` is NULL.
- `sourceName` → `sources`, `device` → `devices` (parsed into name/manufacturer/model/hardware/software, keyed without
  the `0x…` object pointer which changes between samples). `sourceVersion` of records is not kept.

### Workouts

| Source                                                                                                                             | Column                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `workoutActivityType`                                                                                                              | `activity_type` (raw) and `sport` (`sportFromActivityType`)                               |
| `duration` + `durationUnit`                                                                                                        | `duration_s` (active time, pauses excluded)                                               |
| `startDate` / `endDate`                                                                                                            | `start_ts` / `end_ts`, `tz_min`                                                           |
| `sourceName` / `sourceVersion` / `device`                                                                                          | `source_name` / `source_version` / `device` ("Apple Watch (Watch6,2)")                    |
| `HKTimeZone`                                                                                                                       | `timezone`; if it is a valid IANA zone, `tz_min` = that zone's offset at the start (Intl) |
| `HKIndoorWorkout`                                                                                                                  | `indoor`                                                                                  |
| `HKElevationAscended` ("4500 cm") / `HKElevationDescended`                                                                         | `elevation_gain_m` / `elevation_loss_m` (preferred over GPS)                              |
| `HKWeatherTemperature` ("50 degF")                                                                                                 | `temperature_c`                                                                           |
| `HKWeatherHumidity` ("8000 %" = 80 %)                                                                                              | `humidity_pct`                                                                            |
| `HKLapLength` ("25 m")                                                                                                             | `lap_length_m`                                                                            |
| all metadata (`HKAverageMETs`, `HKSwimmingLocationType` 1 pool / 2 open water, …)                                                  | `meta` JSON                                                                               |
| WorkoutStatistics distance of the sport (multisport: sum of all legs)                                                              | `distance_m`                                                                              |
| `ActiveEnergyBurned` sum                                                                                                           | `energy_kcal`                                                                             |
| `HeartRate` average / minimum / maximum                                                                                            | `avg_hr` / `min_hr` / `max_hr`                                                            |
| `StepCount` / `SwimmingStrokeCount` sums                                                                                           | `step_count` / `swim_strokes`                                                             |
| `RunningPower` / `CyclingPower`, `CyclingCadence`                                                                                  | `avg_power` / `max_power`, `avg_cadence`                                                  |
| legacy attributes `totalDistance(Unit)`, `totalEnergyBurned(Unit)`, `totalSwimmingStrokeCount`, `totalFlightsClimbed` (pre iOS 16) | synthetic entries in `stats` when no statistic covers them                                |

`ext_key` = `activityType|start|end|sourceName` identifies a workout across imports. `name` stays `''` – the UI shows the
localized default name (`workoutTitle` in shared); a user rename sets `name_locked`.

## Re-imports (idempotency)

Importing a newer export only adds what is new; every insert is `INSERT OR IGNORE` on:

| Table                | Key                                                                           |
| -------------------- | ----------------------------------------------------------------------------- |
| `records`            | `(athlete_id, type_id, start_ts, hash)`, hash = FNV-1a 32 of `end_ts\|source\|value\|text` (value = canonical value with 5 significant digits, so a changed unit preference between exports still dedupes) |
| `workouts`           | `(athlete_id, ext_key)` – existing workouts still get missing routes attached |
| `workout_routes`     | `(workout_id, file)`                                                          |
| `correlations`       | `(athlete_id, type, start_ts, end_ts, source_id)`                             |
| `ecg_readings`       | `(athlete_id, recorded_ts)`                                                   |
| `health_items`       | `(athlete_id, kind, hash of the element JSON)`                                |
| `activity_summaries` | `(athlete_id, day)` – updated when values changed                             |

The import job reports `recordsSeen` vs `recordsInserted` (etc.); re-importing the same export inserts nothing.

## Derived data

After the import the worker runs `runDerive` (`derive/run.ts`) for the new/changed workouts and record types (plus
whatever an earlier job left underived, see *Derive scope* in ARCHITECTURE.md): `core.workouts` (streams, moving time,
speeds, elevation, places, splits, best efforts, polyline, HR histogram), `core.duplicates`, `core.daily-metrics`
(+ `record_type_stats`), `core.effort` (zones, TRIMP), `core.daily-activity`, then every feature's `deriveSteps`. A
full rebuild: Import → *Rebuild analysis* (`POST /api/import/rederive`). Notable rules:

- `daily_metrics` of cumulative types (steps, distance, energy, flights, exercise/stand time, dietary…) take, per local
  hour, the maximum of each source's sum and add up the hours – iPhone and Watch both count steps.
- Category types become metrics `<identifier>:<value>` with minutes per day (max over sources per value); sleep counts
  for the local day on which it ends.
- Discrete types: mean / min / max / n per day (sample mean, so dense workout heart rate weighs in).
- Streams use the workout's own source when several sources wrote heart rate / steps in the window; HR is not
  interpolated across gaps > 30 s. GPS distance is scaled to Apple's distance when they differ by ≤ 25 %.
- GPS clean-up (`cleanTrackIndices` in `derive/streams.ts`): fixes outside the workout ±30 s or with a horizontal
  accuracy worse than 65 m are dropped; a jump at an impossible speed for the sport is rejected up to 8 times in a
  row and then taken as a new part of the track (never across a pause). When such a jump follows nothing but one
  repeated position (up to 8 fixes within 10 m, the watch's cached position before its first real fix), those fixes
  are dropped, so the activity starts where it really began.
- Cadence without Apple's cadence or step statistics comes from step records only when they cover at least half of
  the moving samples; a stream average outside 60–250 steps/min (foot sports) or 20–150 rpm (rides) is not stored.
  Step, energy and stroke records that reach over the start or end of a workout count with their share inside it.
- Duplicates (`resolveDuplicates` in `derive/duplicates.ts`): workouts of the same sport from different sources that
  overlap (e.g. Strava writing back a run recorded by the Watch, or the FIT / COROS copy of an Apple Health workout).
  They are taken from the richest copy down: the preferred source (Settings → My watch: the watch's own `fit:` file
  or the Health export's copy) first, then route, heart rate, distance, energy and a source name containing "watch";
  ties go to the lower id. A workout becomes a duplicate when at least half of its own duration is covered by kept
  workouts, and its `duplicate_of` points to the one it overlaps most. Each workout is decided on its own (no
  chains), so both halves of a session one source split in two stay. Hidden workouts take no part: they are never
  the original of a copy and never marked themselves.
- What counts towards a category's daily total (metric pages, explorer) is `categoryValueRole` in
  `packages/shared/src/features/health-catalogue.ts`: stand hours count `Stood` only, sleep skips `InBed` and
  `Awake`, symptoms logged as `…NotPresent` and menstrual flow `None` count nothing.

## Known quirks (and what we do)

- **Malformed DTD**: some iOS versions ship an internal subset with duplicate declarations that strict parsers reject.
  The scanner skips the subset without interpreting it (the subset ends at the first `]` followed by `>`).
- **Dates are in the exporting phone's zone**, not the zone the sample was recorded in. A run in New York exported in
  Vienna shows `13:10 +0200`. Workouts (and some records) carry `HKTimeZone`, which we use to recover local time.
- **`HKDevice` pointers** (`0x283a0d2c0`) differ per sample → stripped for the device key.
- **Localized names**: sources like "Apple Watch von Hannes", `Export.xml`, ECG CSV headers in the phone's language
  (`import/ecg.ts`). English and German keys are known (Aufnahmedatum, Klassifizierung, Abtastrate "512 Hertz", …);
  in any other language the recording date is recognised by its format (`YYYY-MM-DD HH:MM:SS ±HHMM`) and the lines
  after it by their fixed order (classification, symptoms, software version, device, sample rate, lead, unit); a
  sample rate read that way outside 100–2000 Hz is taken as 512 Hz. The health module maps classifications in
  English, German, French, Spanish and Japanese onto its own keys (sinus rhythm, AFib, high / low heart rate …,
  `classifyEcg` in `features/health/ecg.ts`); other wordings count as "other". HRV beat times are locale formatted.
- **Units follow the user's preferences** at export time (km vs mi, kg vs lb, kcal vs kJ) – normalised on import.
  Weather humidity is written ×100 ("8000 %"), weather temperature in degF.
- **iOS 16+** moved workout totals into `WorkoutStatistics` and added `WorkoutActivity`; older exports have
  `totalDistance` etc. as attributes. Some iOS versions omit `workoutActivityType` on `WorkoutActivity` → the
  workout's type is used.
- **Correlation children** appear twice (inside the correlation and at top level) → deduplicated by the record hash.
- **Route files** can be missing (warning) or exist without a reference (matched by time overlap). Apple writes `-1`
  for unknown GPX speed/course → treated as missing; implausible jumps (GPS glitches) are dropped while deriving.
- **Sleep**: before iOS 16 only `InBed` / `Asleep`, afterwards `AsleepCore` / `AsleepDeep` / `AsleepREM` / `Awake`.
- **Very large exports**: tens of millions of records, `export.xml` > 4 GB (zip64). Nothing is loaded into memory;
  transactions stay short (~40k rows) so the HTTP server (own connection, WAL) keeps answering during an import.

## Sample data

`npm run sample -- [--size small|medium|large] [--seed N] [--end YYYY-MM-DD] [--out path]` writes a deterministic
synthetic export (`apps/server/scripts/sample`): Watch + iPhone records (overlapping steps), sleep stages, HRV with
beat lists, body measurements, blood pressure correlations, an audiogram, ECGs (English and German headers), activity
rings, and workouts on real Vienna streets (Prater Hauptallee, Donauinsel, Ringstraße, Kahlenberg, Donauradweg; route
geometry traced from OpenStreetMap data © OpenStreetMap contributors, elevations from the Copernicus DEM) – including a
run in New York with `HKTimeZone`, a legacy-format workout, a swim-bike-run with `WorkoutActivity`, treadmill runs,
pool swims with laps, a training break, races, and a Strava copy of a Watch run.
