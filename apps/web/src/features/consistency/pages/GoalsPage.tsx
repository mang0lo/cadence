import { Target } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function GoalsPage() {
  const t = useT();
  return <Placeholder title={t('consistency.titles.GoalsPage')} icon={Target} />;
}
