import { createLogger } from "../utils/logger.js";
import type { GiftEvent } from "../domain/commerce/gift-event.js";

const log = createLogger("Gift");

/**
 * Privacy-safe Gift event logging.
 *
 * A really anonymous Gift (fromAnonymous=true) must never expose a resolved
 * sender identity in logs. Only display-neutral technical context is logged.
 */
export function logGiftEvent(e: GiftEvent): void {
  const sender = e.fromAnonymous ? "Anonymous" : (e.senderId ?? "unknown");
  switch (e.kind) {
    case "gift_received":
      log.info(
        {
          eventKey: e.eventKey,
          fromAnonymous: e.fromAnonymous,
          nameHidden: e.nameHidden,
          refunded: e.refunded,
          giftId: e.giftId,
        },
        `Gift received: "${e.giftTitle ?? "Gift"}" (${e.stars ?? "?"} Stars) from ${sender}`
      );
      break;
    case "gift_unique":
      log.info(
        { eventKey: e.eventKey, fromAnonymous: e.fromAnonymous, refunded: e.refunded },
        `Collectible gift: "${e.giftTitle ?? "Collectible"}" from ${sender}`
      );
      break;
    case "gift_offer_received":
      log.info(
        { eventKey: e.eventKey, giftId: e.giftId, offerPriceStars: e.offerPriceStars },
        `Gift offer received: ${e.offerPriceStars ?? "?"} Stars for "${e.giftTitle ?? "Gift"}" from ${sender}`
      );
      break;
    case "gift_offer_declined":
      log.info(
        { eventKey: e.eventKey, offerExpired: e.offerExpired },
        `Gift offer ${e.offerExpired ? "expired" : "declined"}: ${e.offerPriceStars ?? "?"} Stars for "${e.giftTitle ?? "Gift"}"`
      );
      break;
  }
}
