/**
 * Structured GiftEvent extracted from Telegram service messages.
 * Used by Anonka commerce layer, not LLM agent tools.
 *
 * Sender semantics:
 * - `fromAnonymous` = Telegram did NOT provide a sender peer for the Gift
 *   (the authoritative sender primitive is absent). Identity is unknown.
 * - `nameHidden` = the sender asked Telegram to hide their name when the
 *   recipient displays the Gift in their profile. It is a DISPLAY/PRIVACY
 *   flag and says NOTHING about whether the sender is known to us.
 *
 * The two are independent: a known sender may set nameHidden=true (we still
 * know their id), and an anonymous Gift may or may not carry nameHidden.
 */
import type { NormalizedStarsAmount } from "./stars-amount.js";
export type GiftEventKind =
  | "gift_received"
  | "gift_unique"
  | "gift_offer_received"
  | "gift_offer_declined";

export type GiftPeerType = "user" | "chat" | "channel";

export interface GiftEvent {
  /** Deterministic dedup key, chat-scoped (see gift-parser.ts). */
  eventKey: string;
  kind: GiftEventKind;
  /** Chat where the service message arrived. */
  chatId: string;
  /** Raw Telegram service message id. */
  msgId: number;
  receivedAt: Date;

  // ── Sender identity (authoritative) ─────────────────────────────────────
  /** Telegram provided no sender peer for the Gift. */
  fromAnonymous: boolean;
  /** Sender requested name-hiding for public profile display. */
  nameHidden: boolean;
  /** Stable decimal sender identity. Absent when fromAnonymous. */
  senderId?: string;
  senderPeerType?: GiftPeerType;
  /** Display-only, resolved best-effort for known senders. */
  senderUsername?: string;
  senderFirstName?: string;

  // ── Receiver (correlation primitive) ────────────────────────────────────
  receiverId?: string;
  receiverPeerType?: GiftPeerType;

  // ── Gift identity ───────────────────────────────────────────────────────
  /** Stable Telegram gift identity (StarGift.id / StarGiftUnique.giftId). */
  giftId?: string;
  /** Display title. Never used as a correlation key. */
  giftTitle?: string;
  /** Collectible slug (StarGiftUnique only). */
  giftSlug?: string;
  /** Collectible number (StarGiftUnique only). */
  giftNum?: number;
  /** Star value, when the gift carries one (regular gifts / offers). */
  stars?: string;
  convertStars?: string;
  /** Optional message attached by the sender. */
  giftMessage?: string;

  // ── Lifecycle flags (economically relevant) ─────────────────────────────
  /** Refund was issued for this Gift — not a live economic event by itself. */
  refunded: boolean;
  converted?: boolean;
  upgraded?: boolean;
  canUpgrade?: boolean;
  saved?: boolean;
  prepaidUpgrade?: boolean;
  upgradeSeparate?: boolean;
  /** StarGiftUnique transferred flag. */
  transferred?: boolean;
  /** StarGiftUnique from-offer flag. */
  fromOffer?: boolean;
  upgradeMsgId?: number;
  upgradeStars?: string;
  savedId?: string;
  giftMsgId?: number;

  // ── Purchase offer fields ───────────────────────────────────────────────
  /** Exact offer price (Stars or TON), normalized without loss. */
  offerPrice?: NormalizedStarsAmount;
  offerAccepted?: boolean;
  offerDeclined?: boolean;
  offerExpired?: boolean;
  offerExpiresAt?: Date;
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
