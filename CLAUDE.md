# Cadence — notes for AI assistants

Strava-style training log fed by the complete Apple Health export. Local-first Mac app (Swift shell +
bundled Node server + web UI) that can also run as a Docker server.

- Read `docs/ARCHITECTURE.md` first (data conventions, feature modules, web conventions) and
  `docs/APPLE_HEALTH.md` for the export format.
- Monorepo (npm workspaces): `packages/shared` (API contract), `apps/server` (Fastify + node:sqlite),
  `apps/web` (React + Vite + Tailwind 4 + ECharts + MapLibre), `apps/macos` (SwiftPM shell).
- Feature work goes into `apps/{server,web}/src/features/<name>` + `packages/shared/src/features/<name>.ts`.
- Units are canonical (m, s, m/s, kcal, °C, kg, bpm); timestamps unix seconds + `tz_min`; days `YYYY-MM-DD`.
- Every UI string goes through `useT()` with en + de messages; numbers/dates through `useFormat()`.
- Charts follow the validated palette and rules in the web conventions (one y-axis, fixed sport colors, table view).
- Checks: `npm run typecheck && npm test && npm run build`. Sample data: `npm run sample && npm run import -- data/sample/export.zip`.
- Never commit health data (`data/`, `*.zip`, `*.db` are git-ignored).
