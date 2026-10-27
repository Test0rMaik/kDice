/**
 * wallet.ts — Klever Extension bridge + React binding (Phase 4.7).
 *
 * Hand-rolled `window.kleverWeb` integration (user-approved; proven by
 * dexscan's useKleverWallet.ts and Ogmara's klever.ts). No SDK dependency;
 * keys never leave the extension.
 *
 * Design lessons carried over from dexscan (PT-P2-8 hotfix, 2026-05-25):
 *  - persist the WALLET ADDRESS, not a "connected" boolean — silent
 *    restore re-verifies the extension's current address matches;
 *  - a tiny event bus keeps every mounted component in sync (multiple
 *    `useWallet` instances used to diverge without it);
 *  - a locked/denied extension degrades to "disconnected" silently,
 *    never a hard error on page load.
 */
import { useCallback, useEffect, useState } from 'react';
import { loadConfig } from './scClient';

// ── Errors ─────────────────────────────────────────────────────────────

/** Typed wallet-bridge failure (extension missing, locked, bad address). */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

// ── Provider pinning ───────────────────────────────────────────────────

/**
 * Derive the REST API host from the node host (`node.X` → `api.X`).
 * A local/custom node without the `node.` convention serves both APIs
 * from the same base — the fallback returns it unchanged.
 */
export function apiBaseUrl(nodeUrl: string): string {
  try {
    const u = new URL(nodeUrl);
    if (u.hostname.startsWith('node.')) {
      u.hostname = 'api.' + u.hostname.slice('node.'.length);
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return nodeUrl.replace(/\/+$/, '');
  }
}

/**
 * Provider pair pinned from the current SC config so wallet and contract
 * ALWAYS target the same network (Ogmara regression: initializing with
 * the wrong provider makes tx signatures land on the wrong chain).
 */
export function providerFor(nodeUrl: string): KleverProviderUrls {
  return { api: apiBaseUrl(nodeUrl), node: nodeUrl.replace(/\/+$/, '') };
}

// ── Module state + event bus ───────────────────────────────────────────

export interface WalletState {
  extensionAvailable: boolean;
  connecting: boolean;
  connected: boolean;
  address: string | null;
  /** Last user-facing connect failure (null when none). */
  error: string | null;
}

const ADDRESS_KEY = 'kdice.wallet.address.v1';
const BECH32_RE = /^klv1[02-9ac-hj-np-z]{20,60}$/;

let state: WalletState = {
  extensionAvailable: false,
  connecting: false,
  connected: false,
  address: null,
  error: null,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<WalletState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a broken listener must never wedge the bus */
    }
  }
}

/** Subscribe to wallet-state changes. Returns an unsubscribe fn. */
export function subscribeWallet(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Current snapshot (safe to read synchronously). */
export function getWalletState(): WalletState {
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Detection ──────────────────────────────────────────────────────────

/**
 * Wait up to `timeoutMs` for the extension to inject `window.kleverWeb`
 * (content scripts can land after DOMContentLoaded — Ogmara polls ≤3 s).
 */
export async function detectExtension(timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (typeof window !== 'undefined' && window.kleverWeb) {
      setState({ extensionAvailable: true });
      return true;
    }
    if (Date.now() - t0 >= timeoutMs) {
      setState({ extensionAvailable: false });
      return false;
    }
    await sleep(500);
  }
}

// ── Connect / restore / disconnect ─────────────────────────────────────

/**
 * Connect (or re-verify) the extension wallet and return the address.
 *
 * `silent = true` (session restore): a locked/denied extension is a
 * normal page-load condition, not an error — the state simply stays
 * "disconnected" and the stored address survives for an explicit click.
 */
export async function connectWallet(silent = false): Promise<string> {
  const kw = window.kleverWeb;
  if (!kw) {
    throw new WalletError('Klever Extension not detected — install it from klever.io');
  }
  setState({ connecting: true, ...(silent ? {} : { error: null }) });
  try {
    // Pin the network BEFORE initialize (Ogmara: racing this makes the
    // extension initialize on the wrong chain and reject later signatures).
    kw.provider = providerFor(loadConfig().nodeUrl);
    await kw.initialize();
    const address = await kw.getWalletAddress();
    if (typeof address !== 'string' || !BECH32_RE.test(address)) {
      throw new WalletError('Extension returned an invalid address: ' + String(address).slice(0, 40));
    }
    try {
      localStorage.setItem(ADDRESS_KEY, address);
    } catch {
      /* storage blocked — session-only connection still works */
    }
    setState({ connected: true, address, error: null });
    return address;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setState({ connected: false, address: null, ...(silent ? {} : { error: msg }) });
    throw err instanceof WalletError ? err : new WalletError(msg);
  } finally {
    setState({ connecting: false });
  }
}

/**
 * Silent session restore on app load: auto-attach ONLY if the extension
 * currently exposes the stored address (dexscan PT-P2-8 — a different
 * wallet in the extension must never be silently adopted).
 */
export async function restoreSession(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ADDRESS_KEY);
  } catch {
    stored = null;
  }
  if (!stored || !window.kleverWeb) return;
  const kw = window.kleverWeb;
  kw.provider = providerFor(loadConfig().nodeUrl);
  try {
    await kw.initialize();
    const current = await kw.getWalletAddress();
    if (current === stored) {
      setState({ connected: true, address: stored });
    } else {
      // A different wallet is exposed now — refuse the silent attach and
      // drop the stale pin; the user must click Connect explicitly.
      try {
        localStorage.removeItem(ADDRESS_KEY);
      } catch {
        /* noop */
      }
      setState({ connected: false, address: null });
    }
  } catch {
    /* locked/denied — stored address stays, Connect button is shown */
    setState({ connected: false, address: null });
  }
}

/** Drop the local session (the extension keeps its own authorization). */
export function disconnectWallet(): void {
  try {
    localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* noop */
  }
  setState({ connected: false, address: null, error: null });
}

let bootstrap: Promise<void> | null = null;

/** One-shot startup: detect the extension (≤3 s), then restore a session. */
export function bootstrapWallet(): Promise<void> {
  if (!bootstrap) {
    bootstrap = (async () => {
      await detectExtension();
      await restoreSession();
    })();
  }
  return bootstrap;
}

// ── Balance ────────────────────────────────────────────────────────────

const BALANCE_TIMEOUT_MS = 10_000;
const MAX_BALANCE_BYTES = 64 * 1024;

/**
 * KLV balance (whole-KLV units; 6-decimal chain precision kept) from the
 * node REST API — `GET {api}/v1.0/address/{addr}` (same route the operator
 * console uses, contracts/tools/lib.js `getAccount`).
 * 404 = account not yet on-chain on this network → 0 (normal for a fresh
 * wallet before its first faucet top-up).
 */
export async function getBalanceKLV(address: string): Promise<number> {
  if (!BECH32_RE.test(address)) throw new WalletError('invalid address for balance lookup');
  const base = apiBaseUrl(loadConfig().nodeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1.0/address/${address}`, { signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WalletError(`balance request timed out after ${BALANCE_TIMEOUT_MS} ms`);
    }
    throw new WalletError('balance request failed: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 404) return 0;
  if (!resp.ok) throw new WalletError(`balance HTTP ${resp.status}`);
  // Size cap before parsing — an unbounded body on a hostile response is
  // a resource-exhaustion vector (AGENTS §5C, mirrored from scClient).
  const text = await resp.text();
  if (text.length > MAX_BALANCE_BYTES) {
    throw new WalletError('balance response too large');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WalletError('balance endpoint returned non-JSON');
  }
  const account = (json as { data?: { account?: { balance?: unknown } } })?.data?.account;
  const raw = account?.balance;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / 1_000_000;
}

// ── React binding ──────────────────────────────────────────────────────

/**
 * React view over the module wallet state. Multiple mounted instances
 * stay consistent through the event bus (dexscan hotfix: plain per-
 * component state diverged once >1 instance mounted).
 */
export function useWallet(): WalletState & {
  connect: () => Promise<string>;
  disconnect: () => void;
} {
  const [snap, setSnap] = useState<WalletState>(() => ({ ...state }));
  useEffect(() => subscribeWallet(() => setSnap({ ...state })), []);
  const connect = useCallback(() => connectWallet(false), []);
  const disconnect = useCallback(() => disconnectWallet(), []);
  return { ...snap, connect, disconnect };
}
