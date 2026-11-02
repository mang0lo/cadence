import type { Dictionary } from '@/lib/i18n';

/** i18n namespace 'maps' → t('maps.…'). Always provide en + de. */
export const messages: Dictionary = {
  en: {
    nav: {
      heatmap: 'Heatmap',
      explorer: 'Explorer',
      routes: 'Routes',
      segments: 'Segments'
    },
    titles: {
      HeatmapPage: 'Heatmap',
      ExplorerPage: 'Explorer',
      RoutesPage: 'Routes',
      RoutePage: 'Route',
      SegmentsPage: 'Segments',
      SegmentPage: 'Segment'
    }
  },
  de: {
    nav: {
      heatmap: 'Heatmap',
      explorer: 'Explorer',
      routes: 'Strecken',
      segments: 'Segmente'
    },
    titles: {
      HeatmapPage: 'Heatmap',
      ExplorerPage: 'Explorer',
      RoutesPage: 'Strecken',
      RoutePage: 'Strecke',
      SegmentsPage: 'Segmente',
      SegmentPage: 'Segment'
    }
  }
};
