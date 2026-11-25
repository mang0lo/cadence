import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { User } from 'lucide-react';
import type { AthleteSettings } from '@cadence/shared';
import { Button, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { BirthDateSetting, Section } from './controls';

/** Settings → profile: name, birth date and sex (overrides of what the Apple Health export says). */
export function ProfileSection({ set }: { set: (patch: Partial<AthleteSettings>) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { settings, athlete } = useSettings();
  const [name, setName] = useState(athlete?.name ?? '');
  useEffect(() => setName(athlete?.name ?? ''), [athlete?.name]);
  return (
    <Section title={t('platform.settings.profile')} icon={User}>
      <Field label={t('platform.settings.name')}>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-72" />
          <Button
            disabled={!name.trim() || name === athlete?.name}
            onClick={async () => {
              await api.patch('/athlete', { name: name.trim() });
              await qc.invalidateQueries({ queryKey: ['core', 'athlete'] });
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('platform.settings.birthDate')}>
          <BirthDateSetting
            override={settings.birthDate}
            shown={athlete?.birthDate ?? null}
            onSave={(v) => set({ birthDate: v })}
          />
        </Field>
        <Field label={t('platform.settings.sex')}>
          <Select
            value={settings.sex ?? 'auto'}
            onChange={(v) => set({ sex: v === 'auto' ? null : v })}
            options={(['auto', 'male', 'female', 'other'] as const).map((v) => ({ value: v, label: t(`platform.settings.sexes.${v}`) }))}
          />
        </Field>
      </div>
    </Section>
  );
}
