import type { Dictionary } from '@/lib/i18n';

/** i18n namespace 'consistency' → t('consistency.…'). Always provide en + de. */
export const messages: Dictionary = {
  en: {
    nav: {
      consistency: 'Consistency',
      goals: 'Goals',
      trophies: 'Trophies',
      year: 'Year in Review'
    },
    titles: {
      ConsistencyPage: 'Consistency',
      GoalsPage: 'Goals',
      TrophiesPage: 'Trophies',
      YearInReviewPage: 'Year in Review'
    }
  },
  de: {
    nav: {
      consistency: 'Konstanz',
      goals: 'Ziele',
      trophies: 'Trophäen',
      year: 'Jahresrückblick'
    },
    titles: {
      ConsistencyPage: 'Konstanz',
      GoalsPage: 'Ziele',
      TrophiesPage: 'Trophäen',
      YearInReviewPage: 'Jahresrückblick'
    }
  }
};
