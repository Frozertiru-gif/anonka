/**
 * Structured GiftEvent extracted from Telegram service messages.
 * Used by Anonka commerce layer, not LLM agent tools.
 */

export interface GiftEvent {
  /** Stable event key for deduplication: msgId from the service message. */
  eventKey: string;
  /** Chat ID where the event occurred. */
  chatId: string;
  /** Numeric sender ID (0 if unknown/anonymous). */
  senderId: number;
  senderUsername?: string;
  senderFirstName?: string;
  /** True when sender chose to hide their name (action.nameHidden). */
  fromAnonymous: boolean;
  /** Type discriminator. */
  kind: "gift_received" | "gift_offer_received" | "gift_offer_declined";
  /** Timestamp from the message. */
  receivedAt: Date;
  /** Raw message ID for correlation. */
  msgId: number;

  // gift_received
  giftTitle?: string;
  /** Star value as string (may be "?" if unknown/collectible). */
  stars?: string;
  giftMessage?: string;
  upgraded?: boolean;
  canUpgrade?: boolean;
  upgradeStars?: string;
  convertStars?: string;

  // gift_offer_received / gift_offer_declined
  offerPriceStars?: string;
  offerAccepted?: boolean;
  offerDeclined?: boolean;
  offerExpired?: boolean;
  offerExpiresAt?: Date;
  offerSlug?: string;
  offerNum?: number;
}

/**
 * Gift matching states per ARCHITECTURE.md Section 24.4:
 * DETECTED → MATCHED → CONSUMED
 * DETECTED → UNMATCHED → (reconciliation) → MATCHED
 */
export type GiftStatus = "DETECTED" | "MATCHED" | "UNMATCHED" | "CONSUMED";

/**
 * Reasons a gift may remain UNMATCHED.
 */
export type UnmatchedReason =
  | "anonymous_sender"
  | "unknown_value"
  | "no_peer_mapping"
  | "no_transaction_key"
  | "ambiguous_correlation";
