import { describe, it, expect, vi } from "vitest";
import { GiftLedger, type GiftDecision } from "../gift-ledger";
import { createConversationSenderResolver } from "../../../telegram/gift-resolver";
import { routeGiftMessage } from "../../../telegram/gift-routing";
import type { GiftEvent } from "../gift-event";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

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

describe("Gift runtime integration", () => {
  it("service message with giftEvent reaches the ledger (handled=true)", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const decisions: GiftDecision[] = [];

    // A DM gift: chatId "111" is the conversation user, sender 111 → auto confirm.
    const event = makeGiftEvent({ chatId: "111", senderId: "111" });
    const result = routeGiftMessage({ giftEvent: event }, ledger, (d) => decisions.push(d));

    expect(result.handled).toBe(true);
    expect(result.decision?.status).toBe("CONFIRMED");
    expect(ledger.credits().get(event.eventKey)).toEqual({ stars: "50" });
  });

  it("non-gift message → handled=false (passes through to normal pipeline)", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const result = routeGiftMessage({}, ledger, () => {});
    expect(result.handled).toBe(false);
  });

  it("auto confirmed gift → CONFIRMED decision, credit recorded, decision forwarded", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const decisions: GiftDecision[] = [];

    const event = makeGiftEvent({ chatId: "111", senderId: "111" });
    const result = routeGiftMessage({ giftEvent: event }, ledger, (d) => decisions.push(d));

    expect(result.handled).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("CONFIRMED");
    expect(ledger.credits().size).toBe(1);
  });

  it("manual review gift → MANUAL_REVIEW decision, NOT credited, still handled (not routed to LLM)", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const decisions: GiftDecision[] = [];

    // Sender 999 does not match the DM conversation user (chat 111) and there
    // is no expectation → MANUAL_REVIEW.
    const event = makeGiftEvent({ chatId: "111", senderId: "999" });
    const result = routeGiftMessage({ giftEvent: event }, ledger, (d) => decisions.push(d));

    expect(result.handled).toBe(true);
    expect(decisions[0].status).toBe("MANUAL_REVIEW");
    expect(ledger.credits().size).toBe(0);
    expect(ledger.listReviews()).toHaveLength(1);
  });

  it("anonymous gift → MANUAL_REVIEW, no credit", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const event = makeGiftEvent({ chatId: "111", senderId: undefined, fromAnonymous: true });
    const result = routeGiftMessage({ giftEvent: event }, ledger, () => {});

    expect(result.handled).toBe(true);
    expect(result.decision?.status).toBe("MANUAL_REVIEW");
    expect(ledger.credits().size).toBe(0);
  });

  it("CONFIRM on sender mismatch review clears the expectation", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    ledger.expectGift("111", "999");

    const event = makeGiftEvent({ chatId: "111", senderId: "123" });
    const result = routeGiftMessage({ giftEvent: event }, ledger, () => {});
    expect(result.decision?.status).toBe("MANUAL_REVIEW");

    const review = ledger.applyReview({ type: "CONFIRM", eventKey: event.eventKey });
    expect(review.status).toBe("CONFIRMED");
    expect(ledger.credits().size).toBe(1);

    // Expectation cleared: a follow-up gift in the same chat now resolves via
    // conversation match instead of the old expectation.
    const next = makeGiftEvent({
      chatId: "111",
      senderId: "111",
      eventKey: "gift_received:111:11",
      msgId: 11,
    });
    const nextDecision = routeGiftMessage({ giftEvent: next }, ledger, () => {});
    expect(nextDecision.decision?.status).toBe("CONFIRMED");
  });

  it("REJECT on sender mismatch review keeps the expectation", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    ledger.expectGift("111", "999");

    const event = makeGiftEvent({ chatId: "111", senderId: "123" });
    routeGiftMessage({ giftEvent: event }, ledger, () => {});

    const result = ledger.applyReview({ type: "REJECT", eventKey: event.eventKey });
    expect(result.status).toBe("REJECTED");
    expect(ledger.credits().size).toBe(0);

    // Expectation preserved: a gift from the expected user still auto-confirms.
    const expected = makeGiftEvent({
      chatId: "111",
      senderId: "999",
      eventKey: "gift_received:111:12",
      msgId: 12,
    });
    const decision = routeGiftMessage({ giftEvent: expected }, ledger, () => {});
    expect(decision.decision?.status).toBe("CONFIRMED");
    expect(
      decision.decision?.source === "expectation"
        ? (decision.decision as { source: string }).source
        : undefined
    ).toBe("expectation");
  });

  it("duplicate gift event → not credited twice", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    const event = makeGiftEvent({ chatId: "111", senderId: "111" });

    routeGiftMessage({ giftEvent: event }, ledger, () => {});
    const second = routeGiftMessage({ giftEvent: event }, ledger, () => {});

    expect(second.decision?.status).toBe("IGNORED");
    expect(ledger.credits().size).toBe(1);
  });

  it("group chat (negative chatId) has no single conversation user → MANUAL_REVIEW", () => {
    const ledger = new GiftLedger(createConversationSenderResolver());
    // Group chat: negative id. Sender is a user but there is no single
    // conversation user to match against.
    const event = makeGiftEvent({ chatId: "-100123", senderId: "123" });
    const result = routeGiftMessage({ giftEvent: event }, ledger, () => {});

    expect(result.decision?.status).toBe("MANUAL_REVIEW");
    expect(ledger.credits().size).toBe(0);
  });
});
