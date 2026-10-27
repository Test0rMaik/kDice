/**
 * scClient.ts — typed read-only client for the kDice K5 smart contract
 * (Phase 4.5).
 *
 * No Klevr SDK (project principle): plain JSON over the node REST API,
 * the same wire path proven by `contracts/tools/lib.js` (operator
 * console). The frontend decodes `vm/query` responses itself.
 *
 * Wire format (verified against the live testnet node):
 *   POST {node}/vm/query  {"scAddress","funcName","args":[hex tokens]}
 *   → {"data":{"data":{"returnCode","returnMessage","returnData":[base64]}}}
 *
 * Decoding rules (klever-sc-codec, mirrored from tools/lib.js):
 *  - each `returnData` entry is a base64 top-level item;
 *  - scalars are "minimal" big-endian byte strings (u32 ≤4B, u64 ≤8B);
 *  - a struct is ONE item: a single buffer whose fields are NESTED-encoded
 *    (fixed-width numbers, 4-byte length-prefixed BigUint/bytes, 1-byte
 *    bool, 32-byte address).
 *
 * Hardening (AGENTS §5C — untrusted network input):
 *  - 10 s timeout via AbortController;
 *  - response size cap (256 KB) before JSON parsing;
 *  - single-flight queue + 300 ms minimum spacing (client-side throttle);
 *  - every decoded field is range-checked; unknown shapes throw a typed
 *    `SCError` instead of rendering as plausible zeros.
 */

import { bytesToHex } from '../engine/fair';

// ── Public types ───────────────────────────────────────────────────────

/** Which node + contract to talk to. Persisted in localStorage. */
export interface SCConfig {
  /** Node REST base, e.g. `https://node.testnet.klever.org`. */
  nodeUrl: string;
  /** Contract address (bech32 `klv1…`). */
  contract: string;
}

/**
 * Network tag for a node URL (Phase 5: stored on each RollEvent so
 * testnet/mainnet analytics never mix). Substring checks are safe:
 * "testnet" and "devnet" are disjoint substrings of the node hosts,
 * and anything else is treated as mainnet.
 */
export function networkTag(nodeUrl: string): 'devnet' | 'testnet' | 'mainnet' {
  if (nodeUrl.includes('devnet')) return 'devnet';
  if (nodeUrl.includes('testnet')) return 'testnet';
  return 'mainnet';
}

/** `CommitRecord` as stored by the contract (storage.rs). */
export interface CommitRecord {
  /** Player address, bech32 `klv1…`. */
  player: string;
  /**
   * Stored bet value (storage field name `multiplier`): v1 records hold a
   * multiplier {2,4,10,50}; v2 records (Phase 4.10) hold `100 + target·2 +
   * over` (102..299). Decode with `fair.ts::resolveBet` / `betLabel` —
   * the ranges are disjoint, so both generations read unambiguously.
   */
  multiplier: number;
  /** Stake in smallest KLV units (6 decimals) — string, lossless. */
  stake: string;
  /**
   * Entropy source for the roll. Protocol v3 (Phase 7): the confirming-block
   * random seed, 48 bytes (96 hex chars) — re-derive the roll with
   * `fair.ts::deriveRollFromBlockSeed(hex, gameId)` and compare to `getRoll`.
   * v1/v2 records held a 32-byte client commitment in this same field.
   */
  hash: string;
  /** Block timestamp (seconds since epoch). */
  createdAt: number;
  /** False once settled. */
  active: boolean;
}

/** `RollRecord` — the immutable settlement (storage.rs). */
export interface RollRecord {
  /** d100 face, 1..100. */
  roll: number;
  win: boolean;
  /** Stored bet value — same dual encoding as `CommitRecord.multiplier`. */
  multiplier: number;
  /** Stake in smallest KLV units (6 decimals) — string, lossless. */
  stake: string;
  /** Block timestamp (seconds since epoch). */
  settledAt: number;
}

/** Typed failure. `requireFailed` = a contract `require!` revert. */
export class SCError extends Error {
  readonly requireFailed: boolean;
  constructor(message: string, requireFailed = false) {
    super(message);
    this.name = 'SCError';
    this.requireFailed = requireFailed;
  }
}

// ── Defaults + config persistence ──────────────────────────────────────

/** kDice testnet deployment (contracts/DEPLOYMENTS.md, 2026-10-24). */
export const DEFAULT_SC_CONFIG: Readonly<SCConfig> = {
  nodeUrl: 'https://node.testnet.klever.org',
  contract: 'klv1qqqqqqqqqqqqqpgqxwtjrzvrd62e8l7fksrrzkqqa5xyufm0mvgqndrl9s',
};

const CONFIG_KEY = 'kdice.scConfig.v1';
const BECH32_RE = /^klv1[02-9ac-hj-np-z]{20,60}$/;

/** Load persisted config, falling back to defaults on any malformation. */
export function loadConfig(): SCConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SC_CONFIG };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SC_CONFIG };
    const c = parsed as { nodeUrl?: unknown; contract?: unknown };
    if (
      typeof c.nodeUrl === 'string' &&
      typeof c.contract === 'string' &&
      /^https?:\/\//.test(c.nodeUrl) &&
      BECH32_RE.test(c.contract)
    ) {
      return { nodeUrl: c.nodeUrl.replace(/\/+$/, ''), contract: c.contract };
    }
  } catch {
    /* corrupt localStorage — fall through to defaults */
  }
  return { ...DEFAULT_SC_CONFIG };
}

/** Persist config. Non-fatal: a full/blocked store just skips saving. */
export function saveConfig(config: SCConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable — config still applies for this page session */
  }
}

// ── Throttle + timeout (AGENTS §5C) ────────────────────────────────────

const TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 300;
const MAX_RESPONSE_BYTES = 256 * 1024;

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single-flight queue with minimum spacing between requests. A failure
 * resolves the queue link (never wedging later requests) while still
 * rejecting its caller.
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(async (): Promise<T> => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  queue = result.catch(() => {
    /* keep the chain alive across failures */
  });
  return result;
}

/** POST JSON with a hard timeout and a size-capped, typed error surface. */
async function postJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SCError(`vm/query timed out after ${TIMEOUT_MS} ms`);
    }
    throw new SCError('vm/query network error: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  // Read as text with a hard size cap BEFORE parsing — an unbounded
  // resp.json() on a hostile response is a resource-exhaustion vector.
  const text = await resp.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SCError(`vm/query response too large (${text.length} > ${MAX_RESPONSE_BYTES} bytes)`);
  }
  if (!resp.ok) {
    throw new SCError(`vm/query HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SCError('vm/query returned a non-JSON body');
  }
}

// ── vm/query core ──────────────────────────────────────────────────────

interface QueryInner {
  returnCode?: string;
  returnMessage?: string;
  returnData?: unknown;
}
interface Envelope {
  error?: unknown;
  data?: { data?: QueryInner };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a non-negative integer as an even-length hex token (node requirement). */
function numToHexToken(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new SCError(`arg: expected a non-negative integer, got ${n}`);
  let hex = BigInt(n).toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex; // node hex-decoder rejects odd length
  return hex;
}

/**
 * Run one view call, returning the raw top-level returnData items as
 * `Uint8Array`s. Args may be numbers (hex-encoded here), hex tokens, or
 * bech32 addresses (converted here — the node hex-decodes every arg).
 */
async function vmQueryBytes(config: SCConfig, funcName: string, args: (string | number)[]): Promise<Uint8Array[]> {
  const hexArgs = args.map((a) => {
    if (typeof a === 'number') return numToHexToken(a);
    if (a.startsWith('klv1')) return hexFromBech32(a);
    return a;
  });
  const json = await enqueue(() =>
    postJson(config.nodeUrl + '/vm/query', { scAddress: config.contract, funcName, args: hexArgs }),
  );
  if (typeof json !== 'object' || json === null) {
    throw new SCError('vm/query: unexpected response shape (not an object)');
  }
  const env = json as Envelope;
  if (env.error) {
    // `require!` reverts surface here as "VMUserError:…" (not via
    // returnCode on this node build) — flag them so callers can treat
    // "no such game" as a normal not-found, not a transport error.
    const msg = typeof env.error === 'string' ? env.error : JSON.stringify(env.error).slice(0, 200);
    throw new SCError('vm/query: ' + msg, msg.includes('VMUserError'));
  }
  const inner = env.data?.data;
  if (!inner) throw new SCError('vm/query: unexpected response shape (missing data.data)');
  if (inner.returnCode && inner.returnCode !== 'Ok') {
    throw new SCError(inner.returnMessage || inner.returnCode, true);
  }
  const rawList = inner.returnData;
  if (!Array.isArray(rawList) || rawList.some((x) => typeof x !== 'string')) {
    throw new SCError('vm/query: unexpected returnData shape');
  }
  return (rawList as string[]).map((b64) => base64ToBytes(b64));
}

// ── Scalar + struct decoding ───────────────────────────────────────────

function readUintBE(bytes: Uint8Array, offset: number, len: number): number {
  if (offset + len > bytes.length) throw new SCError('decode: buffer truncated');
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new SCError(`decode: value out of safe-integer range`);
  return n;
}

/** Top-level "minimal" big-endian scalar (u16/u32/u64/bool). */
function decodeTopScalar(type: 'u16' | 'u32' | 'u64' | 'bool', item: Uint8Array): number | boolean {
  if (type === 'bool') return item.length > 0 && item[0] !== 0;
  const max = type === 'u64' ? 8 : type === 'u32' ? 4 : 2;
  if (item.length > max) throw new SCError(`decode: ${type} item is ${item.length} bytes (max ${max})`);
  return readUintBE(item, 0, item.length);
}

function decodeNestedBytes(buf: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  const len = readUintBE(buf, offset, 4);
  if (len > 4096) throw new SCError(`decode: bytes field too large (${len})`);
  if (offset + 4 + len > buf.length) throw new SCError('decode: bytes field truncated');
  return { value: buf.slice(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

function decodeNestedBigUint(buf: Uint8Array, offset: number): { value: string; next: number } {
  const len = readUintBE(buf, offset, 4);
  if (len > 32) throw new SCError(`decode: BigUint magnitude too large (${len} bytes)`);
  if (offset + 4 + len > buf.length) throw new SCError('decode: BigUint truncated');
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(buf[offset + 4 + i]);
  return { value: v.toString(), next: offset + 4 + len };
}

/**
 * Decode one `getCommit` top-level item into a `CommitRecord`.
 * Layout (nested encoding, storage.rs field order):
 * player 32B | multiplier u32 4B | stake BigUint (4B len) |
 * hash bytes (4B len) | createdAt u64 8B | active bool 1B.
 */
export function decodeCommitRecord(item: Uint8Array): CommitRecord {
  if (item.length === 0) throw new SCError('decode: empty CommitRecord buffer');
  let off = 0;
  if (item.length < 32) throw new SCError('decode: CommitRecord shorter than a player address');
  const playerHex = bytesToHex(item.slice(off, off + 32));
  off += 32;
  const multiplier = readUintBE(item, off, 4);
  off += 4;
  const stake = decodeNestedBigUint(item, off);
  off = stake.next;
  const hash = decodeNestedBytes(item, off);
  off = hash.next;
  const createdAt = readUintBE(item, off, 8);
  off += 8;
  const active = off < item.length && item[off] !== 0;
  off += 1;
  if (off !== item.length) throw new SCError(`decode: CommitRecord has ${item.length - off} trailing byte(s)`);
  return {
    player: bech32Encode('klv', hexToBytesArr(playerHex)),
    multiplier,
    stake: stake.value,
    hash: bytesToHex(hash.value),
    createdAt,
    active,
  };
}

/**
 * Decode one `getRoll` top-level item into a `RollRecord`.
 * Layout (storage.rs field order):
 * roll u32 4B | win bool 1B | multiplier u32 4B |
 * stake BigUint (4B len) | settledAt u64 8B.
 */
export function decodeRollRecord(item: Uint8Array): RollRecord {
  if (item.length === 0) throw new SCError('decode: empty RollRecord buffer');
  let off = 0;
  const roll = readUintBE(item, off, 4);
  off += 4;
  const win = off < item.length && item[off] !== 0;
  off += 1;
  const multiplier = readUintBE(item, off, 4);
  off += 4;
  const stake = decodeNestedBigUint(item, off);
  off = stake.next;
  const settledAt = readUintBE(item, off, 8);
  off += 8;
  if (off !== item.length) throw new SCError(`decode: RollRecord has ${item.length - off} trailing byte(s)`);
  if (roll < 1 || roll > 100) throw new SCError(`decode: roll out of range (1..100): ${roll}`);
  return { roll, win, multiplier, stake: stake.value, settledAt };
}

function hexToBytesArr(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── bech32 (BIP-173 core: encode for display, decode for args) ────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= gen[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new SCError('bech32: invalid group value');
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    // BIP-173 trailing-bits rule: reject non-zero remnants when unpadding.
    throw new SCError('bech32: invalid trailing bits');
  }
  return out;
}

/** Encode raw address bytes as a `klv1…` bech32 string (for display). */
export function bech32Encode(hrp: string, data: Uint8Array): string {
  const payload = convertBits(Array.from(data), 8, 5, true);
  const checksum = createChecksum(hrp, payload);
  return hrp + '1' + [...payload, ...checksum].map((v) => BECH32_CHARSET[v]).join('');
}

/** Decode a `klv1…` address to lowercase hex of its raw bytes (for args). */
export function hexFromBech32(address: string): string {
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) throw new SCError('mixed-case bech32 address');
  const sep = lower.lastIndexOf('1');
  const hrp = lower.slice(0, sep);
  if (sep < 1 || hrp !== 'klv') throw new SCError('not a klv1… address: ' + address);
  const data5: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) throw new SCError('invalid bech32 character: ' + c);
    data5.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data5]) !== 1) throw new SCError('bech32 checksum mismatch: ' + address);
  const payload = convertBits(data5.slice(0, -6), 5, 8, false);
  if (payload.length !== 32) throw new SCError('address decoded to ' + payload.length + ' bytes (expected 32)');
  return bytesToHex(Uint8Array.from(payload));
}

// ── Typed public API ───────────────────────────────────────────────────

async function singleItem(config: SCConfig, funcName: string, args: (string | number)[]): Promise<Uint8Array> {
  const items = await vmQueryBytes(config, funcName, args);
  if (items.length === 0) throw new SCError(`vm/query ${funcName}: empty returnData`);
  return items[0];
}

/** `getCommit(gameId)` — `requireFailed` if no such commit exists. */
export async function getCommit(config: SCConfig, gameId: number): Promise<CommitRecord> {
  return decodeCommitRecord(await singleItem(config, 'getCommit', [gameId]));
}

/** `getRoll(gameId)` — `requireFailed` if the game is not settled yet. */
export async function getRoll(config: SCConfig, gameId: number): Promise<RollRecord> {
  return decodeRollRecord(await singleItem(config, 'getRoll', [gameId]));
}

/** `getTarget(multiplier)` — contract-side threshold (should match local). */
export async function getTarget(config: SCConfig, multiplier: number): Promise<number> {
  return decodeTopScalar('u32', await singleItem(config, 'getTarget', [multiplier])) as number;
}

/**
 * `getPayout(target, over)` — contract-side payout per 100 of stake
 * (×100 precision, 5% edge). Should equal `fair.ts::payoutFor` exactly.
 * The bool arg is the node-verified `00`/`01` hex token (testnet commit
 * path in `upgrade-v2-verify.mjs`).
 */
export async function getPayout(config: SCConfig, target: number, over: boolean): Promise<number> {
  return decodeTopScalar('u32', await singleItem(config, 'getPayout', [target, over ? '01' : '00'])) as number;
}

/** `getRollsCount()` — total settlements ever recorded. */
export async function getRollsCount(config: SCConfig): Promise<number> {
  return decodeTopScalar('u64', await singleItem(config, 'getRollsCount', [])) as number;
}

/** `getCommitsCount()` — total commits ever recorded. */
export async function getCommitsCount(config: SCConfig): Promise<number> {
  return decodeTopScalar('u64', await singleItem(config, 'getCommitsCount', [])) as number;
}

/** `getActiveCommits(player)` — unsettled commits for an address. */
export async function getActiveCommits(config: SCConfig, player: string): Promise<number> {
  return decodeTopScalar('u16', await singleItem(config, 'getActiveCommits', [player])) as number;
}

/** `getName()` — human-readable contract name (UTF-8). */
export async function getName(config: SCConfig): Promise<string> {
  return new TextDecoder().decode(await singleItem(config, 'getName', []));
}

/** `getProtocolVersion()` — schema-drift guard marker. */
export async function getProtocolVersion(config: SCConfig): Promise<number> {
  return decodeTopScalar('u32', await singleItem(config, 'getProtocolVersion', [])) as number;
}

/** `getMaxActiveCommits()` — per-player active-commit cap. */
export async function getMaxActiveCommits(config: SCConfig): Promise<number> {
  return decodeTopScalar('u16', await singleItem(config, 'getMaxActiveCommits', [])) as number;
}

// ── Display helpers ────────────────────────────────────────────────────

/** Stake (smallest KLV units, 6 decimals) → KLV float for display. */
export function klvFromStake(stake: string): number {
  const n = Number(stake);
  if (!Number.isFinite(n)) return 0;
  return n / 1_000_000;
}

/** Shorten a long bech32/hex address for compact rows. */
export function shortAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}