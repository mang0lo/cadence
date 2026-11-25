import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

/**
 * Local copy of a saved setting while the user edits it. Edits stay local until the control commits them (on blur,
 * Enter, or when a slider stops), so there is no request per keystroke and a controlled input never jumps back to the
 * saved value while a request runs. While nothing is edited, the draft follows the saved value.
 */
export function useDraft<T>(saved: T) {
  const [draft, setDraft] = useState(saved);
  const dirty = useRef(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const key = JSON.stringify(saved);
  useEffect(() => {
    if (!dirty.current) setDraft(savedRef.current);
  }, [key]);

  /** A change by the user: kept until `done` or `reset`. */
  const edit = useCallback((v: SetStateAction<T>) => {
    dirty.current = true;
    setDraft(v);
  }, []);
  /** Drop the edit and show the saved value again. */
  const reset = useCallback(() => {
    dirty.current = false;
    setDraft(savedRef.current);
  }, []);
  /** The edit was handed over for saving: follow the saved value again. */
  const done = useCallback(() => {
    dirty.current = false;
  }, []);
  return { draft, edit, reset, done };
}
