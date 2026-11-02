import { Sparkles } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function YearInReviewPage() {
  const t = useT();
  return <Placeholder title={t('consistency.titles.YearInReviewPage')} icon={Sparkles} />;
}
