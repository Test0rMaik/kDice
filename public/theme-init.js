/**
 * theme-init.js — pre-paint theme bootstrapping (Phase 6).
 *
 * Runs BEFORE the app bundle so `<html data-theme>` is set on first paint —
 * no dark→light flash. Mirrors `src/services/theme.ts` resolution:
 * explicit localStorage choice wins, otherwise the OS preference.
 * Kept as dependency-free plain JS in /public (copied as-is, CSP 'self'-safe).
 */
(function () {
  try {
    var t = localStorage.getItem('kdice-theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = t;
  } catch {
    /* storage blocked / no matchMedia — CSS default (dark) applies */
  }
})();