/**
 * Dashboard widgets of the "activities" feature. The activities feature owns the dashboard itself (pages/HomePage:
 * athlete card, feed, and the other features' widgets in the right column), so it adds no widget of its own here.
 *
 * Reusable pieces for other features (import them from their files):
 *  - components/MedalBadge      `MedalBadge` / `MedalList` — PR / 2nd / 3rd best effort badges (icon + label)
 *  - components/FeedCard        `FeedCard` — Strava-style activity card (needs an ActivityListItem)
 *  - components/SportDialog     `SportDialog` — change the sport of a workout
 *  - api.ts                     `usePatchWorkout`, `useActivityList`, `useActivitiesSummary`, …
 *  - GET /api/activities/list   activities with medals + totals for any filter (see @cadence/shared ActivityListQuery)
 */
export {};
