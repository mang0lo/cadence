import { Trophy } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function TrophiesPage() {
  const t = useT();
  return <Placeholder title={t('consistency.titles.TrophiesPage')} icon={Trophy} />;
}
