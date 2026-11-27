/**
 * Goal quantities of the consistency feature (apps/web/src/features/consistency/lib.ts): display rounding, the
 * locale-aware number input and the goal form's measure fallback.
 */
import { describe, expect, it } from 'vitest';
import type { GoalWithProgress } from '@cadence/shared';
import {
  changeGoalForm,
  classicDistance,
  fillGoalForm,
  formatGoalValue,
  formTarget,
  goalInputText,
  goalOutlook,
  hourLabel,
  previousYearCovered,
  reachedRounding,
  reviewWeeks,
  shownCalendarMetric,
  type GoalForm,
} from '@/features/consistency/lib';
import { messages } from '@/features/consistency/messages';
import { createFormatter } from '@/lib/format';
import type { Dictionary, Lang, Messages, TFunction } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';

/** Same lookup, plural and interpolation rules as I18nProvider. */
function makeT(lang: Lang, locale: string): TFunction {
  const namespaces: Record<string, Dictionary> = { common: commonMessages, consistency: messages };
  const plural = new Intl.PluralRules(locale);
  const lookup = (m: Messages | undefined, path: string[]) => {
    let cur: string | Messages | undefined = m;
    for (const p of path) cur = cur && typeof cur !== 'string' ? cur[p] : undefined;
    return cur;
  };
  return (key, vars) => {
    const [ns, ...path] = key.split('.');
    let msg = lookup(namespaces[ns!]?.[lang], path) ?? lookup(namespaces[ns!]?.en, path);
    if (msg && typeof msg === 'object') msg = (msg[plural.select(Number(vars?.count ?? 0))] ?? msg.other) as string;
    if (typeof msg !== 'string') return key;
    return vars ? msg.replace(/\{(\w+)\}/g, (_, n: string) => (n in vars ? String(vars[n]) : `{${n}}`)) : msg;
  };
}

const en = createFormatter('metric', 'en-US', 'en');
const enMi = createFormatter('imperial', 'en-US', 'en');
const de = createFormatter('metric', 'de-DE', 'de');
const tEn = makeT('en', 'en-US');
const tDe = makeT('de', 'de-DE');


describe('goal input text', () => {
  it('round-trips the text the form writes into the input', () => {
    for (const [fmt, v] of [
      [de, 42.195],
      [en, 42.195],
      [de, 1000],
      [en, 1250],
      [de, 0.5],
    ] as const) {
      const text = goalInputText(fmt, 'longest', v * 1000, 'year');
      expect(fmt.parseNumber(text, true)).toBe(v);
    }
    expect(goalInputText(de, 'longest', 42_195, 'year')).toBe('42,195');
    expect(goalInputText(de, 'distance', 1_000_000, 'year')).toBe('1000');
    expect(goalInputText(en, 'time', 5400, 'week')).toBe('1.5');
  });
});

describe('formatGoalValue', () => {
  it('never shows a target that is not reached yet', () => {
    // 49.6 of 50 km: rounding to the nearest would print "50 km of 50 km"
    expect(formatGoalValue(en, tEn, 'distance', 49_600, 'down')).toBe('49 km');
    expect(formatGoalValue(en, tEn, 'distance', 49_600)).toBe('50 km');
    expect(formatGoalValue(en, tEn, 'distance', 9_960, 'down')).toBe('9.9 km');
    // the decimals follow the displayed value, not meters: 15.9 km are 9.88 mi
    expect(formatGoalValue(enMi, tEn, 'distance', 15_900, 'down')).toBe('9.8 mi');
    expect(formatGoalValue(en, tEn, 'longest', 42_150, 'down')).toBe('42.1 km');
    expect(formatGoalValue(en, tEn, 'longest', 42_195)).toBe('42.2 km');
    expect(formatGoalValue(en, tEn, 'elevation', 999.6, 'down')).toBe('999 m');
    expect(formatGoalValue(en, tEn, 'elevation', 999.6)).toBe('1,000 m');
    expect(formatGoalValue(en, tEn, 'calories', 499.6, 'down')).toBe('499 kcal');
    expect(formatGoalValue(en, tEn, 'time', 5999, 'down')).toBe('1h 39m');
  });

  it('rounds what is still missing up and prints small distances in m or yd', () => {
    expect(formatGoalValue(en, tEn, 'longest', 45, 'up')).toBe('45 m');
    expect(formatGoalValue(enMi, tEn, 'longest', 45, 'up')).toBe('50 yd');
    expect(formatGoalValue(en, tEn, 'distance', 400, 'up')).toBe('400 m');
    expect(formatGoalValue(en, tEn, 'distance', 2_340, 'up')).toBe('2.4 km');
    expect(formatGoalValue(en, tEn, 'time', 30, 'up')).toBe('1m');
    expect(formatGoalValue(en, tEn, 'activities', 0.4, 'up')).toBe('1 activity');
  });

  it('prints zero time and counts through the dictionaries and the number format', () => {
    expect(formatGoalValue(en, tEn, 'time', 20)).toBe('0m');
    expect(formatGoalValue(de, tDe, 'time', 20)).toBe('0 Min.');
    expect(formatGoalValue(en, tEn, 'activities', 1234)).toBe('1,234 activities');
    expect(formatGoalValue(de, tDe, 'activities', 1000)).toBe('1.000 Aktivitäten');
    expect(formatGoalValue(de, tDe, 'active_days', 1)).toBe('1 Tag');
  });

  it('keeps the classic single distances of trophies', () => {
    expect(classicDistance(en, 21_097.5)).toBe('21.1 km');
    expect(classicDistance(en, 100_000)).toBe('100 km');
    expect(classicDistance(de, 3_800)).toBe('3,8 km');
  });

  it('rounds reached values to the nearest and open ones down', () => {
    expect(reachedRounding(49.6, 50)).toBe('down');
    expect(reachedRounding(50, 50)).toBe('nearest');
    expect(reachedRounding(42_196, 42_195)).toBe('nearest');
  });
});

describe('goal form', () => {
  const form = (f: Partial<GoalForm>): GoalForm => ({ period: 'week', sport: 'all', metric: 'active_days', target: '3', ...f });

  it('falls back to time and clears the number when the measure does not exist for the new period or sport', () => {
    expect(changeGoalForm(en, form({}), { period: 'day' })).toEqual(form({ period: 'day', metric: 'time', target: '' }));
    expect(changeGoalForm(en, form({ metric: 'distance', target: '50' }), { sport: 'strength' })).toEqual(
      form({ sport: 'strength', metric: 'time', target: '' }),
    );
  });

  it('keeps a time amount when its unit changes between minutes and hours', () => {
    expect(changeGoalForm(en, form({ period: 'day', metric: 'time', target: '30' }), { period: 'week' })).toEqual(
      form({ period: 'week', metric: 'time', target: '0.5' }),
    );
    expect(changeGoalForm(de, form({ metric: 'time', target: '1,5' }), { period: 'day' })).toEqual(
      form({ period: 'day', metric: 'time', target: '90' }),
    );
    // the same unit: nothing to convert
    expect(changeGoalForm(en, form({ metric: 'time', target: '5' }), { period: 'month' })).toEqual(
      form({ period: 'month', metric: 'time', target: '5' }),
    );
    expect(changeGoalForm(en, form({ metric: 'distance', target: '50' }), { period: 'month' })).toEqual(
      form({ period: 'month', metric: 'distance', target: '50' }),
    );
  });

  it('keeps the stored target while its number is not edited', () => {
    // 100 min per week shows as 1.67 h; changing only the sport must not save 6012 s
    const exact = { form: form({ metric: 'time', target: '1.67' }), target: 6000 };
    expect(formTarget(en, form({ metric: 'time', target: '1.67', sport: 'run' }), exact)).toBe(6000);
    expect(formTarget(en, form({ metric: 'time', target: '1.67', period: 'month' }), exact)).toBe(6000);
    // an imperial 100 km goal shows as 62.1 mi
    const km100 = { form: form({ metric: 'distance', target: '62.1' }), target: 100_000 };
    expect(formTarget(enMi, form({ metric: 'distance', target: '62.1', period: 'month' }), km100)).toBe(100_000);
    expect(formTarget(enMi, form({ metric: 'distance', target: '62' }), km100)).toBeCloseTo(99_779.3, 1);
  });

  it('keeps no stored target when a stored goal falls back to time', () => {
    // a distance goal of a sport without distance (an older catalogue): the emptied time field must not save 50,000 s
    const filled = fillGoalForm(en, { period: 'week', sport: 'strength', metric: 'distance' }, 50_000);
    expect(filled.form).toEqual(form({ sport: 'strength', metric: 'time', target: '' }));
    expect(filled.exact).toBeNull();
    expect(formTarget(en, filled.form, filled.exact)).toBeNaN();
    expect(formTarget(en, changeGoalForm(en, filled.form, { sport: 'run' }), filled.exact)).toBeNaN();
    // a combination that exists keeps its stored target while the number is untouched
    const kept = fillGoalForm(en, { period: 'week', sport: 'all', metric: 'time' }, 6000);
    expect(kept.form).toEqual(form({ metric: 'time', target: '1.67' }));
    expect(formTarget(en, changeGoalForm(en, kept.form, { sport: 'run' }), kept.exact)).toBe(6000);
  });

  it('reads a typed number in the unit of the form', () => {
    expect(formTarget(en, form({ metric: 'distance', target: '1,000', period: 'year' }))).toBe(1_000_000);
    expect(formTarget(de, form({ metric: 'elevation', target: '10.000', period: 'year' }))).toBe(10_000);
    expect(formTarget(de, form({ metric: 'longest', target: '42.195', period: 'year' }))).toBe(42_195);
    // time targets are whole minutes
    expect(formTarget(en, form({ metric: 'time', target: '1.67' }))).toBe(6000);
    expect(formTarget(en, form({ period: 'day', metric: 'time', target: '30' }))).toBe(1800);
    expect(formTarget(en, form({ target: 'x' }))).toBeNaN();
  });
});

describe('goalOutlook', () => {
  const goal = (current: Partial<GoalWithProgress['current']>, g: Partial<GoalWithProgress> = {}): GoalWithProgress => ({
    id: 1,
    position: 0,
    createdAt: 0,
    period: 'week',
    sport: null,
    metric: 'active_days',
    target: 5,
    history: [],
    hitRate: null,
    ...g,
    current: {
      start: '2026-11-23',
      end: '2026-11-29',
      value: 0,
      target: 5,
      fraction: 0,
      elapsedDays: 0,
      totalDays: 7,
      expected: 0,
      projected: 0,
      status: 'behind',
      remaining: 5,
      remainingDays: 7,
      perDayNeeded: null,
      checked: false,
      ...current,
    },
  });

  it('does not count a day left that is already active', () => {
    // Saturday, trained today (3rd active day): only Sunday can still add one
    const sat = goal({ value: 3, remaining: 2, remainingDays: 2, elapsedDays: 5, projected: 3.5, perDayNeeded: 1 });
    expect(goalOutlook(sat, tEn, en, false)).toContain('2 more active days needed, 2 days left');
    expect(goalOutlook(sat, tEn, en, true)).toBe('Out of reach this week — there are not enough days left');
    // Sunday, trained today (4th): nothing can be added any more
    const sun = goal({ value: 4, remaining: 1, remainingDays: 1, elapsedDays: 6, projected: 4, perDayNeeded: 1 });
    expect(goalOutlook(sun, tEn, en, true)).toBe('Out of reach this week — there are not enough days left');
    // Friday, trained today (3rd), 3 days left of which 2 can still count
    const fri = goal({ value: 3, remaining: 2, remainingDays: 3, elapsedDays: 4, projected: 4.2, perDayNeeded: 0.67 });
    expect(goalOutlook(fri, tEn, en, true)).toContain('2 more active days needed, 2 days left');
  });

  it('prints a remainder below the target precision instead of "0 km more"', () => {
    const longest = goal(
      { value: 42_150, target: 42_195, remaining: 45, remainingDays: 38, status: 'open', projected: 42_150 },
      { period: 'year', metric: 'longest', target: 42_195 },
    );
    expect(goalOutlook(longest, tEn, en)).toBe('Longest so far 42.1 km — 45 m more in one go, 38 days left');
  });
});

describe('year in review and calendar helpers', () => {
  it('averages per week over the weeks the data covers', () => {
    // the first year of data starts on 25 Nov: 37 days, not 52 weeks
    expect(reviewWeeks({ year: 2024, complete: true, firstDay: '2024-11-25', asOf: '2026-11-25' })).toBeCloseTo(37 / 7);
    expect(reviewWeeks({ year: 2025, complete: true, firstDay: '2024-11-25', asOf: '2026-11-25' })).toBeCloseTo(365 / 7);
    expect(reviewWeeks({ year: 2026, complete: false, firstDay: '2024-11-25', asOf: '2026-11-25' })).toBeCloseTo(329 / 7);
    expect(reviewWeeks({ year: 2026, complete: false, firstDay: '2026-06-01', asOf: '2026-11-25' })).toBeCloseTo(178 / 7);
    expect(reviewWeeks({ year: 2026, complete: false, firstDay: '2026-11-24', asOf: '2026-11-25' })).toBe(1);
    expect(reviewWeeks({ year: 2026, complete: false, firstDay: null, asOf: '2026-01-10' })).toBeCloseTo(10 / 7);
  });

  it('compares with the previous year only when the data covers it', () => {
    expect(previousYearCovered('2024-11-25', 2025)).toBe(false);
    expect(previousYearCovered('2024-01-31', 2025)).toBe(true);
    expect(previousYearCovered('2019-05-01', 2025)).toBe(true);
    expect(previousYearCovered(null, 2025)).toBe(true);
  });

  it('labels hours of the day in the locale clock', () => {
    expect(hourLabel(createFormatter('metric', 'en-US', 'en'), 7)).toBe('07:00 AM');
    expect(hourLabel(de, 7)).toBe('07:00');
    expect(hourLabel(de, 23)).toBe('23:00');
  });

  it('shows the move ring only for years with ring data', () => {
    expect(shownCalendarMetric('move', true)).toBe('move');
    expect(shownCalendarMetric('move', false)).toBe('minutes');
    expect(shownCalendarMetric('distance', false)).toBe('distance');
    expect(shownCalendarMetric('bogus' as never, true)).toBe('minutes');
  });
});
