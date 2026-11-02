import { Gauge } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function FitnessPage() {
  const t = useT();
  return <Placeholder title={t('progress.titles.FitnessPage')} icon={Gauge} />;
}
