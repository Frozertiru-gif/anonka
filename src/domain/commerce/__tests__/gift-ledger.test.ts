import { describe, it, expect } from "vitest";
import { GiftLedger, type GiftDecision } from "../gift-ledger";
import type { GiftEvent } from "../gift-event";

function makeGiftEvent(overrides: Partial<GiftEvent> = {}): GiftEvent {
  return {
    eventKey: "gift_received:111:10",
    kind: "gift_received",
    chatId: "111",
    msgId: 10,
    receivedAt: new Date(1700000000 * 1000),
    fromAnonymous: false,
    nameHidden: false,
    senderId: "123",
    giftId: "42",
    giftTitle: "Delicious Cake",
    stars: "50",
    refunded: false,
    ...overrides,
  };
}

describe("GiftLedger — auto attribution", () => {
  it("gift from the known conversation user → auto confirmed", () => {
    const ledger = new GiftLedger(() => "123");
    const decision = ledger.processGift(makeGiftEvent());

    expect(decision).toEqual({
      status: "CONFIRMED",
      profit: { stars: "50" },
      source: "conversation",
    });
    expect(ledger.credits().get("gift_received:111:10")).toEqual({ stars: "50" });
  });

  it("gift from expected user → auto confirmed + expectation fulfilled", () => {
    const ledger = new GiftLedger();
    ledger.expectGift("111", "123");

    const decision = ledger.processGift(makeGiftEvent());

    expect(decision).toEqual({
      status: "CONFIRMED",
      profit: { stars: "50" },
      source: "expectation",
    });
    // Expectation cleared after fulfillment.
    const next = ledger.processGift(makeGiftEvent({ eventKey: "gift_received:111:11", msgId: 11 }));
    expect((next as GiftDecision).status).toBe("MANUAL_REVIEW");
  });

  it("gift from a different user → MANUAL_REVIEW", () => {
    const ledger = new GiftLedger(() => "999");
    const decision = ledger.processGift(makeGiftEvent({ senderId: "123" }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    if (decision.status === "MANUAL_REVIEW") {
      expect(decision.review.reason).toBe("no_conversation_match");
      expect(decision.review.actualSenderId).toBe("123");
    }
    expect(ledger.credits().size).toBe(0);
  });

  it("gift with no sender → MANUAL_REVIEW (anonymous)", () => {
    const ledger = new GiftLedger(() => "123");
    const decision = ledger.processGift(
      makeGiftEvent({ senderId: undefined, fromAnonymous: true })
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    if (decision.status === "MANUAL_REVIEW") {
      expect(decision.review.reason).toBe("anonymous_sender");
    }
    expect(ledger.credits().size).toBe(0);
  });

  it("expected X but got Y → MANUAL_REVIEW with expected/actual context", () => {
    const ledger = new GiftLedger();
    ledger.expectGift("111", "999");

    const decision = ledger.processGift(makeGiftEvent({ senderId: "123" }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    if (decision.status === "MANUAL_REVIEW") {
      expect(decision.review.reason).toBe("sender_mismatch");
      expect(decision.review.expectedSenderId).toBe("999");
      expect(decision.review.actualSenderId).toBe("123");
    }
  });

  it("gift without a usable numeric value → MANUAL_REVIEW", () => {
    const ledger = new GiftLedger(() => "123");
    const decision = ledger.processGift(makeGiftEvent({ stars: undefined }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    if (decision.status === "MANUAL_REVIEW") {
      expect(decision.review.reason).toBe("no_value");
    }
    expect(ledger.credits().size).toBe(0);
  });
});

describe("GiftLedger — manual review lifecycle", () => {
  it("CONFIRM a manual review → profit credited", () => {
    const ledger = new GiftLedger();
    const decision = ledger.processGift(makeGiftEvent({ senderId: "123" }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    const eventKey = "gift_received:111:10";

    const result = ledger.applyReview({ type: "CONFIRM", eventKey });
    expect(result).toEqual({ status: "CONFIRMED", eventKey, profit: { stars: "50" } });
    expect(ledger.credits().get(eventKey)).toEqual({ stars: "50" });
  });

  it("REJECT a manual review → profit NOT credited", () => {
    const ledger = new GiftLedger();
    ledger.processGift(makeGiftEvent({ senderId: "123" }));

    const result = ledger.applyReview({ type: "REJECT", eventKey: "gift_received:111:10" });
    expect(result).toEqual({ status: "REJECTED", eventKey: "gift_received:111:10" });
    expect(ledger.credits().size).toBe(0);
  });

  it("applyReview on unknown eventKey → NOT_FOUND", () => {
    const ledger = new GiftLedger();
    expect(ledger.applyReview({ type: "CONFIRM", eventKey: "nope" })).toEqual({
      status: "NOT_FOUND",
      eventKey: "nope",
    });
  });

  it("review carries enough context for the Control Bot", () => {
    const ledger = new GiftLedger();
    ledger.expectGift("111", "999");
    ledger.processGift(
      makeGiftEvent({
        senderId: "123",
        senderUsername: "bob",
        giftId: "42",
        giftTitle: "Delicious Cake",
      })
    );

    const reviews = ledger.listReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      chatId: "111",
      msgId: 10,
      giftId: "42",
      giftTitle: "Delicious Cake",
      stars: "50",
      actualSenderId: "123",
      actualSenderUsername: "bob",
      expectedSenderId: "999",
      reason: "sender_mismatch",
    });
  });
});

describe("GiftLedger — idempotency", () => {
  it("duplicate gift (same eventKey) → profit credited only once", () => {
    const ledger = new GiftLedger(() => "123");

    const first = ledger.processGift(makeGiftEvent());
    const second = ledger.processGift(makeGiftEvent());

    expect(first.status).toBe("CONFIRMED");
    expect(second).toEqual({ status: "IGNORED", reason: "duplicate" });
    expect(ledger.credits().size).toBe(1);
  });

  it("offer events are ignored (not profit)", () => {
    const ledger = new GiftLedger(() => "123");
    const decision = ledger.processGift(
      makeGiftEvent({ kind: "gift_offer_received", eventKey: "gift_offer_received:111:1" })
    );
    expect(decision).toEqual({ status: "IGNORED", reason: "kind:gift_offer_received" });
    expect(ledger.credits().size).toBe(0);
  });

  it("refunded gift → ignored (not a live economic event)", () => {
    const ledger = new GiftLedger(() => "123");
    const decision = ledger.processGift(makeGiftEvent({ refunded: true }));
    expect(decision).toEqual({ status: "IGNORED", reason: "refunded" });
    expect(ledger.credits().size).toBe(0);
  });
});
