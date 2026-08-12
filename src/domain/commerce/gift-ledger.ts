import type { GiftEvent } from "./gift-event.js";

/**
 * Gift profit attribution.
 *
 * The incoming Gift service event is the SINGLE source of truth for profit.
 * No Stars transaction history is consulted to confirm the sender or the
 * value. If the sender matches a known conversation user or a pending
 * expectation, profit is credited immediately. Anything ambiguous is routed
 * to MANUAL_REVIEW instead of being guessed.
 */

/** Exact integer Star value as a decimal string. */
export interface GiftProfit {
  stars: string;
}

export type GiftReviewReason =
  | "anonymous_sender"
  | "sender_mismatch"
  | "no_conversation_match"
  | "no_value";

export interface GiftReview {
  eventKey: string;
  chatId: string;
  msgId: number;
  giftId?: string;
  giftTitle?: string;
  /** Star value if present on the event (may be absent for collectibles). */
  stars?: string;
  receivedAt: Date;
  /** Who actually sent the gift, if Telegram provided a sender. */
  actualSenderId?: string;
  actualSenderUsername?: string;
  /** Who we expected, if a pending expectation existed. */
  expectedSenderId?: string;
  reason: GiftReviewReason;
}

export type GiftDecision =
  | { status: "CONFIRMED"; profit: GiftProfit; source: "expectation" | "conversation" }
  | { status: "MANUAL_REVIEW"; review: GiftReview }
  | { status: "IGNORED"; reason: string };

/** Typed action for the future Control Bot. */
export type GiftReviewAction =
  | { type: "CONFIRM"; eventKey: string }
  | { type: "REJECT"; eventKey: string };

export type GiftReviewResult =
  | { status: "CONFIRMED"; eventKey: string; profit: GiftProfit | null }
  | { status: "REJECTED"; eventKey: string }
  | { status: "NOT_FOUND"; eventKey: string };

/** Resolve the known conversation sender for a chat, if any. */
export type GiftSenderResolver = (chatId: string) => string | undefined;

interface GiftExpectation {
  expectedSenderId: string;
}

/** Non-negative integer star value, or undefined if unusable. */
function parseProfitStars(stars: string | undefined): string | undefined {
  if (stars === undefined) return undefined;
  if (!/^\d+$/.test(stars)) return undefined;
  return stars;
}

const PROFIT_KINDS = new Set(["gift_received", "gift_unique"]);

export class GiftLedger {
  private readonly resolveSender?: GiftSenderResolver;
  private readonly expectations = new Map<string, GiftExpectation>();
  private readonly reviews = new Map<string, GiftReview>();
  private readonly processed = new Set<string>();
  private readonly credited = new Map<string, GiftProfit>();

  constructor(resolveSender?: GiftSenderResolver) {
    this.resolveSender = resolveSender;
  }

  /** Record that we now expect a gift from a specific user in this chat. */
  expectGift(chatId: string, expectedSenderId: string): void {
    this.expectations.set(chatId, { expectedSenderId });
  }

  clearExpectation(chatId: string): void {
    this.expectations.delete(chatId);
  }

  processGift(event: GiftEvent): GiftDecision {
    // Only incoming gift kinds represent profit. Offer events are ignored here.
    if (!PROFIT_KINDS.has(event.kind)) {
      return { status: "IGNORED", reason: `kind:${event.kind}` };
    }

    // Idempotency: one eventKey is processed at most once.
    if (this.processed.has(event.eventKey)) {
      return { status: "IGNORED", reason: "duplicate" };
    }
    this.processed.add(event.eventKey);

    // A refunded gift is not a live economic event.
    if (event.refunded) {
      return { status: "IGNORED", reason: "refunded" };
    }

    const profitStars = parseProfitStars(event.stars);

    if (profitStars === undefined) {
      const review = this.buildReview(event, "no_value", undefined);
      this.reviews.set(event.eventKey, review);
      return { status: "MANUAL_REVIEW", review };
    }

    if (event.senderId === undefined) {
      const review = this.buildReview(event, "anonymous_sender", undefined);
      this.reviews.set(event.eventKey, review);
      return { status: "MANUAL_REVIEW", review };
    }

    const profit: GiftProfit = { stars: profitStars };
    const expectation = this.expectations.get(event.chatId);

    if (expectation) {
      if (event.senderId === expectation.expectedSenderId) {
        this.credited.set(event.eventKey, profit);
        this.expectations.delete(event.chatId);
        return { status: "CONFIRMED", profit, source: "expectation" };
      }
      const review = this.buildReview(event, "sender_mismatch", expectation.expectedSenderId);
      this.reviews.set(event.eventKey, review);
      return { status: "MANUAL_REVIEW", review };
    }

    const knownSender = this.resolveSender?.(event.chatId);
    if (knownSender !== undefined && event.senderId === knownSender) {
      this.credited.set(event.eventKey, profit);
      return { status: "CONFIRMED", profit, source: "conversation" };
    }

    const review = this.buildReview(event, "no_conversation_match", undefined);
    this.reviews.set(event.eventKey, review);
    return { status: "MANUAL_REVIEW", review };
  }

  /** Apply a Control Bot decision to a pending manual review. */
  applyReview(action: GiftReviewAction): GiftReviewResult {
    const review = this.reviews.get(action.eventKey);
    if (!review) {
      return { status: "NOT_FOUND", eventKey: action.eventKey };
    }
    this.reviews.delete(action.eventKey);

    if (action.type === "REJECT") {
      // REJECT does NOT clear the expectation — the owner still awaits a
      // gift from the expected user.
      return { status: "REJECTED", eventKey: action.eventKey };
    }

    // CONFIRM: manual confirmation fulfills any pending expectation for this
    // chat (the owner has decided this review IS the expected gift).
    this.expectations.delete(review.chatId);

    // Credit profit exactly once.
    const alreadyCredited = this.credited.get(action.eventKey);
    if (alreadyCredited) {
      return { status: "CONFIRMED", eventKey: action.eventKey, profit: alreadyCredited };
    }

    const profitStars = parseProfitStars(review.stars);
    const profit = profitStars !== undefined ? { stars: profitStars } : null;
    if (profit !== null) {
      this.credited.set(action.eventKey, profit);
    }
    return { status: "CONFIRMED", eventKey: action.eventKey, profit };
  }

  /** Pending manual reviews, for the Control Bot. */
  listReviews(): GiftReview[] {
    return [...this.reviews.values()];
  }

  /** Snapshot of credited profits (eventKey → profit), for observability/audit. */
  credits(): ReadonlyMap<string, GiftProfit> {
    return new Map(this.credited);
  }

  private buildReview(
    event: GiftEvent,
    reason: GiftReviewReason,
    expectedSenderId: string | undefined
  ): GiftReview {
    const expectation = expectedSenderId ?? this.expectations.get(event.chatId)?.expectedSenderId;
    return {
      eventKey: event.eventKey,
      chatId: event.chatId,
      msgId: event.msgId,
      giftId: event.giftId,
      giftTitle: event.giftTitle,
      stars: event.stars,
      receivedAt: event.receivedAt,
      actualSenderId: event.senderId,
      actualSenderUsername: event.senderUsername,
      expectedSenderId: expectation,
      reason,
    };
  }
}
