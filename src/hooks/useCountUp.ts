/**
 * useCountUp — tweens a displayed number toward `target` (ease-out, ~550 ms)
 * so dashboard stat cards "count up" when a roll settles.
 *
 * - Re-targeting mid-animation continues from the currently displayed value
 *   (never jumps), so rapid consecutive settlements stay smooth.
 * - `prefers-reduced-motion` users get an instant jump (no tween).
 */
import { useEffect, useRef, useState } from 'react';

export function useCountUp(target: number, durationMs = 550): number {
  const [value, setValue] = useState(target);
  // Displayed value kept in a ref so a re-target mid-animation tweens from
  // "where the eye currently sees it" instead of from the previous target.
  const displayRef = useRef(target);
  const rafRef = useRef(0);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = displayRef.current;
    if (reduced || from === target || !Number.isFinite(target)) {
      displayRef.current = target;
      setValue(target);
      return;
    }
    let start: number | null = null;
    const tick = (now: number): void => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const v = from + (target - from) * eased;
      displayRef.current = v;
      setValue(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs]);

  return value;
}