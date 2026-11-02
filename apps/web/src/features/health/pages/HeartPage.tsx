import { Heart } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function HeartPage() {
  const t = useT();
  return <Placeholder title={t('health.titles.HeartPage')} icon={Heart} />;
}
