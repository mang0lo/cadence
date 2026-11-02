import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  evaluateAchievements,
  type EvalInput,
  type EvalRingDay,
  type EvalWorkout,
} from '../src/features/consistency/achievements';
import { computeChallenges, monthsBetween } from '../src/features/consistency/challenges';
import { plusDays, weekdayOf } from '../src/features/consistency/days';

let nextId = 1;
const workout = (day: string, sport: string, o: Partial<EvalWorkout> = {}): EvalWorkout => ({
  id: nextId++,
  sport,
  startTs: Date.parse(`${day}T${String(o.hour ?? 18).padStart(2, '0')}:00:00Z`) / 1000,
  day,
  weekday: weekdayOf(day),
  hour: 18,
  distanceM: 0,
  elevationM: 0,
  ...o,
});

function evaluate(workouts: EvalWorkout[], o: Partial<EvalInput> = {}) {
  const input: EvalInput = { workouts, rings: [], weekStart: 1, challengeDays: [], ...o };
  const catalog = buildCatalog({ sports: workouts.map((w) => w.sport), hasRings: input.rings.length > 0 });
  const results = evaluateAchievements(catalog, input);
  return new Map(results.map((r) => [r.key, r]));
}

describe('trophy catalog', () => {
  it('adds distance ladders only for distance sports the athlete did, rings only with ring data', () => {
    const keys = buildCatalog({ sports: ['run', 'strength', 'swim'], hasRings: false }).map((d) => d.key);
    expect(keys).toContain('sport_distance.run.1000000');
    expect(keys).toContain('sport_distance.swim.10000');
    expect(keys.some((k) => k.startsWith('sport_distance.strength'))).toBe(false);
    expect(keys).toContain('longest.run.42195');
    expect(keys.some((k) => k.startsWith('longest.ride'))).toBe(false);
    expect(keys.some((k) => k.startsWith('move_streak'))).toBe(false);
    const withRings = buildCatalog({ sports: [], hasRings: true }).map((d) => d.key);
    expect(withRings).toContain('move_streak.365');
    expect(withRings).toContain('perfect_week.1');
    // keys are unique
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('trophy rules', () => {
  it('awards activity milestones with the activity that reached them', () => {
    const ws = Array.from({ length: 12 }, (_, i) => workout(plusDays('2026-01-01', i * 2), 'run', { distanceM: 3000 }));
    const r = evaluate(ws);
    expect(r.get('activities.1')).toMatchObject({ earnedDay: '2026-01-01', workoutId: ws[0]!.id, progress: 12 });
    expect(r.get('activities.10')).toMatchObject({ earnedDay: ws[9]!.day, workoutId: ws[9]!.id });
    expect(r.get('activities.25')).toMatchObject({ earnedDay: null, workoutId: null, progress: 12 });
  });

  it('tracks cumulative distance per sport and elevation', () => {
    const ws = [
      workout('2026-01-01', 'ride', { distanceM: 60_000, elevationM: 5000 }),
      workout('2026-01-02', 'run', { distanceM: 50_000, elevationM: 100 }),
      workout('2026-01-03', 'ride', { distanceM: 45_000, elevationM: 3800 }),
    ];
    const r = evaluate(ws);
    expect(r.get('sport_distance.ride.100000')).toMatchObject({ earnedDay: '2026-01-03', workoutId: ws[2]!.id, progress: 105_000 });
    expect(r.get('sport_distance.run.100000')).toMatchObject({ earnedDay: null, progress: 50_000 });
    expect(r.get('elevation.8848')).toMatchObject({ earnedDay: '2026-01-03', workoutId: ws[2]!.id });
    expect(r.get('elevation.4806')).toMatchObject({ earnedDay: '2026-01-01', workoutId: ws[0]!.id });
    expect(r.get('elevation.25000')).toMatchObject({ earnedDay: null, progress: 8900 });
  });

  it('awards firsts / longest activities with a small GPS tolerance', () => {
    const ws = [
      workout('2026-01-01', 'run', { distanceM: 4970 }),
      workout('2026-01-02', 'run', { distanceM: 4980 }),
      workout('2026-01-05', 'run', { distanceM: 21_000 }),
    ];
    const r = evaluate(ws);
    expect(r.get('longest.run.5000')).toMatchObject({ earnedDay: '2026-01-02', workoutId: ws[1]!.id });
    expect(r.get('longest.run.10000')).toMatchObject({ earnedDay: '2026-01-05' });
    expect(r.get('longest.run.21097.5')).toMatchObject({ earnedDay: '2026-01-05', progress: 21_000 });
    expect(r.get('longest.run.30000')!.earnedDay).toBeNull();
  });

  it('awards daily and weekly streaks', () => {
    // 8 days in a row from Monday 2026-01-05, then one activity per week for 3 more weeks
    const ws = [
      ...Array.from({ length: 8 }, (_, i) => workout(plusDays('2026-01-05', i), 'walk')),
      workout('2026-01-21', 'walk'),
      workout('2026-01-28', 'walk'),
    ];
    const r = evaluate(ws);
    expect(r.get('daily_streak.7')).toMatchObject({ earnedDay: '2026-01-11', progress: 8, workoutId: ws[6]!.id });
    expect(r.get('daily_streak.30')!.earnedDay).toBeNull();
    // weeks of 5, 12, 19, 26 Jan → the 4th week qualifies with its first active day (28 Jan)
    expect(r.get('weekly_streak.4')).toMatchObject({ earnedDay: '2026-01-28', progress: 4, workoutId: ws[9]!.id });
  });

  it('awards early bird, night owl, weekend warrior and variety', () => {
    const ws = [
      workout('2026-01-03', 'run', { hour: 6 }), // Saturday morning
      workout('2026-01-04', 'yoga', { hour: 22 }), // Sunday night
      workout('2026-01-10', 'swim', { hour: 3 }), // Saturday (night owl)
      workout('2026-01-11', 'ride'), // Sunday
    ];
    const r = evaluate(ws);
    expect(r.get('early_bird.1')).toMatchObject({ earnedDay: '2026-01-03', progress: 1 });
    expect(r.get('night_owl.1')).toMatchObject({ earnedDay: '2026-01-04', progress: 2 });
    expect(r.get('weekend_warrior.4')).toMatchObject({ earnedDay: null, progress: 2 });
    expect(r.get('variety.3')).toMatchObject({ earnedDay: '2026-01-10', workoutId: ws[2]!.id, progress: 4 });
  });

  it('awards ring streaks, perfect weeks and double move days', () => {
    const rings: EvalRingDay[] = Array.from({ length: 10 }, (_, i) => ({
      day: plusDays('2026-01-05', i),
      move: i === 2 ? 2.1 : 1.2,
      exercise: 1,
      stand: i === 8 ? 0.9 : 1,
    }));
    const r = evaluate([], { rings });
    expect(r.get('move_streak.7')).toMatchObject({ earnedDay: '2026-01-11', progress: 10, workoutId: null });
    expect(r.get('stand_streak.7')).toMatchObject({ earnedDay: '2026-01-11', progress: 8 });
    expect(r.get('perfect_week.1')).toMatchObject({ earnedDay: '2026-01-11', progress: 1 });
    expect(r.get('double_move.1')).toMatchObject({ earnedDay: '2026-01-07', progress: 1 });
  });

  it('counts completed monthly challenges', () => {
    const r = evaluate([], { challengeDays: ['2026-02-10', '2026-01-20'] });
    expect(r.get('challenges.1')).toMatchObject({ earnedDay: '2026-01-20', progress: 2 });
    expect(r.get('challenges.10')!.earnedDay).toBeNull();
  });
});

describe('monthly challenges', () => {
  it('computes progress and the completion day per month', () => {
    const ws = [
      { id: 1, sport: 'run', day: '2026-03-02', distanceM: 30_000, elevationM: 600 },
      { id: 2, sport: 'run', day: '2026-03-09', distanceM: 25_000, elevationM: 500 },
      { id: 3, sport: 'run', day: '2026-03-01', distanceM: 4_980, elevationM: 0 },
      { id: 4, sport: 'ride', day: '2026-05-01', distanceM: 210_000, elevationM: 0 },
    ];
    const months = computeChallenges(ws, '2026-03', '2026-05');
    expect(months.map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05']);
    const march = new Map(months[0]!.items.map((i) => [i.key, i]));
    expect(march.get('run50')).toMatchObject({ value: 59_980, completedDay: '2026-03-09' });
    expect(march.get('run100')!.completedDay).toBeNull();
    expect(march.get('climb1000')).toMatchObject({ value: 1100, completedDay: '2026-03-09' });
    expect(march.get('runs5k')).toMatchObject({ value: 3, completedDay: null });
    expect(march.get('active20')).toMatchObject({ value: 3 });
    expect(months[0]!.completed).toBe(2);
    expect(months[1]!.completed).toBe(0);
    expect(new Map(months[2]!.items.map((i) => [i.key, i])).get('ride200')).toMatchObject({ completedDay: '2026-05-01' });
  });

  it('lists months across year ends', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-02', '2026-01')).toEqual([]);
  });
});
