import { Api } from "telegram";
import type { TelegramClient } from "telegram";

export interface StarsTransaction {
  id: string;
  stars: string;
  date: number;
  type: string;
  description: string | null;
  pending: boolean;
  failed: boolean;
  refund: boolean;
}

export interface StarsTransactionsResult {
  transactions: StarsTransaction[];
  count: number;
  balance: string | undefined;
}

/**
 * Fetch Stars transactions for the current user.
 * Extracted from agent tools for use as a standalone infrastructure service.
 */
export async function getStarsTransactions(
  gramJsClient: TelegramClient,
  opts?: {
    limit?: number;
    inbound?: boolean;
    outbound?: boolean;
  }
): Promise<StarsTransactionsResult> {
  const { limit = 20, inbound, outbound } = opts ?? {};

  const result = await gramJsClient.invoke(
    new Api.payments.GetStarsTransactions({
      peer: new Api.InputPeerSelf(),
      inbound,
      outbound,
      offset: "",
      limit,
    })
  );

  const history: Api.TypeStarsTransaction[] = result.history ?? [];

  const transactions: StarsTransaction[] = history.map((tx) => ({
    id: String(tx.id ?? ""),
    stars: String(tx.amount?.amount ?? "0"),
    date: Number(tx.date ?? 0),
    type: String(tx.peer?.className ?? "unknown"),
    description: typeof tx.description === "string" ? tx.description : null,
    pending: Boolean(tx.pending),
    failed: Boolean(tx.failed),
    refund: Boolean(tx.refund),
  }));

  const balanceBig = result.balance?.amount;
  const balanceStr = balanceBig != null ? String(balanceBig) : undefined;

  return {
    transactions,
    count: transactions.length,
    balance: balanceStr,
  };
}

/**
 * Poll for new transactions since the last known transaction ID.
 * Used for offline-gap reconciliation per ARCHITECTURE.md Section 24.5.
 *
 * @returns Transactions newer than `sinceId`, or all if sinceId is null.
 */
export async function pollNewTransactions(
  gramJsClient: TelegramClient,
  sinceId: string | null,
  opts?: { limit?: number }
): Promise<StarsTransactionsResult> {
  const { limit = 50 } = opts ?? {};
  const all = await getStarsTransactions(gramJsClient, { limit, inbound: true });

  if (!sinceId) return all;

  const sinceIdx = all.transactions.findIndex((tx) => tx.id === sinceId);
  if (sinceIdx === -1) return all;

  return {
    ...all,
    transactions: all.transactions.slice(0, sinceIdx),
    count: sinceIdx,
  };
}

/**
 * Generate a stable idempotency key from a transaction for deduplication.
 */
export function transactionKey(tx: StarsTransaction): string {
  return `stars:${tx.id}`;
}

/**
 * Check if a transaction is relevant for gift payment matching.
 * Filters out refunds and failed transactions.
 */
export function isRelevantGiftTransaction(tx: StarsTransaction): boolean {
  return !tx.failed && !tx.refund && tx.stars !== "0";
}
