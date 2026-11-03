import { useEffect } from 'react';
import type { Playback } from './playback';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Replay keys: space play/pause, ←/→ jump 1 % (shift 5 %), +/− speed. Ignored while typing or with a dialog open. */
export function usePlaybackKeys(playback: Playback | null): void {
  useEffect(() => {
    if (!playback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.target instanceof Element && e.target.closest('dialog')) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (e.target instanceof Element && e.target.closest('button, a, summary, [role="radio"], [role="slider"]')) return;
        e.preventDefault();
        playback.toggle();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        playback.step((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.05 : 0.01));
      } else if (e.key === '+' || e.key === '=') playback.faster(1);
      else if (e.key === '-' || e.key === '_') playback.faster(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback]);
}
