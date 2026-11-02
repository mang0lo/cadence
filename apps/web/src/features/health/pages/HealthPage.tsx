import { HeartPulse } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function HealthPage() {
  const t = useT();
  return <Placeholder title={t('health.titles.HealthPage')} icon={HeartPulse} />;
}
