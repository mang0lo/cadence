# Feature-agent briefs

Cadence's product areas are built as vertical slices by parallel subagents, each in its own git worktree.
To (re)start one: give the agent `common.md` (with `<F>`, `<API_PORT>`, `<WEB_PORT>` filled in) followed by the
feature file. Then review, run `npm run typecheck && npm test && npm run build`, and merge its branch into `main`.

| Feature | Brief | API port | Web port | Model |
| --- | --- | --- | --- | --- |
| activities (dashboard, list, detail + map playback) | activities.md | 8821 | 5181 | opus |
| progress (improvement over time) | progress.md | 8822 | 5182 | opus |
| consistency (calendar, streaks, goals, trophies, year review) | consistency.md | 8823 | 5183 | opus |
| maps (heatmap, explorer tiles, routes, segments) | maps.md | 8824 | 5184 | sonnet |
| health (sleep, heart, body, explorer, ECG) | health.md | 8825 | 5185 | sonnet |

Feature folders are disjoint, so merges should not conflict. Agents report shared-code bugs instead of editing
shared files — apply those fixes on `main` after merging.
