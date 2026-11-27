import { Eye, EyeOff, Shapes } from 'lucide-react';
import type { ActivityListItem } from '@cadence/shared';
import { IconButton } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/** Quick actions of a list row: hide / show and change the sport. */
export interface RowActions {
  onHide: (w: ActivityListItem) => void;
  onSport: (w: ActivityListItem) => void;
  busyId: number | null;
}

export function Actions({ w, a }: { w: ActivityListItem; a: RowActions }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end gap-0.5">
      <IconButton
        icon={w.hidden ? Eye : EyeOff}
        label={w.hidden ? t('activities.list.unhide') : t('activities.list.hide')}
        onClick={() => a.onHide(w)}
        disabled={a.busyId === w.id}
      />
      <IconButton icon={Shapes} label={t('activities.list.changeSport')} onClick={() => a.onSport(w)} />
    </div>
  );
}
