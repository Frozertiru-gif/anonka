import { Api } from "telegram";
import type { GiftEvent, GiftEventKind, GiftPeerType } from "../domain/commerce/gift-event.js";
import { normalizeStarsAmount } from "./stars-amount.js";

/**
 * Pure, deterministic Gift service-message parser.
 *
 * The parser has no side effects and does not touch the Telegram client, so
 * it can be unit-tested with synthetic typed Api objects. It is the single
 * source of truth for GiftEvent ingestion; the bridge only supplies the raw
 * service action and message context.
 */

export interface GiftParseContext {
  chatId: string;
  msgId: number;
  receivedAt: Date;
  /** Message-level sender peer (msg.fromId), used only where the action has no own fromId. */
  msgSenderPeer?: Api.TypePeer;
  /** Message-level receiver peer (msg.peerId). */
  msgPeer?: Api.TypePeer;
}

/** Deterministic, chat-scoped event key. One message → one key; other chat → other key. */
export function giftEventKey(kind: GiftEventKind, chatId: string, msgId: number): string {
  return `${kind}:${chatId}:${msgId}`;
}

/**
 * The sender peer used for display identity resolution. For regular/unique
 * gifts this is the action's own `fromId` (authoritative Gift sender). For
 * purchase offers the action has no `fromId`, so the message-level sender is
 * used. Returns undefined for anonymous gifts.
 */
export function giftSenderPeer(
  action: Api.TypeMessageAction,
  msgSenderPeer: Api.TypePeer | undefined
): Api.TypePeer | undefined {
  if (action instanceof Api.MessageActionStarGift) return action.fromId;
  if (action instanceof Api.MessageActionStarGiftUnique) return action.fromId;
  if (action instanceof Api.MessageActionStarGiftPurchaseOffer) return msgSenderPeer;
  if (action instanceof Api.MessageActionStarGiftPurchaseOfferDeclined) return msgSenderPeer;
  return undefined;
}

/** Extract a stable decimal identity from a Telegram peer. */
export function peerToStableIdentity(
  peer: Api.TypePeer | undefined
): { peerType: GiftPeerType; id: string } | undefined {
  if (peer instanceof Api.PeerUser) return { peerType: "user", id: peer.userId.toString() };
  if (peer instanceof Api.PeerChat) return { peerType: "chat", id: peer.chatId.toString() };
  if (peer instanceof Api.PeerChannel)
    return { peerType: "channel", id: peer.channelId.toString() };
  return undefined;
}

/**
 * Authoritative Gift sender resolution.
 *
 * fromAnonymous is determined ONLY by the presence of the Telegram sender
 * peer primitive (fromId). nameHidden is an independent display flag.
 */
function resolveGiftSender(fromId: Api.TypePeer | undefined): {
  senderId?: string;
  senderPeerType?: GiftPeerType;
  fromAnonymous: boolean;
} {
  const identity = peerToStableIdentity(fromId);
  if (!identity) {
    return { fromAnonymous: true };
  }
  return {
    senderId: identity.id,
    senderPeerType: identity.peerType,
    fromAnonymous: false,
  };
}

/** Split a StarGift / StarGiftUnique into stable identity + display title + value. */
export function normalizeStarGiftIdentity(gift: Api.TypeStarGift): {
  giftId?: string;
  giftTitle?: string;
  giftSlug?: string;
  giftNum?: number;
  stars?: string;
  convertStars?: string;
} {
  if (gift instanceof Api.StarGift) {
    return {
      giftId: gift.id.toString(),
      giftTitle: gift.title,
      stars: gift.stars.toString(),
      convertStars: gift.convertStars?.toString(),
    };
  }
  if (gift instanceof Api.StarGiftUnique) {
    return {
      giftId: gift.giftId.toString(),
      giftTitle: gift.title,
      giftSlug: gift.slug,
      giftNum: gift.num,
    };
  }
  return {};
}

export function parseGiftServiceAction(
  action: Api.TypeMessageAction,
  ctx: GiftParseContext
): GiftEvent | null {
  if (action instanceof Api.MessageActionStarGift) {
    const { giftId, giftTitle, giftSlug, giftNum, stars, convertStars } = normalizeStarGiftIdentity(
      action.gift
    );
    const sender = resolveGiftSender(action.fromId);
    const receiver = peerToStableIdentity(action.peer ?? ctx.msgPeer);

    return {
      eventKey: giftEventKey("gift_received", ctx.chatId, ctx.msgId),
      kind: "gift_received",
      chatId: ctx.chatId,
      msgId: ctx.msgId,
      receivedAt: ctx.receivedAt,
      fromAnonymous: sender.fromAnonymous,
      nameHidden: action.nameHidden ?? false,
      senderId: sender.senderId,
      senderPeerType: sender.senderPeerType,
      receiverId: receiver?.id,
      receiverPeerType: receiver?.peerType,
      giftId,
      giftTitle,
      giftSlug,
      giftNum,
      stars,
      convertStars: action.convertStars?.toString() ?? convertStars,
      giftMessage: action.message?.text,
      refunded: action.refunded ?? false,
      converted: action.converted,
      upgraded: action.upgraded,
      canUpgrade: action.canUpgrade,
      saved: action.saved,
      prepaidUpgrade: action.prepaidUpgrade,
      upgradeSeparate: action.upgradeSeparate,
      upgradeMsgId: action.upgradeMsgId,
      upgradeStars: action.upgradeStars?.toString(),
      savedId: action.savedId?.toString(),
      giftMsgId: action.giftMsgId,
    };
  }

  if (action instanceof Api.MessageActionStarGiftUnique) {
    const { giftId, giftTitle, giftSlug, giftNum } = normalizeStarGiftIdentity(action.gift);
    const sender = resolveGiftSender(action.fromId);
    const receiver = peerToStableIdentity(action.peer ?? ctx.msgPeer);

    return {
      eventKey: giftEventKey("gift_unique", ctx.chatId, ctx.msgId),
      kind: "gift_unique",
      chatId: ctx.chatId,
      msgId: ctx.msgId,
      receivedAt: ctx.receivedAt,
      fromAnonymous: sender.fromAnonymous,
      nameHidden: false,
      senderId: sender.senderId,
      senderPeerType: sender.senderPeerType,
      receiverId: receiver?.id,
      receiverPeerType: receiver?.peerType,
      giftId,
      giftTitle,
      giftSlug,
      giftNum,
      refunded: action.refunded ?? false,
      saved: action.saved,
      transferred: action.transferred,
      fromOffer: action.fromOffer,
      prepaidUpgrade: action.prepaidUpgrade,
      savedId: action.savedId?.toString(),
    };
  }

  if (action instanceof Api.MessageActionStarGiftPurchaseOffer) {
    const { giftId, giftTitle, giftSlug, giftNum } = normalizeStarGiftIdentity(action.gift);
    // Offer actions carry no fromId; the offer sender is the message sender.
    const sender = resolveGiftSender(ctx.msgSenderPeer);

    return {
      eventKey: giftEventKey("gift_offer_received", ctx.chatId, ctx.msgId),
      kind: "gift_offer_received",
      chatId: ctx.chatId,
      msgId: ctx.msgId,
      receivedAt: ctx.receivedAt,
      fromAnonymous: sender.fromAnonymous,
      nameHidden: false,
      senderId: sender.senderId,
      senderPeerType: sender.senderPeerType,
      giftId,
      giftTitle,
      giftSlug,
      giftNum,
      offerPrice: normalizeStarsAmount(action.price),
      offerAccepted: action.accepted ?? false,
      offerDeclined: action.declined ?? false,
      offerExpiresAt: new Date(action.expiresAt * 1000),
      refunded: false,
    };
  }

  if (action instanceof Api.MessageActionStarGiftPurchaseOfferDeclined) {
    const { giftId, giftTitle, giftSlug, giftNum } = normalizeStarGiftIdentity(action.gift);
    const sender = resolveGiftSender(ctx.msgSenderPeer);
    const expired = action.expired ?? false;

    return {
      eventKey: giftEventKey("gift_offer_declined", ctx.chatId, ctx.msgId),
      kind: "gift_offer_declined",
      chatId: ctx.chatId,
      msgId: ctx.msgId,
      receivedAt: ctx.receivedAt,
      fromAnonymous: sender.fromAnonymous,
      nameHidden: false,
      senderId: sender.senderId,
      senderPeerType: sender.senderPeerType,
      giftId,
      giftTitle,
      giftSlug,
      giftNum,
      offerPrice: normalizeStarsAmount(action.price),
      // Expired and explicit-declined are mutually exclusive outcomes.
      offerExpired: expired,
      offerDeclined: !expired,
      refunded: false,
    };
  }

  return null;
}

/** Human-readable label for a gift sender, honoring anonymity. */
function senderLabel(e: GiftEvent): string {
  if (e.fromAnonymous) return "Anonymous";
  if (e.senderUsername) return `@${e.senderUsername}`;
  if (e.senderFirstName) return e.senderFirstName;
  if (e.senderId) return `user:${e.senderId}`;
  return "Unknown";
}

/** Human-readable label for an offer price amount, honoring its asset. */
function offerPriceLabel(e: GiftEvent): string {
  if (!e.offerPrice) return "?";
  const suffix = e.offerPrice.asset === "ton" ? "TON" : "Stars";
  return `${e.offerPrice.decimal} ${suffix}`;
}

/** Build a human-readable text from an already-normalized GiftEvent. */
export function formatGiftEventText(e: GiftEvent): string {
  switch (e.kind) {
    case "gift_received": {
      let text = `[Gift Received]\n`;
      text += `Gift: "${e.giftTitle ?? "Gift"}"${e.stars ? ` (${e.stars} Stars)` : ""}${
        e.upgraded ? " [Upgraded to Collectible]" : ""
      }\n`;
      text += `From: ${senderLabel(e)}\n`;
      if (e.giftMessage) text += `Message: "${e.giftMessage}"\n`;
      if (e.canUpgrade && e.upgradeStars) {
        text += `This gift can be upgraded to a collectible for ${e.upgradeStars} Stars.\n`;
      }
      if (e.convertStars) text += `Can be converted to ${e.convertStars} Stars.`;
      return text.trim();
    }
    case "gift_unique": {
      let text = `[Collectible Gift]\n`;
      text += `Gift: "${e.giftTitle ?? "Collectible"}"${e.giftNum ? ` #${e.giftNum}` : ""}${
        e.giftSlug ? ` (slug: ${e.giftSlug})` : ""
      }\n`;
      text += `From: ${senderLabel(e)}`;
      return text.trim();
    }
    case "gift_offer_received": {
      const status = e.offerAccepted ? "accepted" : e.offerDeclined ? "declined" : "pending";
      let text = `[Gift Offer Received]\n`;
      text += `Offer: ${offerPriceLabel(e)} for your NFT "${e.giftTitle ?? "Gift"}"${
        e.giftNum ? ` #${e.giftNum}` : ""
      }${e.giftSlug ? ` (slug: ${e.giftSlug})` : ""}\n`;
      text += `From: ${senderLabel(e)}\n`;
      text += `Expires: ${e.offerExpiresAt ? e.offerExpiresAt.toISOString() : "unknown"}\n`;
      text += `Status: ${status}\n`;
      text += `Message ID: ${e.msgId}`;
      return text.trim();
    }
    case "gift_offer_declined": {
      let text = `[Gift Offer ${e.offerExpired ? "Expired" : "Declined"}]\n`;
      text += `Your offer of ${offerPriceLabel(e)} for NFT "${e.giftTitle ?? "Gift"}"${
        e.giftNum ? ` #${e.giftNum}` : ""
      }${e.giftSlug ? ` (slug: ${e.giftSlug})` : ""} was ${
        e.offerExpired ? "expired" : "declined"
      }.`;
      return text.trim();
    }
  }
}
