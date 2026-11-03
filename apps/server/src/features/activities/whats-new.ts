import type { ImportHighlight } from '@cadence/shared';
import { all } from '../../db/db';
import type { WhatsNewInput } from '../types';
import { medalsFor } from './queries';

/**
 * Personal records (rank 1) and podiums (rank 2–3 of all time) set by the new activities. Not for a first import:
 * every best effort would be listed.
 */
export function activitiesWhatsNew({ db, athleteId, workoutIds, initial }: WhatsNewInput): ImportHighlight[] {
  if (initial || !workoutIds.length) return [];
  const sportOf = new Map(
    all<{ id: number; sport: string }>(
      db,
      'SELECT id, sport FROM workouts WHERE athlete_id = ? AND id IN (SELECT value FROM json_each(?))',
      [athleteId, JSON.stringify(workoutIds)],
    ).map((r) => [r.id, r.sport]),
  );
  const out: ImportHighlight[] = [];
  for (let i = 0; i < workoutIds.length; i += 400) {
    for (const [id, medals] of medalsFor(db, athleteId, workoutIds.slice(i, i + 400)))
      for (const m of medals)
        out.push({
          feature: 'activities',
          kind: 'record',
          workoutId: id,
          data: { sport: sportOf.get(id) ?? 'other', effort: m.effort, distanceM: m.distanceM, elapsedS: m.elapsedS, rank: m.rank },
        });
  }
  return out.sort(
    (a, b) => Number(a.data.rank) - Number(b.data.rank) || Number(b.data.distanceM) - Number(a.data.distanceM),
  );
}
