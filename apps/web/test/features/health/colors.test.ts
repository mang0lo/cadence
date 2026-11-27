import { describe, expect, it } from 'vitest';
import { assignSlots, categorySlots, compareCategoryValues } from '@/features/health/lib/colors';

describe('health category colors', () => {
  it('colors a category value by identity, whatever its rank or the other values of the range', () => {
    // the server sends categories by total, descending: the rank flips between ranges
    const ninetyDays = categorySlots(['Medium', 'Light', 'Heavy']);
    const oneYear = categorySlots(['Light', 'Heavy', 'Medium']);
    const onlyHeavy = categorySlots(['Heavy']);
    expect(oneYear).toEqual(ninetyDays);
    expect(onlyHeavy.get('Heavy')).toBe(ninetyDays.get('Heavy'));
    expect(new Set(ninetyDays.values()).size).toBe(3);
    expect(categorySlots(['Idle', 'Stood']).get('Stood')).toBe(categorySlots(['Stood']).get('Stood'));
  });

  it('knows the symptom values as the import stores them (HKCategoryValueSeverity… → Severity…)', () => {
    // 'SeverityUnspecified' must not move to another color when a severe headache enters the range
    const ninetyDays = categorySlots(['SeverityMild', 'SeverityUnspecified']);
    const oneYear = categorySlots(['SeverityMild', 'SeverityUnspecified', 'SeveritySevere', 'SeverityNotPresent']);
    expect(oneYear.get('SeverityUnspecified')).toBe(ninetyDays.get('SeverityUnspecified'));
    expect(oneYear.get('SeverityMild')).toBe(ninetyDays.get('SeverityMild'));
    expect(new Set(oneYear.values()).size).toBe(4);
    expect(['SeveritySevere', 'SeverityNotPresent', 'SeverityMild', 'SeverityUnspecified', 'SeverityModerate'].sort(compareCategoryValues)).toEqual([
      'SeverityUnspecified',
      'SeverityNotPresent',
      'SeverityMild',
      'SeverityModerate',
      'SeveritySevere',
    ]);
    const presence = categorySlots(['PresencePresent', 'PresenceNotPresent']);
    expect(presence.get('PresenceNotPresent')).toBe(categorySlots(['PresenceNotPresent']).get('PresenceNotPresent'));
    expect(presence.get('PresencePresent')).toBe(categorySlots(['PresencePresent']).get('PresencePresent'));
    expect(presence.get('PresencePresent')).not.toBe(presence.get('PresenceNotPresent'));
  });

  it('gives unknown values distinct hash slots next to the known ones', () => {
    const slots = categorySlots(['Stood', 'Idle', 'SomethingNew', 'Other']);
    expect(new Set(slots.values()).size).toBe(4);
    expect([...slots.values()].every((s) => s >= 1 && s <= 8)).toBe(true);
    expect(categorySlots(['Other', 'SomethingNew'])).toEqual(categorySlots(['SomethingNew', 'Other']));
  });

  it('orders values the same way in every range (ordinal scales low to high)', () => {
    expect(['Heavy', 'Light', 'Medium'].sort(compareCategoryValues)).toEqual(['Light', 'Medium', 'Heavy']);
    expect(['Zeta', 'Idle', 'Alpha', 'Stood'].sort(compareCategoryValues)).toEqual(['Stood', 'Idle', 'Alpha', 'Zeta']);
  });

  it('keeps the slots of sources as before', () => {
    const slots = assignSlots(['Apple Watch', 'iPhone']);
    expect(slots.get('Apple Watch')).toBeGreaterThanOrEqual(1);
    expect(slots.get('Apple Watch')).not.toBe(slots.get('iPhone'));
  });
});
