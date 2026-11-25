import type { WorkoutPatch } from '@cadence/shared';

/** Whether a patch starts a background re-derivation on the server (it changes what features aggregate). */
export const rederives = (patch: WorkoutPatch): boolean => patch.sport !== undefined || patch.hidden !== undefined;

/**
 * Which cached queries a workout patch makes outdated right away. The patched workout's own detail is replaced with
 * the response; its streams change only with a re-derivation, whose end refreshes everything (useImportJobs). Notes
 * only show up in the dashboard feed. A name, sport or hidden flag shows up in every feature (titles, sport filters,
 * totals); core queries (settings, profile, import jobs, …) are not affected.
 */
export function patchOutdates(patch: WorkoutPatch, id: number): (key: readonly unknown[]) => boolean {
  const own = (key: readonly unknown[]) =>
    key[0] === 'activities' && (key[1] === 'streams' || (key[1] === 'detail' && key[2] === id));
  if (patch.name !== undefined || rederives(patch)) return (key) => key[0] !== 'core' && !own(key);
  if (patch.notes !== undefined) return (key) => key[0] === 'activities' && key[1] === 'feed';
  return () => false;
}
