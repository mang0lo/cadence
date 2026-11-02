import { Scale } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function BodyPage() {
  const t = useT();
  return <Placeholder title={t('health.titles.BodyPage')} icon={Scale} />;
}
