import type { GiftEvent } from "../domain/commerce/gift-event.js";
import type { GiftDecision } from "../domain/commerce/gift-ledger.js";
import type { GiftLedger } from "../domain/commerce/gift-ledger.js";

export interface GiftRoutingResult {
  /** True when the message was a GiftEvent and must NOT be routed to the LLM. */
  handled: boolean;
  decision?: GiftDecision;
}

/**
 * Route an incoming Telegram message through the GiftLedger.
 *
 * A message carrying a giftEvent is an authoritative profit event: it is
 * consumed by the ledger (CONFIRMED / MANUAL_REVIEW / IGNORED) and must never
 * reach the LLM as an ordinary user prompt. `handled === true` signals the
 * caller to stop the normal message pipeline.
 */
export function routeGiftMessage(
  message: { giftEvent?: GiftEvent },
  ledger: GiftLedger,
  onDecision: (decision: GiftDecision) => void
): GiftRoutingResult {
  const event = message.giftEvent;
  if (!event) {
    return { handled: false };
  }

  const decision = ledger.processGift(event);
  onDecision(decision);
  return { handled: true, decision };
}
