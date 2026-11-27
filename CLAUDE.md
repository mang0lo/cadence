# Cadence — notes for AI assistants

Strava-style training log fed by the complete Apple Health export (plus FIT files and COROS sync). Local-first desktop
app — Swift shell on macOS (`apps/macos`), Electron on Linux / Windows (`apps/desktop`), both around the bundled Node
server + web UI — that also runs as a Docker server.

- Read `docs/ARCHITECTURE.md` first (configuration, data conventions, derive pipeline, feature modules, web
  conventions, testing) and `docs/APPLE_HEALTH.md` for the export format.
- Monorepo (npm workspaces): `packages/shared` (API and shell contract), `apps/server` (Fastify + node:sqlite),
  `apps/web` (React + Vite + Tailwind 4 + ECharts + MapLibre), `apps/desktop` (Electron shell); `apps/macos` (SwiftPM
  shell, no workspace) is built by `npm run mac`.
- Feature work goes into `apps/{server,web}/src/features/<name>` + `packages/shared/src/features/<name>.ts`; a feature
  registers its own dashboard widgets (`FeatureModule.widgets`). Steps: ARCHITECTURE.md → *Adding a feature module*.
- Units are canonical (m, s, m/s, kcal, °C, kg, bpm); timestamps unix seconds + `tz_min`; days `YYYY-MM-DD`.
- Every UI string goes through `useT()` with en + de messages (pass numbers to `t()` as numbers); numbers/dates through
  `useFormat()`, numbers the user typed through `fmt.parseNumber`.
- Charts follow the validated palette and rules in the web conventions (one y-axis, fixed sport and measure colors,
  table view). Reuse the shared helpers listed there (`lib/urlParams`, `lib/download`, `lib/store`,
  `components/map/useMapOverlay`, `ErrorState`, the `size="sm"` controls) instead of building new ones.
- What the server, the web UI and the shells exchange is defined in `packages/shared/src/shell.ts` (the Mac app keeps a
  copy in `ShellContract.swift`, checked by a test).
- Tests: Vitest in every workspace (`packages/shared/test`, `apps/server/test`, `apps/web/test` — Node, no DOM —,
  `apps/desktop/test`), XCTest for the Mac shell (`swift test --package-path apps/macos`). See ARCHITECTURE.md →
  *Testing*.
- Checks: `npm run typecheck && npm test && npm run build`. Sample data: `npm run sample && npm run import -- data/sample/export.zip`.
- Code style: match the surrounding code and format only the lines you change. Never run Prettier (`npm run format`)
  on whole files: most files are not Prettier-formatted, so it would bury the change in unrelated edits.
- Never commit health data (`data/`, `*.zip`, `*.db` are git-ignored).
