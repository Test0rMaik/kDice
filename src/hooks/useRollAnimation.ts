/**
 * useRollAnimation — drives the single d100 die through random faces before
 * locking to the final value and firing `onSettle` exactly once.
 *
 * Timeline (total ~900 ms):
 *   - 0 → 65%:  rapid random faces (blur / shake via CSS class).
 *   - 65% → 100%: random faces until the last 25%, then the final face locks.
 *   - On completion: `onSettle` is called exactly once; UI flips to idle.
 */
import { useEffect, useRef, useState } from 'react';

export interface RollAnimation {
  /** Currently-displayed d100 face (final value or in-flight). */
  face: number;
  isRolling: boolean;
}

const ROLL_MS = 900;
const SETTLE_RATIO = 0.35;

function randomFace(): number {
  return 1 + Math.floor(Math.random() * 100);
}

export function useRollAnimation(
  status: 'idle' | 'rolling',
  finalFace: number,
  onSettle: () => void,
): RollAnimation {
  // `isRolling` is derived from `status` instead of mirrored in state: no
  // effect-driven setState, and the hook can never desync from the reducer.
  const isRolling = status === 'rolling';
  // In-flight face; only meaningful while rolling. While idle we always
  // report `finalFace` so a stale in-flight value can never leak to the UI.
  const [display, setDisplay] = useState<number>(finalFace);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!isRolling) return;
    settledRef.current = false;
    let start: number | null = null;
    let raf = 0;

    const tick = (now: number): void => {
      if (start === null) start = now;
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / ROLL_MS);

      if (progress < 1 - SETTLE_RATIO) {
        setDisplay(randomFace());
        raf = requestAnimationFrame(tick);
        return;
      }

      const settleT = (progress - (1 - SETTLE_RATIO)) / SETTLE_RATIO;
      // Lock the face when settleT ≥ 0.75 — leaves a small "freeze" moment.
      setDisplay(settleT >= 0.75 ? finalFace : randomFace());

      if (settleT >= 1) {
        setDisplay(finalFace);
        if (!settledRef.current) {
          settledRef.current = true;
          onSettle();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isRolling, finalFace, onSettle]);

  return { face: isRolling ? display : finalFace, isRolling };
}
