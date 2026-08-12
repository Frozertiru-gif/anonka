import { describe, it, expect } from "vitest";
import { Api } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import {
  formatGiftEventText,
  giftEventKey,
  giftSenderPeer,
  parseGiftServiceAction,
  peerToStableIdentity,
} from "../gift-parser";
import type { GiftEvent } from "../../domain/commerce/gift-event";

const CTX = { chatId: "111", msgId: 10, receivedAt: new Date(1700000000 * 1000) };

function regularGift(overrides: Partial<Record<string, unknown>> = {}): Api.StarGift {
  return new Api.StarGift({
    id: toLong(42n),
    stars: toLong(50n),
    convertStars: toLong(45n),
    title: "Delicious Cake",
    sticker: new Api.Document({ id: toLong(1n) }),
    ...overrides,
  });
}

function uniqueGift(): Api.StarGiftUnique {
  return new Api.StarGiftUnique({
    id: toLong(1n),
    giftId: toLong(99n),
    title: "Bored Ape",
    slug: "bored-ape",
    num: 7,
    attributes: [],
    availabilityIssued: 10,
    availabilityTotal: 100,
  });
}

function starGiftAction(
  overrides: Partial<Record<string, unknown>> = {}
): Api.MessageActionStarGift {
  return new Api.MessageActionStarGift({
    gift: regularGift(),
    fromId: new Api.PeerUser({ userId: toLong(123n) }),
    ...overrides,
  });
}

describe("peerToStableIdentity", () => {
  it("extracts user/chat/channel ids", () => {
    expect(peerToStableIdentity(new Api.PeerUser({ userId: toLong(123n) }))).toEqual({
      peerType: "user",
      id: "123",
    });
    expect(peerToStableIdentity(new Api.PeerChat({ chatId: toLong(456n) }))).toEqual({
      peerType: "chat",
      id: "456",
    });
    expect(peerToStableIdentity(new Api.PeerChannel({ channelId: toLong(789n) }))).toEqual({
      peerType: "channel",
      id: "789",
    });
    expect(peerToStableIdentity(undefined)).toBeUndefined();
  });
});

describe("giftEventKey — chat-scoped dedup", () => {
  it("I: same msgId in different chats yields different keys", () => {
    expect(giftEventKey("gift_received", "chatA", 10)).not.toBe(
      giftEventKey("gift_received", "chatB", 10)
    );
  });

  it("different kinds yield different keys", () => {
    expect(giftEventKey("gift_received", "chatA", 10)).not.toBe(
      giftEventKey("gift_offer_received", "chatA", 10)
    );
  });

  it("deterministic", () => {
    expect(giftEventKey("gift_received", "chatA", 10)).toBe("gift_received:chatA:10");
  });
});

describe("parseGiftServiceAction — MessageActionStarGift", () => {
  it("A: known sender, nameHidden=false, refunded=false", () => {
    const e = parseGiftServiceAction(starGiftAction(), CTX) as GiftEvent;
    expect(e.fromAnonymous).toBe(false);
    expect(e.nameHidden).toBe(false);
    expect(e.senderId).toBe("123");
    expect(e.refunded).toBe(false);
  });

  it("B: nameHidden=true with known sender does NOT drop sender identity", () => {
    const e = parseGiftServiceAction(starGiftAction({ nameHidden: true }), CTX) as GiftEvent;
    expect(e.fromAnonymous).toBe(false);
    expect(e.nameHidden).toBe(true);
    expect(e.senderId).toBe("123");
  });

  it("C: anonymous gift (no fromId) → fromAnonymous=true, no senderId", () => {
    const e = parseGiftServiceAction(starGiftAction({ fromId: undefined }), CTX) as GiftEvent;
    expect(e.fromAnonymous).toBe(true);
    expect(e.senderId).toBeUndefined();
    expect(e.senderPeerType).toBeUndefined();
  });

  it("D: anonymous + nameHidden → both flags independent", () => {
    const e = parseGiftServiceAction(
      starGiftAction({ fromId: undefined, nameHidden: true }),
      CTX
    ) as GiftEvent;
    expect(e.fromAnonymous).toBe(true);
    expect(e.nameHidden).toBe(true);
    expect(e.senderId).toBeUndefined();
  });

  it("E: refunded=true is preserved", () => {
    const e = parseGiftServiceAction(starGiftAction({ refunded: true }), CTX) as GiftEvent;
    expect(e.refunded).toBe(true);
  });

  it("F: converted flag preserved", () => {
    const e = parseGiftServiceAction(starGiftAction({ converted: true }), CTX) as GiftEvent;
    expect(e.converted).toBe(true);
  });

  it("G: upgraded / canUpgrade preserved", () => {
    const e = parseGiftServiceAction(
      starGiftAction({ upgraded: true, canUpgrade: true, upgradeStars: toLong(100n) }),
      CTX
    ) as GiftEvent;
    expect(e.upgraded).toBe(true);
    expect(e.canUpgrade).toBe(true);
    expect(e.upgradeStars).toBe("100");
  });

  it("H: stable gift identity preserved", () => {
    const e = parseGiftServiceAction(starGiftAction(), CTX) as GiftEvent;
    expect(e.giftId).toBe("42");
    expect(e.giftTitle).toBe("Delicious Cake");
    expect(e.stars).toBe("50");
    expect(e.convertStars).toBe("45");
  });

  it("preserves giftMessage and message text", () => {
    const e = parseGiftServiceAction(
      starGiftAction({ message: new Api.TextWithEntities({ text: "hi!", entities: [] }) }),
      CTX
    ) as GiftEvent;
    expect(e.giftMessage).toBe("hi!");
  });
});

describe("parseGiftServiceAction — MessageActionStarGiftUnique", () => {
  it("N: collectible action normalizes with slug/num/stable identity", () => {
    const action = new Api.MessageActionStarGiftUnique({
      gift: uniqueGift(),
      fromId: new Api.PeerUser({ userId: toLong(55n) }),
      refunded: false,
    });
    const e = parseGiftServiceAction(action, CTX) as GiftEvent;
    expect(e.kind).toBe("gift_unique");
    expect(e.giftId).toBe("99");
    expect(e.giftSlug).toBe("bored-ape");
    expect(e.giftNum).toBe(7);
    expect(e.senderId).toBe("55");
    expect(e.fromAnonymous).toBe(false);
    expect(e.refunded).toBe(false);
  });

  it("unique gift with transferred/fromOffer flags preserved", () => {
    const action = new Api.MessageActionStarGiftUnique({
      gift: uniqueGift(),
      fromId: undefined,
      transferred: true,
      fromOffer: true,
    });
    const e = parseGiftServiceAction(action, CTX) as GiftEvent;
    expect(e.fromAnonymous).toBe(true);
    expect(e.transferred).toBe(true);
    expect(e.fromOffer).toBe(true);
  });
});

describe("parseGiftServiceAction — purchase offers", () => {
  it("J: pending offer preserves price/expires/gift id", () => {
    const action = new Api.MessageActionStarGiftPurchaseOffer({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expiresAt: 1700000100,
    });
    const e = parseGiftServiceAction(action, {
      ...CTX,
      msgSenderPeer: new Api.PeerUser({ userId: toLong(77n) }),
    }) as GiftEvent;
    expect(e.kind).toBe("gift_offer_received");
    expect(e.offerPriceStars).toBe("500");
    expect(e.offerAccepted).toBe(false);
    expect(e.offerDeclined).toBe(false);
    expect(e.offerExpiresAt?.getTime()).toBe(1700000100 * 1000);
    expect(e.giftId).toBe("99");
    expect(e.senderId).toBe("77");
    expect(e.fromAnonymous).toBe(false);
  });

  it("K: accepted offer state", () => {
    const action = new Api.MessageActionStarGiftPurchaseOffer({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expiresAt: 1700000100,
      accepted: true,
    });
    const e = parseGiftServiceAction(action, {
      ...CTX,
      msgSenderPeer: new Api.PeerUser({ userId: toLong(77n) }),
    }) as GiftEvent;
    expect(e.offerAccepted).toBe(true);
  });

  it("L: explicit declined offer", () => {
    const action = new Api.MessageActionStarGiftPurchaseOffer({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expiresAt: 1700000100,
      declined: true,
    });
    const e = parseGiftServiceAction(action, {
      ...CTX,
      msgSenderPeer: new Api.PeerUser({ userId: toLong(77n) }),
    }) as GiftEvent;
    expect(e.offerDeclined).toBe(true);
  });

  it("M: declined action with expired=true → offerExpired, not offerDeclined", () => {
    const action = new Api.MessageActionStarGiftPurchaseOfferDeclined({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expired: true,
    });
    const e = parseGiftServiceAction(action, {
      ...CTX,
      msgSenderPeer: new Api.PeerUser({ userId: toLong(77n) }),
    }) as GiftEvent;
    expect(e.kind).toBe("gift_offer_declined");
    expect(e.offerExpired).toBe(true);
    expect(e.offerDeclined).toBe(false);
  });

  it("declined action with expired=false → offerDeclined", () => {
    const action = new Api.MessageActionStarGiftPurchaseOfferDeclined({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expired: false,
    });
    const e = parseGiftServiceAction(action, {
      ...CTX,
      msgSenderPeer: new Api.PeerUser({ userId: toLong(77n) }),
    }) as GiftEvent;
    expect(e.offerExpired).toBe(false);
    expect(e.offerDeclined).toBe(true);
  });
});

describe("giftSenderPeer", () => {
  it("regular gift → action.fromId", () => {
    const action = starGiftAction({ fromId: new Api.PeerUser({ userId: toLong(9n) }) });
    expect(giftSenderPeer(action, new Api.PeerUser({ userId: toLong(1n) }))).toBe(action.fromId);
  });

  it("offer → message sender (no action fromId)", () => {
    const action = new Api.MessageActionStarGiftPurchaseOffer({
      gift: uniqueGift(),
      price: new Api.StarsAmount({ amount: toLong(500n), nanos: 0 }),
      expiresAt: 1,
    });
    const msgSender = new Api.PeerUser({ userId: toLong(1n) });
    expect(giftSenderPeer(action, msgSender)).toBe(msgSender);
  });

  it("unknown action → undefined", () => {
    expect(giftSenderPeer(new Api.MessageActionHistoryClear({}), undefined)).toBeUndefined();
  });
});

describe("formatGiftEventText", () => {
  it("anonymous gift text does not fabricate a sender", () => {
    const e = parseGiftServiceAction(starGiftAction({ fromId: undefined }), CTX) as GiftEvent;
    const text = formatGiftEventText(e);
    expect(text).toContain("From: Anonymous");
    expect(text).not.toContain("@");
    expect(text).not.toContain("user:123");
  });

  it("known sender text includes username", () => {
    const e = parseGiftServiceAction(starGiftAction(), CTX) as GiftEvent;
    e.senderUsername = "alice";
    expect(formatGiftEventText(e)).toContain("From: @alice");
  });
});
