import type { Dictionary } from '@/lib/i18n';

export const overview: Dictionary = {
  en: {
    subtitle: 'Your key health metrics at a glance',
    groups: {
      heart: 'Heart & fitness',
      sleepVitals: 'Sleep & vitals',
      body: 'Body',
      activity: 'Daily activity',
    },
    sleepName: 'Time asleep',
    latest: 'Latest',
    avg30: '30-day avg',
    vsPrev: 'vs. previous 30 days',
    notEnough: 'Not enough data to compare',
    perNight: 'per night',
    dataPoints: '{count} readings',
    quickLinks: 'Explore',
    emptyDescription: 'None of the key metrics are in your export yet. All other data is available under "All data".',
  },
  de: {
    subtitle: 'Deine wichtigsten Gesundheitswerte auf einen Blick',
    groups: {
      heart: 'Herz & Fitness',
      sleepVitals: 'Schlaf & Vitalwerte',
      body: 'Körper',
      activity: 'Tägliche Aktivität',
    },
    sleepName: 'Schlafdauer',
    latest: 'Zuletzt',
    avg30: '30-Tage-Ø',
    vsPrev: 'ggü. den 30 Tagen davor',
    notEnough: 'Zu wenig Daten für einen Vergleich',
    perNight: 'pro Nacht',
    dataPoints: '{count} Messwerte',
    quickLinks: 'Erkunden',
    emptyDescription: 'Keine der Kennzahlen ist bisher in deinem Export enthalten. Alle übrigen Daten findest du unter „Alle Daten“.',
  },
};
