import { Waypoints } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function SegmentsPage() {
  const t = useT();
  return <Placeholder title={t('maps.titles.SegmentsPage')} icon={Waypoints} />;
}
