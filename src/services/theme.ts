/**
 * theme.ts — light/dark theme (Phase 6).
 *
 * Resolution order (first match wins):
 *   1. explicit user choice, persisted in localStorage (`kdice-theme`);
 *   2. OS preference via `prefers-color-scheme` — followed LIVE while the
 *      user has not made an explicit choice, so a system theme flip is
 *      picked up without a reload.
 *
 * The theme is expressed as `document.documentElement.dataset.theme` and
 * consumed purely through CSS custom properties (`:root[data-theme='light']`
 * in index.css) — no component re-render is needed to repaint the UI.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'kdice-theme';

/** Read the persisted explicit choice (null = user never chose). */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // storage blocked (private mode) — fall back to system
  }
}

/** OS-level preference (dark is the app's native look). */
export function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Theme to apply on first load. */
export function initialTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** Paint the document with the given theme (safe before/without React). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Persist + apply an explicit user choice. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage blocked — theme still applies for this session */
  }
}

/** Flip the theme, persist the choice, return the new value. */
export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
