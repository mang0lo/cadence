import { Flame } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function HeatmapPage() {
  const t = useT();
  return <Placeholder title={t('maps.titles.HeatmapPage')} icon={Flame} />;
}
