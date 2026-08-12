import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { peerToStableIdentity, normalizeStarGiftIdentity } from "./gift-parser.js";
import { normalizeStarsAmount, type NormalizedStarsAmount } from "./stars-amount.js";

/**
 * Telegram Stars transaction ingestion / normalization / pagination.
 *
 * This is the ingestion layer ONLY. It reads the full transaction history,
 * normalizes every monetary/correlation primitive without loss, and provides
 * reliable multi-page pagination. It performs NO Gift ↔ Stars matching —
 * that is block 2.3.
 */

// ── Monetary representation ───────────────────────────────────────────────

export {
  type StarsAsset,
  type NormalizedStarsAmount,
  formatStarsDecimal,
} from "../domain/commerce/stars-amount.js";
export { normalizeStarsAmount } from "./stars-amount.js";

// ── Peer representation ────────────────────────────────────────────────────

export type StarsPeerKind =
  | "peer"
  | "app_store"
  | "play_market"
  | "premium_bot"
  | "fragment"
  | "ads"
  | "api"
  | "unsupported";

export interface NormalizedStarsPeer {
  kind: StarsPeerKind;
  peerType?: "user" | "chat" | "channel";
  /** Stable decimal peer id, when kind === "peer". */
  peerId?: string;
}

/** Normalize a StarsTransactionPeer tagged union. */
export function normalizeStarsPeer(peer: Api.TypeStarsTransactionPeer): NormalizedStarsPeer {
  if (peer instanceof Api.StarsTransactionPeer) {
    const identity = peerToStableIdentity(peer.peer);
    return {
      kind: "peer",
      peerType: identity?.peerType,
      peerId: identity?.id,
    };
  }
  if (peer instanceof Api.StarsTransactionPeerAppStore) return { kind: "app_store" };
  if (peer instanceof Api.StarsTransactionPeerPlayMarket) return { kind: "play_market" };
  if (peer instanceof Api.StarsTransactionPeerPremiumBot) return { kind: "premium_bot" };
  if (peer instanceof Api.StarsTransactionPeerFragment) return { kind: "fragment" };
  if (peer instanceof Api.StarsTransactionPeerAds) return { kind: "ads" };
  if (peer instanceof Api.StarsTransactionPeerAPI) return { kind: "api" };
  if (peer instanceof Api.StarsTransactionPeerUnsupported) return { kind: "unsupported" };
  // Unknown future constructor: classify as unsupported, do not drop the tx.
  return { kind: "unsupported" };
}

// ── Transaction model ─────────────────────────────────────────────────────

export type StarsDirection = "inbound" | "outbound" | "unknown";

/** Identity of a StarGift / StarGiftUnique attached to a transaction. */
export interface StarsGiftIdentity {
  giftId?: string;
  giftSlug?: string;
  giftNum?: number;
  giftTitle?: string;
  stars?: string;
  convertStars?: string;
}

export interface StarsTransaction {
  /** Canonical Telegram transaction id — always non-empty. */
  id: string;
  /** Exact monetary amount. */
  amount: NormalizedStarsAmount;
  /** Legacy alias: exact decimal string. */
  stars: string;
  date: number;
  peer: NormalizedStarsPeer;
  /** Direction requested by the query; never inferred from text/amount. */
  direction: StarsDirection;
  title?: string;
  description?: string;
  // Lifecycle flags
  pending: boolean;
  failed: boolean;
  refund: boolean;
  // Classification flags (gift/stargift/offer-related; see 2.3 for matching)
  gift: boolean;
  reaction: boolean;
  stargiftUpgrade: boolean;
  stargiftResale: boolean;
  stargiftPrepaidUpgrade: boolean;
  offer: boolean;
  businessTransfer: boolean;
  // Correlation primitives
  msgId?: number;
  stargift?: StarsGiftIdentity;
  transactionDate?: number;
  transactionUrl?: string;
}

/** Normalize a single raw StarsTransaction. Pure — no client access. */
export function normalizeStarsTransaction(
  tx: Api.StarsTransaction,
  direction: StarsDirection
): StarsTransaction {
  if (!tx.id) {
    throw new Error("StarsTransaction is missing its required id");
  }
  const amount = normalizeStarsAmount(tx.amount);
  return {
    id: tx.id,
    amount,
    stars: amount.decimal,
    date: tx.date,
    peer: normalizeStarsPeer(tx.peer),
    direction,
    title: tx.title,
    description: tx.description,
    pending: tx.pending ?? false,
    failed: tx.failed ?? false,
    refund: tx.refund ?? false,
    gift: tx.gift ?? false,
    reaction: tx.reaction ?? false,
    stargiftUpgrade: tx.stargiftUpgrade ?? false,
    stargiftResale: tx.stargiftResale ?? false,
    stargiftPrepaidUpgrade: tx.stargiftPrepaidUpgrade ?? false,
    offer: tx.offer ?? false,
    businessTransfer: tx.businessTransfer ?? false,
    msgId: tx.msgId,
    stargift: tx.stargift ? normalizeStarGiftIdentity(tx.stargift) : undefined,
    transactionDate: tx.transactionDate,
    transactionUrl: tx.transactionUrl,
  };
}

// ── Page primitive ────────────────────────────────────────────────────────

export interface StarsPageOptions {
  /** Pagination cursor. "" for the first page. */
  offset?: string;
  limit?: number;
  inbound?: boolean;
  outbound?: boolean;
}

export interface StarsPage {
  transactions: StarsTransaction[];
  /** Cursor for the next page; absent/empty when history ended. */
  nextOffset?: string;
  balance: NormalizedStarsAmount;
  /** Number of transactions in THIS page (not total history). */
  fetchedCount: number;
  hasMore: boolean;
}

export const STARS_DEFAULT_PAGE_SIZE = 50;
export const STARS_MAX_PAGE_SIZE = 100;

function validateInboundOutbound(
  inbound: boolean | undefined,
  outbound: boolean | undefined
): void {
  if (inbound === true && outbound === true) {
    throw new Error("inbound and outbound are mutually exclusive");
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > STARS_MAX_PAGE_SIZE) {
    throw new Error(`Invalid limit: ${limit} (must be an integer 1..${STARS_MAX_PAGE_SIZE})`);
  }
}

function directionFor(inbound: boolean | undefined, outbound: boolean | undefined): StarsDirection {
  if (inbound === true) return "inbound";
  if (outbound === true) return "outbound";
  return "unknown";
}

/**
 * Fetch ONE page of Stars transactions.
 *
 * `offset` is the Telegram cursor: "" for the first page, then the previous
 * page's `nextOffset`. The result always exposes `nextOffset` so the caller
 * can continue pagination.
 */
export async function getStarsTransactionsPage(
  gramJsClient: TelegramClient,
  opts: StarsPageOptions = {}
): Promise<StarsPage> {
  const { offset = "", limit = STARS_DEFAULT_PAGE_SIZE, inbound, outbound } = opts;
  validateInboundOutbound(inbound, outbound);
  validateLimit(limit);

  const result = await gramJsClient.invoke(
    new Api.payments.GetStarsTransactions({
      peer: new Api.InputPeerSelf(),
      inbound,
      outbound,
      offset,
      limit,
    })
  );

  const history: Api.TypeStarsTransaction[] = result.history ?? [];
  const direction = directionFor(inbound, outbound);
  const transactions = history.map((tx) => normalizeStarsTransaction(tx, direction));

  const nextOffset =
    result.nextOffset && result.nextOffset.length > 0 ? result.nextOffset : undefined;

  return {
    transactions,
    nextOffset,
    balance: normalizeStarsAmount(result.balance),
    fetchedCount: transactions.length,
    hasMore: nextOffset !== undefined,
  };
}

// ── Multi-page scan ───────────────────────────────────────────────────────

export interface StarsScanOptions {
  inbound?: boolean;
  outbound?: boolean;
  pageSize?: number;
  maxPages?: number;
  maxTransactions?: number;
}

export type StarsStopReason = "history_end" | "max_pages" | "max_transactions" | "repeated_offset";

export interface StarsScanResult {
  transactions: StarsTransaction[];
  complete: boolean;
  stopReason: StarsStopReason;
  pages: number;
}

export const STARS_DEFAULT_MAX_PAGES = 100;
export const STARS_DEFAULT_MAX_TRANSACTIONS = 5000;

/**
 * Scan multiple pages of Stars history in API order.
 *
 * Guards:
 * - maxPages / maxTransactions stop the scan and mark it incomplete;
 * - a repeated nextOffset stops the scan (prevents infinite loops).
 *
 * Duplicates across overlapping pages are deduped by canonical id, preserving
 * API order.
 */
export async function scanStarsTransactions(
  gramJsClient: TelegramClient,
  opts: StarsScanOptions = {}
): Promise<StarsScanResult> {
  const {
    inbound,
    outbound,
    pageSize = STARS_DEFAULT_PAGE_SIZE,
    maxPages = STARS_DEFAULT_MAX_PAGES,
    maxTransactions = STARS_DEFAULT_MAX_TRANSACTIONS,
  } = opts;
  validateInboundOutbound(inbound, outbound);

  const transactions: StarsTransaction[] = [];
  const seenIds = new Set<string>();
  const seenOffsets = new Set<string>();

  let offset = "";
  let pages = 0;

  while (true) {
    pages += 1;
    if (pages > maxPages) {
      return { transactions, complete: false, stopReason: "max_pages", pages: pages - 1 };
    }

    const page = await getStarsTransactionsPage(gramJsClient, {
      offset,
      limit: pageSize,
      inbound,
      outbound,
    });

    // Truncated = we stopped adding because maxTransactions was reached while
    // there was still at least one more unseen transaction on THIS page.
    let truncated = false;
    for (const tx of page.transactions) {
      if (seenIds.has(tx.id)) continue;
      if (transactions.length >= maxTransactions) {
        truncated = true;
        break;
      }
      seenIds.add(tx.id);
      transactions.push(tx);
    }

    if (page.nextOffset === undefined) {
      if (truncated) {
        return { transactions, complete: false, stopReason: "max_transactions", pages };
      }
      return { transactions, complete: true, stopReason: "history_end", pages };
    }

    if (truncated) {
      return { transactions, complete: false, stopReason: "max_transactions", pages };
    }

    if (seenOffsets.has(page.nextOffset)) {
      return { transactions, complete: false, stopReason: "repeated_offset", pages };
    }
    seenOffsets.add(page.nextOffset);
    offset = page.nextOffset;
  }
}

// ── Offline-gap poll ──────────────────────────────────────────────────────

export interface StarsPollOptions {
  pageSize?: number;
  maxPages?: number;
  maxTransactions?: number;
}

export type StarsPollStopReason = "cursor_found" | StarsStopReason;

export interface StarsPollResult {
  transactions: StarsTransaction[];
  /** Whether `sinceId` was located in history. */
  cursorFound: boolean;
  /** True only when the scan reached the beginning of history. */
  complete: boolean;
  stopReason: StarsPollStopReason;
  pages: number;
}

/**
 * Poll for transactions newer than `sinceId`.
 *
 * Walks pages until `sinceId` is found (or history ends). Transactions newer
 * than `sinceId` are returned; `sinceId` itself is NOT included. If `sinceId`
 * is never found and the scan hits a safety limit, `complete=false` so the
 * caller never mistakes a truncated scan for full reconciliation.
 *
 * `sinceId = null` scans from the newest page subject to the same guards
 * (documented truncation via `complete`).
 */
export async function pollNewTransactions(
  gramJsClient: TelegramClient,
  sinceId: string | null,
  opts: StarsPollOptions = {}
): Promise<StarsPollResult> {
  const {
    pageSize = STARS_DEFAULT_PAGE_SIZE,
    maxPages = STARS_DEFAULT_MAX_PAGES,
    maxTransactions = STARS_DEFAULT_MAX_TRANSACTIONS,
  } = opts;

  const transactions: StarsTransaction[] = [];
  const seenIds = new Set<string>();
  const seenOffsets = new Set<string>();

  let offset = "";
  let pages = 0;

  while (true) {
    pages += 1;
    if (pages > maxPages) {
      return {
        transactions,
        cursorFound: false,
        complete: false,
        stopReason: "max_pages",
        pages: pages - 1,
      };
    }

    const page = await getStarsTransactionsPage(gramJsClient, {
      offset,
      limit: pageSize,
      inbound: true,
    });

    // Truncated = we stopped adding because maxTransactions was reached while
    // there was still at least one more unseen transaction on THIS page.
    let truncated = false;
    for (const tx of page.transactions) {
      if (sinceId !== null && tx.id === sinceId) {
        return {
          transactions,
          cursorFound: true,
          complete: true,
          stopReason: "cursor_found",
          pages,
        };
      }
      if (seenIds.has(tx.id)) continue;
      if (transactions.length >= maxTransactions) {
        truncated = true;
        break;
      }
      seenIds.add(tx.id);
      transactions.push(tx);
    }

    if (page.nextOffset === undefined) {
      if (truncated) {
        return {
          transactions,
          cursorFound: false,
          complete: false,
          stopReason: "max_transactions",
          pages,
        };
      }
      return { transactions, cursorFound: false, complete: true, stopReason: "history_end", pages };
    }

    if (truncated) {
      return {
        transactions,
        cursorFound: false,
        complete: false,
        stopReason: "max_transactions",
        pages,
      };
    }

    if (seenOffsets.has(page.nextOffset)) {
      return {
        transactions,
        cursorFound: false,
        complete: false,
        stopReason: "repeated_offset",
        pages,
      };
    }
    seenOffsets.add(page.nextOffset);
    offset = page.nextOffset;
  }
}

// ── Identity helpers ──────────────────────────────────────────────────────

/**
 * Stable idempotency key. Telegram transaction ids are unique within the
 * self ledger (the only scope getStarsTransactions reads), so `id` alone is
 * sufficient — the "self" scope is made explicit in the key.
 */
export function transactionKey(tx: StarsTransaction): string {
  return `stars:self:${tx.id}`;
}
