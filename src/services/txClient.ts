/**
 * txClient.ts — smart-contract invocation via the Klever Extension
 * (Phase 4.7).
 *
 * Wire path (proven by Ogmara/web/src/lib/klever.ts `invokeContractVia
 * Extension` and the kDice operator console contracts/tools/lib.js):
 *
 *   callData  = base64("fn@hexArg1@hexArg2…")
 *   contracts = [{ type: 63, payload: { scType: 0, address, callValue: {} } }]
 *   buildTransaction(contracts, [callData]) → signTransaction →
 *   broadcastTransactions([signed]) → data.txsHashes[0]
 *
 * The extension owns key handling; the dApp never sees a private key.
 * Hardening mirrors scClient.ts (AGENTS §5C): timeouts, size caps,
 * strict arg validation, typed errors.
 */
import { loadConfig } from './scClient';
import { apiBaseUrl, connectWallet, getWalletState } from './wallet';

// ── Errors ─────────────────────────────────────────────────────────────

/** Which stage of the build→sign→broadcast→confirm pipeline failed. */
export type TxStage = 'prepare' | 'build' | 'sign' | 'broadcast' | 'confirm';

/** Typed transaction failure, tagged with the failing stage. */
export class TxError extends Error {
  readonly stage: TxStage;
  constructor(stage: TxStage, message: string) {
    super(message);
    this.name = 'TxError';
    this.stage = stage;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Arg encoding (identical rules to contracts/tools/lib.js) ──────────

/**
 * Non-negative integer → minimal big-endian hex token, EVEN length
 * (`0` → `"00"`). The node's hex decoder rejects odd-length tokens
 * ("tokenize failed"), so this padding is mandatory — the deploy script
 * hit exactly that with a bare `2`.
 */
export function minimalHex(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new TxError('prepare', `expected a non-negative integer, got ${value}`);
  }
  let hex = BigInt(value).toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return hex;
}

const FUNC_RE = /^[a-z][a-z0-9_]{0,63}$/i;
const HEX_ARG_RE = /^[0-9a-fA-F]+$/;

/** Validate the call surface before it touches the extension (AGENTS §5C). */
function assertCallArgs(funcName: string, hexArgs: readonly string[]): void {
  if (!FUNC_RE.test(funcName)) {
    throw new TxError('prepare', `invalid function name: ${funcName.slice(0, 40)}`);
  }
  for (const a of hexArgs) {
    if (
      typeof a !== 'string' ||
      a.length === 0 ||
      a.length > 256 ||
      a.length % 2 !== 0 ||
      !HEX_ARG_RE.test(a)
    ) {
      throw new TxError('prepare', 'invalid hex argument (expected even-length hex, ≤128 bytes)');
    }
  }
}

// ── Invocation ─────────────────────────────────────────────────────────

/**
 * Invoke a contract endpoint through the extension and return the
 * broadcast tx hash (unconfirmed — pair with `waitForTx`).
 *
 * `hexArgs` must already be hex tokens: `minimalHex` for numbers,
 * `bytesToHex` for byte buffers (64 chars for the 32-byte seeds/hash).
 */
export async function invokeContract(
  contract: string,
  funcName: string,
  hexArgs: readonly string[],
): Promise<string> {
  const kw = window.kleverWeb;
  if (!kw) throw new TxError('prepare', 'Klever Extension not detected — connect a wallet first');
  if (!/^klv1[02-9ac-hj-np-z]{20,60}$/.test(contract)) {
    throw new TxError('prepare', 'invalid contract address');
  }
  assertCallArgs(funcName, hexArgs);

  // Ensure an initialized session (no-op path if already connected).
  if (!getWalletState().connected) {
    try {
      await connectWallet(true);
    } catch {
      throw new TxError('prepare', 'wallet session not active — click Connect first');
    }
  }

  // callData: "fn@hex@hex…" → base64 — the exact encoding buildCallData
  // in contracts/tools/lib.js produces (pure ASCII, so btoa is safe).
  const callDataB64 = btoa([funcName, ...hexArgs].join('@'));

  let unsigned: KleverTx;
  try {
    unsigned = await kw.buildTransaction(
      [{ type: 63, payload: { scType: 0, address: contract, callValue: {} } }],
      [callDataB64],
    );
  } catch (err) {
    throw new TxError('build', 'buildTransaction failed: ' + msg(err));
  }

  let signed: KleverTx;
  try {
    signed = await kw.signTransaction(unsigned);
  } catch (err) {
    throw new TxError('sign', 'signature refused or failed: ' + msg(err));
  }

  let result: KleverBroadcastResult;
  try {
    result = await kw.broadcastTransactions([signed]);
  } catch (err) {
    throw new TxError('broadcast', 'broadcast failed: ' + msg(err));
  }

  const hash = result?.data?.txsHashes?.[0];
  if (typeof hash !== 'string' || hash.length < 8 || hash.length > 128) {
    throw new TxError('broadcast', 'broadcast did not return a valid tx hash');
  }
  return hash;
}

// ── Confirmation polling ───────────────────────────────────────────────

const TX_TIMEOUT_MS = 90_000;
const TX_POLL_MS = 5_000;
const TX_FETCH_MS = 10_000;
const MAX_TX_BYTES = 256 * 1024;

interface TxStatusEnvelope {
  error?: unknown;
  data?: {
    transaction?: {
      status?: string;
      resultCode?: string;
      resultMessage?: string;
    };
  };
}

/**
 * One status probe. Transient failures (timeout, network blip, 404 =
 * "not indexed yet") resolve to `null` so the caller can retry — same
 * semantics as `waitForTx` in contracts/tools/scripts/deploy-verify.mjs.
 */
async function fetchTxStatus(hash: string): Promise<TxStatusEnvelope | null> {
  const base = apiBaseUrl(loadConfig().nodeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TX_FETCH_MS);
  try {
    const resp = await fetch(`${base}/v1.0/transaction/${hash}`, { signal: controller.signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new TxError('confirm', `tx status HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.length > MAX_TX_BYTES) throw new TxError('confirm', 'tx status response too large');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TxError('confirm', 'tx status endpoint returned non-JSON');
    }
    const env = json as TxStatusEnvelope;
    if (env.error) {
      throw new TxError('confirm', 'node error: ' + (typeof env.error === 'string' ? env.error : JSON.stringify(env.error).slice(0, 120)));
    }
    return env;
  } catch (err) {
    if (err instanceof TxError) throw err;
    return null; // transient — retry until the outer timeout
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until the tx is confirmed (deploy-verify `waitForTx` semantics):
 * `confirmed`/`success` → resolve; `fail|reject|error` → throw with the
 * node's status; otherwise retry every 5 s up to `timeoutMs`.
 */
export async function waitForTx(hash: string, timeoutMs = TX_TIMEOUT_MS): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const env = await fetchTxStatus(hash);
    const status = typeof env?.data?.transaction?.status === 'string'
      ? env.data.transaction.status
      : '';
    if (/confirmed|success/i.test(status)) return;
    if (/fail|reject|error/i.test(status)) {
      const extra = env?.data?.transaction?.resultCode ?? env?.data?.transaction?.resultMessage ?? '';
      throw new TxError('confirm', `tx ${hash.slice(0, 16)}… ${status} ${extra}`.trim());
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new TxError('confirm', `tx ${hash.slice(0, 16)}… not confirmed within ${Math.round(timeoutMs / 1000)} s`);
    }
    await new Promise((r) => setTimeout(r, TX_POLL_MS));
  }
}

// ── Explorer ───────────────────────────────────────────────────────────

/** Explorer link for a tx (testnet or mainnet based on the node config). */
export function explorerUrl(hash: string): string {
  const host = loadConfig().nodeUrl.includes('testnet')
    ? 'testnet.kleverscan.org'
    : 'kleverscan.org';
  return `https://${host}/transaction/${hash}`;
}