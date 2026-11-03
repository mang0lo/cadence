import type { ImportHighlight } from '@cadence/shared';
import { all } from '../../db/db';
import type { WhatsNewInput } from '../types';

/** Trophies the trophy step found newly earned during this import (first_seen_at is stamped by the step). */
export function consistencyWhatsNew({ db, athleteId, since }: WhatsNewInput): ImportHighlight[] {
  return all<{
    key: string;
    grp: string;
    kind: string;
    tier: string;
    sport: string | null;
    threshold: number;
    name: string | null;
    earned_day: string;
    workout_id: number | null;
  }>(
    db,
    `SELECT key, grp, kind, tier, sport, threshold, name, earned_day, workout_id FROM consistency_achievements
     WHERE athlete_id = ? AND earned_day IS NOT NULL AND first_seen_at IS NOT NULL AND first_seen_at >= ?
     ORDER BY ord`,
    [athleteId, since],
  ).map((r) => ({
    feature: 'consistency',
    kind: 'trophy',
    workoutId: r.workout_id,
    data: {
      key: r.key,
      group: r.grp,
      kind: r.kind,
      tier: r.tier,
      sport: r.sport,
      threshold: r.threshold,
      name: r.name,
      earnedDay: r.earned_day,
    },
  }));
}
