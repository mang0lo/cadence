import type { Dictionary } from '@/lib/i18n';

/** i18n namespace 'activities' → t('activities.…'). Always provide en + de. */
export const messages: Dictionary = {
  en: {
    nav: {
      dashboard: 'Dashboard',
      activities: 'Activities'
    },
    titles: {
      HomePage: 'Dashboard',
      ActivitiesPage: 'Activities',
      ActivityPage: 'Activity'
    }
  },
  de: {
    nav: {
      dashboard: 'Dashboard',
      activities: 'Aktivitäten'
    },
    titles: {
      HomePage: 'Dashboard',
      ActivitiesPage: 'Aktivitäten',
      ActivityPage: 'Aktivität'
    }
  }
};
