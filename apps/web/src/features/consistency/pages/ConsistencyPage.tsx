import { CalendarCheck } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function ConsistencyPage() {
  const t = useT();
  return <Placeholder title={t('consistency.titles.ConsistencyPage')} icon={CalendarCheck} />;
}
