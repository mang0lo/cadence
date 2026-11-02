import { TrendingUp } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function ProgressPage() {
  const t = useT();
  return <Placeholder title={t('progress.titles.ProgressPage')} icon={TrendingUp} />;
}
