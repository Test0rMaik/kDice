/**
 * useSound.ts — lightweight WebAudio synth for casino-style feedback.
 *
 * Why a synth instead of audio files?
 *  - Zero asset weight, zero network fetches: the app must run offline (ROADMAP).
 *  - Deterministic: no codec / browser-support matrix to worry about.
 *  - The "slot machine" feel is just a handful of short square/sine blips.
 *
 * Browser autoplay policy: the AudioContext starts suspended until a user
 * gesture. `ensure()` calls `resume()` on every play attempt, which is the
 * recommended workaround and keeps the API fire-and-forget.
 *
 * The hook itself returns the raw SoundApi. The App decides *when* and
 * *which* sound to play (e.g. payout kind determines win vs. lose), keeping
 * this module free of game logic.
 */
import { useMemo } from 'react';

export interface SoundApi {
  roll: () => void;
  win: (payout: number) => void;
  lose: () => void;
}

type Ctx = AudioContext | undefined;

function createSound(): SoundApi {
  let ac: Ctx = undefined;

  function ensure(): AudioContext | null {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ac) ac = new Ctor();
    if (ac.state === 'suspended') {
      void ac.resume().catch(() => undefined);
    }
    return ac;
  }

  interface ToneOpts {
    freq: number;
    t: number;
    dur: number;
    type?: OscillatorType;
    vol?: number;
    glide?: number;
    curve?: 'lin' | 'exp';
  }

  /**
   * One blip = one oscillator + one gain envelope.
   * Gain ramps from 0 -> vol (15% of duration) -> 0 (remaining).
   * Exponential ramps are the idiomatic WebAudio shape for percussive hits;
   * we clamp the floor to a tiny non-zero so the curve stays valid.
   */
  function tone(ctx: AudioContext, { freq, t, dur, type = 'square', vol = 0.16, glide, curve = 'exp' }: ToneOpts): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glide !== undefined) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, glide), t + dur);
      else osc.frequency.linearRampToValueAtTime(glide, t + dur);
    }
    const attack = Math.max(0.004, dur * 0.15);
    gain.gain.setValueAtTime(0.0001, t);
    if (curve === 'exp') {
      gain.gain.exponentialRampToValueAtTime(vol, t + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else {
      gain.gain.linearRampToValueAtTime(vol, t + attack);
      gain.gain.linearRampToValueAtTime(0.0001, t + dur);
    }
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /**
   * Roll: 6 staggered "tick" pairs (two close pitches ~120 Hz apart) that
   * decay over ~0.6s — reads as a mechanical rattle without any samples.
   */
  function roll(): void {
    const ctx = ensure();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    for (let i = 0; i < 6; i += 1) {
      const t = now + i * 0.085;
      tone(ctx, { freq: 170 + i * 14, t, dur: 0.05, type: 'square', vol: 0.09 });
      tone(ctx, { freq: 255 + i * 10, t: t + 0.018, dur: 0.045, type: 'square', vol: 0.07 });
    }
    tone(ctx, { freq: 540, t: now + 0.62, dur: 0.1, type: 'triangle', vol: 0.12 });
  }

  function win(payout: number): void {
    const ctx = ensure();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    // Pitch scales mildly with the payout so a big win feels meaningfully
    // different from a small one; log10 keeps the curve pleasant.
    const scale = Math.min(1.5, Math.max(1, Math.log10(Math.max(2, payout)) / 2.2));
    const notes = [392, 523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i += 1) {
      tone(ctx, { freq: notes[i] * scale, t: now + i * 0.085, dur: 0.18, type: 'square', vol: 0.16, curve: 'lin' });
    }
    tone(ctx, { freq: 1046.5 * scale, t: now + 0.42, dur: 0.5, type: 'triangle', vol: 0.11, curve: 'lin' });
    // Sub-bass thump underneath the fanfare gives it "cabinet" weight.
    tone(ctx, { freq: 82, t: now, dur: 0.5, type: 'sine', vol: 0.22, curve: 'lin' });
  }

  function lose(): void {
    const ctx = ensure();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    tone(ctx, { freq: 220, t: now, dur: 0.28, type: 'triangle', vol: 0.14, glide: 110, curve: 'lin' });
    tone(ctx, { freq: 110, t: now + 0.1, dur: 0.4, type: 'sine', vol: 0.18, glide: 55, curve: 'lin' });
  }

  return { roll, win, lose };
}

/**
 * Returns a stable SoundApi. The API object is created once per mount (its
 * closures hold the component-local AudioContext); the sound functions are
 * pure, so re-creating them on every render would be safe but wasteful.
 * useMemo with empty deps is the idiomatic "create once" form and avoids
 * reading refs during render (react/refs).
 */
export function useSound(): SoundApi {
  return useMemo(() => createSound(), []);
}

