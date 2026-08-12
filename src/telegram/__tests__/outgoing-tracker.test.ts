import { describe, it, expect } from "vitest";
import { OutgoingTracker } from "../outgoing-tracker";

function newTracker(): OutgoingTracker {
  const tracker = new OutgoingTracker();
  return tracker;
}

describe("OutgoingTracker — exact correlation classification", () => {
  it("A: exact match — reserve R → ack R→100 → observe A/100 → programmatic", () => {
    const tracker = newTracker();
    const chatId = "111";

    tracker.reserve(chatId, 10n);
    tracker.markSending(10n);
    expect(tracker.acknowledge(10n, 100, chatId)).toBe(true);

    const origin = tracker.observe(chatId, 100);
    expect(origin).toBe("programmatic");
  });

  it("B: manual outgoing in the same chat does NOT consume the reserved correlation", () => {
    const tracker = newTracker();
    const chatId = "111";

    tracker.reserve(chatId, 10n);
    tracker.markSending(10n);

    // A manual message (id 99) arrives first — no exact binding exists.
    expect(tracker.observe(chatId, 99)).toBe("creator_manual");

    // The reserved correlation must still be intact for the real message.
    expect(tracker.peek(chatId, 99)).toBeUndefined();
    expect(tracker.acknowledge(10n, 100, chatId)).toBe(true);
    expect(tracker.observe(chatId, 100)).toBe("programmatic");
  });

  it("C: two concurrent programmatic sends in the same chat both resolve correctly", () => {
    const tracker = newTracker();
    const chatId = "111";

    tracker.reserve(chatId, 10n);
    tracker.reserve(chatId, 20n);
    tracker.markSending(10n);
    tracker.markSending(20n);

    // Acknowledgements arrive in reverse order.
    expect(tracker.acknowledge(20n, 101, chatId)).toBe(true);
    expect(tracker.acknowledge(10n, 100, chatId)).toBe(true);

    expect(tracker.observe(chatId, 100)).toBe("programmatic");
    expect(tracker.observe(chatId, 101)).toBe("programmatic");
  });

  it("D: sends in different chats never cross-match", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.reserve("222", 20n);
    tracker.markSending(10n);
    tracker.markSending(20n);

    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);
    expect(tracker.acknowledge(20n, 200, "222")).toBe(true);

    // Same message id in the wrong chat is manual.
    expect(tracker.observe("111", 200)).toBe("creator_manual");
    expect(tracker.observe("222", 100)).toBe("creator_manual");
    // Correct chats are programmatic.
    expect(tracker.observe("111", 100)).toBe("programmatic");
    expect(tracker.observe("222", 200)).toBe("programmatic");
  });

  it("E: ack arrives before the outgoing message event → programmatic", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });

  it("F: message event arrives before ack — bounded wait resolves programmatic", async () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);

    const classification = tracker.classifyOutgoing("111", 100, { waitMs: 500, pollMs: 10 });

    // The acknowledgement lands shortly after the event.
    setTimeout(() => {
      tracker.acknowledge(10n, 100, "111");
    }, 30);

    await expect(classification).resolves.toBe("programmatic");
  });

  it("F2: message event before ack and ack never arrives → creator_manual", async () => {
    const tracker = newTracker();

    // No reservation at all — a purely manual send.
    const classification = tracker.classifyOutgoing("111", 100, { waitMs: 60, pollMs: 10 });

    await expect(classification).resolves.toBe("creator_manual");
  });

  it("G: definite send failure removes the pending correlation", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    tracker.markDefiniteFailure(10n, new Error("PEER_ID_INVALID"));

    expect(tracker.getByRandomId(10n)).toBeUndefined();
    expect(tracker.acknowledge(10n, 100, "111")).toBe(false);
  });

  it("H: ambiguous failure keeps the SAME randomId for retry", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    tracker.markAmbiguousFailure(10n, new Error("ECONNRESET"));

    const record = tracker.getByRandomId(10n);
    expect(record).toBeDefined();
    expect(record?.state).toBe("AMBIGUOUS");
    expect(record?.randomId).toBe(10n);

    // The retry reuses the same randomId and finally binds.
    tracker.markSending(10n);
    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });

  it("I: duplicate acknowledgement is idempotent", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);
    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);

    expect(tracker.pendingCount).toBe(1);
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });

  it("J: duplicate outgoing update stays programmatic (OBSERVED retention)", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    tracker.acknowledge(10n, 100, "111");

    expect(tracker.observe("111", 100)).toBe("programmatic");
    // Replayed update (GramJS redelivery) must not flip to creator_manual.
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });

  it("K: chatId mismatch on ack does NOT destroy the correlation", () => {
    const tracker = newTracker();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);

    // Ack claims the wrong chat — suspicious state, record must survive.
    expect(tracker.acknowledge(10n, 100, "999")).toBe(false);
    expect(tracker.getByRandomId(10n)).toBeDefined();

    // The correct ack still binds.
    expect(tracker.acknowledge(10n, 100, "111")).toBe(true);
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });

  it("cleanupStale expires RESERVED records but keeps bound ones", () => {
    const tracker = newTracker();
    const now = Date.now();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);

    // Simulate 61s of age by faking timestamps.
    const record = tracker.getByRandomId(10n);
    if (record) {
      record.stateUpdatedAt = now - 70_000;
    }

    expect(tracker.cleanupStale(now)).toBe(1);
    expect(tracker.getByRandomId(10n)).toBeUndefined();
  });

  it("cleanupStale retains OBSERVED records within retention window", () => {
    const tracker = newTracker();
    const now = Date.now();

    tracker.reserve("111", 10n);
    tracker.markSending(10n);
    tracker.acknowledge(10n, 100, "111");
    tracker.observe("111", 100);

    expect(tracker.cleanupStale(now)).toBe(0);
    expect(tracker.observe("111", 100)).toBe("programmatic");
  });
});
