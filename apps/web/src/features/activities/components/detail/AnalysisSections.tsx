import type { ActivityAnalysis, WorkoutDetail } from '@cadence/shared';
import type { Prepared } from '../../lib/streams';

export interface SectionProps {
  w: WorkoutDetail;
  P: Prepared | null;
  analysis: ActivityAnalysis | undefined;
  zoneBounds: number[];
  onSelect: (s: [number, number] | null) => void;
}

/** Splits, laps, zones, best efforts, analysis cards, climbs, histograms and the comparison with similar efforts. */
export function AnalysisSections(_props: SectionProps) {
  return null;
}
