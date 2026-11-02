import type { Dictionary } from '@/lib/i18n';

/** i18n namespace 'health' → t('health.…'). Always provide en + de. */
export const messages: Dictionary = {
  en: {
    nav: {
      overview: 'Health',
      sleep: 'Sleep',
      heart: 'Heart',
      body: 'Body',
      explorer: 'All data',
      ecg: 'ECG'
    },
    titles: {
      HealthPage: 'Health',
      SleepPage: 'Sleep',
      HeartPage: 'Heart',
      BodyPage: 'Body',
      ExplorerPage: 'All data',
      MetricPage: 'Metric',
      EcgPage: 'ECG'
    }
  },
  de: {
    nav: {
      overview: 'Gesundheit',
      sleep: 'Schlaf',
      heart: 'Herz',
      body: 'Körper',
      explorer: 'Alle Daten',
      ecg: 'EKG'
    },
    titles: {
      HealthPage: 'Gesundheit',
      SleepPage: 'Schlaf',
      HeartPage: 'Herz',
      BodyPage: 'Körper',
      ExplorerPage: 'Alle Daten',
      MetricPage: 'Messwert',
      EcgPage: 'EKG'
    }
  }
};
