import type { Dictionary } from '@/lib/i18n';

/** i18n namespace 'progress' → t('progress.…'). Always provide en + de. */
export const messages: Dictionary = {
  en: {
    nav: {
      progress: 'Progress',
      records: 'Records',
      fitness: 'Fitness & Freshness'
    },
    titles: {
      ProgressPage: 'Progress',
      RecordsPage: 'Records',
      FitnessPage: 'Fitness & Freshness'
    }
  },
  de: {
    nav: {
      progress: 'Fortschritt',
      records: 'Bestleistungen',
      fitness: 'Fitness & Form'
    },
    titles: {
      ProgressPage: 'Fortschritt',
      RecordsPage: 'Bestleistungen',
      FitnessPage: 'Fitness & Form'
    }
  }
};
