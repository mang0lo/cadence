import type { Dictionary } from '@/lib/i18n';

export const body: Dictionary = {
  en: {
    subtitle: 'Weight, body composition and blood pressure',
    tiles: {
      change30: 'vs. 30 days ago',
      noChange: 'Not enough data for a 30-day comparison',
    },
    weight: { title: 'Weight', subtitle: 'Daily measurements and their 7-day average' },
    monthly: {
      title: 'Monthly change',
      subtitle: 'Average weight of each month compared with the month before',
      change: 'Change',
      average: 'Average',
      avgChange: 'Average change: {value} per month',
    },
    bmi: { title: 'Body mass index', subtitle: 'Weight divided by height squared', computed: 'Calculated from weight and height' },
    fat: { title: 'Body fat', subtitle: 'Share of your body weight that is fat' },
    lean: {
      title: 'Lean body mass',
      subtitle: 'Weight without body fat',
      computed: 'Calculated from weight and body fat',
    },
    height: { title: 'Height' },
    bp: {
      title: 'Blood pressure',
      subtitle: 'Readings from your cuff or entered by hand',
      systolic: 'Systolic',
      diastolic: 'Diastolic',
      pulse: 'Pulse',
      category: 'Category',
      latest: 'Latest reading',
      average: 'Average',
      readings: '{count} readings',
      none: 'No blood pressure readings in this time range.',
      hint: 'Categories follow the ACC/AHA guideline for resting readings. This is not medical advice.',
      cat: {
        normal: 'Normal',
        elevated: 'Elevated',
        stage1: 'High, stage 1',
        stage2: 'High, stage 2',
        crisis: 'Very high',
      },
    },
    empty: {
      title: 'No body measurements yet',
      description:
        'Weight, body fat and blood pressure appear here once your export contains them – from a smart scale, a blood pressure cuff or manual entries in the Health app.',
    },
  },
  de: {
    subtitle: 'Gewicht, Körperzusammensetzung und Blutdruck',
    tiles: {
      change30: 'ggü. vor 30 Tagen',
      noChange: 'Zu wenig Daten für einen 30-Tage-Vergleich',
    },
    weight: { title: 'Gewicht', subtitle: 'Tägliche Messwerte und ihr 7-Tage-Durchschnitt' },
    monthly: {
      title: 'Veränderung pro Monat',
      subtitle: 'Durchschnittsgewicht jedes Monats im Vergleich zum Vormonat',
      change: 'Veränderung',
      average: 'Durchschnitt',
      avgChange: 'Ø Veränderung: {value} pro Monat',
    },
    bmi: { title: 'Body-Mass-Index', subtitle: 'Gewicht geteilt durch Körpergröße zum Quadrat', computed: 'Aus Gewicht und Körpergröße berechnet' },
    fat: { title: 'Körperfett', subtitle: 'Anteil des Körpergewichts, der Fett ist' },
    lean: {
      title: 'Fettfreie Körpermasse',
      subtitle: 'Gewicht ohne Körperfett',
      computed: 'Aus Gewicht und Körperfett berechnet',
    },
    height: { title: 'Körpergröße' },
    bp: {
      title: 'Blutdruck',
      subtitle: 'Messwerte deines Blutdruckmessers oder von Hand eingetragen',
      systolic: 'Systolisch',
      diastolic: 'Diastolisch',
      pulse: 'Puls',
      category: 'Kategorie',
      latest: 'Letzte Messung',
      average: 'Durchschnitt',
      readings: '{count} Messungen',
      none: 'In diesem Zeitraum gibt es keine Blutdruckmessungen.',
      hint: 'Die Kategorien folgen der ACC/AHA-Leitlinie für Ruhemessungen. Das ist keine medizinische Beratung.',
      cat: {
        normal: 'Normal',
        elevated: 'Erhöht',
        stage1: 'Hoch, Stufe 1',
        stage2: 'Hoch, Stufe 2',
        crisis: 'Sehr hoch',
      },
    },
    empty: {
      title: 'Noch keine Körpermessungen',
      description:
        'Gewicht, Körperfett und Blutdruck erscheinen hier, sobald dein Export sie enthält – von einer smarten Waage, einem Blutdruckmessgerät oder manuellen Einträgen in der Health-App.',
    },
  },
};
