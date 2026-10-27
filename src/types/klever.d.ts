/**
 * klever.d.ts — ambient types for the Klever browser-extension wallet
 * (Phase 4.7).
 *
 * The Klever Extension injects `window.kleverWeb`:
 *   provider pin → initialize() → getWalletAddress()
 *   → buildTransaction() → signTransaction() → broadcastTransactions()
 *
 * Private keys never leave the extension — the dApp only passes opaque
 * transaction objects between methods and never inspects them.
 *
 * Surface verified against live, shipping integrations in this
 * environment: `dexscan/dexscan-api-portal/src/hooks/useKleverWallet.ts`
 * (React) and `Ogmara/web/src/lib/klever.ts` (including the smart-contract
 * `buildTransaction` path used by kDice's `commit`/`settle`).
 */

/** Network endpoints the extension must be pinned to BEFORE `initialize()`. */
interface KleverProviderUrls {
  /** REST API host, e.g. `https://api.testnet.klever.org`. */
  api: string;
  /** Node host, e.g. `https://node.testnet.klever.org`. */
  node: string;
}

/**
 * Opaque transaction object passed between extension methods. The dApp
 * must neither construct nor read it — build/sign/broadcast own it.
 */
interface KleverTx {
  [key: string]: unknown;
}

/** One `contracts` entry for `buildTransaction` (smart-contract invoke). */
interface KleverContractSpec {
  /** Klever tx type: 63 = SmartContract. */
  type: number;
  payload: {
    /** SC op: 0 = InvokeContract. */
    scType: number;
    /** Target contract, bech32 `klv1…`. */
    address: string;
    /** KLV to attach; `{}` = no value (the kDice contract is record-only). */
    callValue: object;
  };
}

/** Response shape of `broadcastTransactions`. */
interface KleverBroadcastResult {
  data?: { txsHashes?: string[] };
}

/** The injected wallet surface. */
interface KleverWeb {
  /** Network pin — MUST be set before `initialize()` (Ogmara race note). */
  provider?: KleverProviderUrls;
  /** Initialize the session (may raise an extension permission prompt). */
  initialize(): Promise<void>;
  /** Address of the wallet the extension currently exposes. */
  getWalletAddress(): Promise<string>;
  /** Build an unsigned tx. `txData` = base64-encoded call-data strings. */
  buildTransaction(contracts: KleverContractSpec[], txData?: string[]): Promise<KleverTx>;
  /** Sign with the extension key (user approves inside the extension). */
  signTransaction(tx: KleverTx): Promise<KleverTx>;
  /** Broadcast signed txs; resolves with the assigned tx hashes. */
  broadcastTransactions(txs: KleverTx[]): Promise<KleverBroadcastResult>;
  /** Optional on some builds — sign an arbitrary message. */
  signMessage?(message: string): Promise<string>;
}

interface Window {
  /** Injected by the Klever Extension; `undefined` when absent. */
  kleverWeb?: KleverWeb;
}
