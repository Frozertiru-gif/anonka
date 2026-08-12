import { describe, it, expect, vi } from "vitest";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import {
  formatStarsDecimal,
  getStarsTransactionsPage,
  normalizeStarsAmount,
  normalizeStarsPeer,
  normalizeStarsTransaction,
  pollNewTransactions,
  scanStarsTransactions,
  transactionKey,
} from "../stars";

// -- Fixtures ---------------------------------------------------------------

function makeStarsAmount(amount: bigint, nanos = 0): Api.StarsAmount {
  return new Api.StarsAmount({ amount: toLong(amount), nanos });
}

function makeStarsTonAmount(amount: bigint): Api.StarsTonAmount {
  return new Api.StarsTonAmount({ amount: toLong(amount) });
}

function makeTx(overrides: Partial<Record<string, unknown>> = {}): Api.StarsTransaction {
  return new Api.StarsTransaction({
    id: "abc123",
    amount: makeStarsAmount(5n, 0),
    date: 1700000000,
    peer: new Api.StarsTransactionPeer({ peer: new Api.PeerUser({ userId: toLong(777n) }) }),
    ...overrides,
  });
}

function makeStatus(opts: {
  history?: Api.TypeStarsTransaction[];
  nextOffset?: string;
  balance?: Api.TypeStarsAmount;
}): Api.payments.StarsStatus {
  return new Api.payments.StarsStatus({
    balance: opts.balance ?? makeStarsAmount(1000n, 0),
    history: opts.history ?? [],
    nextOffset: opts.nextOffset,
    chats: [],
    users: [],
  });
}

/** A minimal fake TelegramClient carrying only the typed invoke() we need. */
function makeClient(pages: Api.payments.StarsStatus[]): TelegramClient {
  const invoke = vi.fn<() => Promise<Api.payments.StarsStatus>>();
  for (const page of pages) {
    invoke.mockResolvedValueOnce(page);
  }
  return { invoke } as unknown as TelegramClient;
}

// -- Monetary normalization ------------------------------------------------

describe("formatStarsDecimal", () => {
  it("integer only", () => {
    expect(formatStarsDecimal("5", 0)).toBe("5");
  });

  it("1 Star + 500000000 nanos - 1.5", () => {
    expect(formatStarsDecimal("1", 500000000)).toBe("1.5");
  });

  it("1 Star + 250000000 nanos - 1.25", () => {
    expect(formatStarsDecimal("1", 250000000)).toBe("1.25");
  });

  it("0 Stars + 1 nanos - 0.000000001", () => {
    expect(formatStarsDecimal("0", 1)).toBe("0.000000001");
  });

  it("negative amount with negative nanos - -2.5", () => {
    expect(formatStarsDecimal("-2", -500000000)).toBe("-2.5");
  });

  it("negative amount with positive nanos (mixed sign) - -1.5", () => {
    expect(formatStarsDecimal("-2", 500000000)).toBe("-1.5");
  });

  it("large long amount without precision loss", () => {
    expect(formatStarsDecimal("9007199254740993", 0)).toBe("9007199254740993");
  });

  it("large negative long amount", () => {
    expect(formatStarsDecimal("-9007199254740993", 0)).toBe("-9007199254740993");
  });
});

describe("normalizeStarsAmount", () => {
  it("StarsAmount - asset stars with exact decimal", () => {
    const n = normalizeStarsAmount(makeStarsAmount(5n, 250000000));
    expect(n).toEqual({ asset: "stars", units: "5", nanos: 250000000, decimal: "5.25" });
  });

  it("negative StarsAmount", () => {
    const n = normalizeStarsAmount(makeStarsAmount(-2n, -500000000));
    expect(n.decimal).toBe("-2.5");
    expect(n.units).toBe("-2");
  });

  it("StarsTonAmount - asset ton", () => {
    const n = normalizeStarsAmount(makeStarsTonAmount(42n));
    expect(n).toEqual({ asset: "ton", units: "42", nanos: 0, decimal: "42" });
  });
});

// -- Peer normalization -----------------------------------------------------

describe("normalizeStarsPeer", () => {
  it("StarsTransactionPeer(PeerUser) - kind peer, peerType user, peerId", () => {
    const n = normalizeStarsPeer(
      new Api.StarsTransactionPeer({ peer: new Api.PeerUser({ userId: toLong(123n) }) })
    );
    expect(n).toEqual({ kind: "peer", peerType: "user", peerId: "123" });
  });

  it("StarsTransactionPeer(PeerChannel) - channel", () => {
    const n = normalizeStarsPeer(
      new Api.StarsTransactionPeer({ peer: new Api.PeerChannel({ channelId: toLong(456n) }) })
    );
    expect(n).toEqual({ kind: "peer", peerType: "channel", peerId: "456" });
  });

  it("AppStore - app_store", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerAppStore())).toEqual({
      kind: "app_store",
    });
  });

  it("PlayMarket - play_market", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerPlayMarket())).toEqual({
      kind: "play_market",
    });
  });

  it("PremiumBot - premium_bot", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerPremiumBot())).toEqual({
      kind: "premium_bot",
    });
  });

  it("Fragment - fragment", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerFragment())).toEqual({
      kind: "fragment",
    });
  });

  it("Ads - ads", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerAds())).toEqual({ kind: "ads" });
  });

  it("API - api", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerAPI())).toEqual({ kind: "api" });
  });

  it("Unsupported - unsupported", () => {
    expect(normalizeStarsPeer(new Api.StarsTransactionPeerUnsupported())).toEqual({
      kind: "unsupported",
    });
  });
});

// -- Transaction normalization ----------------------------------------------

describe("normalizeStarsTransaction", () => {
  it("preserves gift/stargift/offer/lifecycle flags and correlation primitives", () => {
    const tx = makeTx({
      gift: true,
      refund: true,
      pending: true,
      failed: false,
      stargiftUpgrade: true,
      stargiftResale: true,
      stargiftPrepaidUpgrade: true,
      offer: true,
      businessTransfer: true,
      msgId: 999,
      stargift: new Api.StarGiftUnique({
        id: toLong(1n),
        giftId: toLong(88n),
        title: "Bored Ape",
        slug: "bored-ape",
        num: 5,
        attributes: [],
        availabilityIssued: 1,
        availabilityTotal: 1,
      }),
      transactionDate: 1699999999,
      transactionUrl: "https://fragment.com/...",
      title: "My Gift",
      description: "desc",
    });

    const n = normalizeStarsTransaction(tx, "inbound");

    expect(n.id).toBe("abc123");
    expect(n.amount.decimal).toBe("5");
    expect(n.stars).toBe("5");
    expect(n.date).toBe(1700000000);
    expect(n.peer).toEqual({ kind: "peer", peerType: "user", peerId: "777" });
    expect(n.direction).toBe("inbound");
    expect(n.pending).toBe(true);
    expect(n.failed).toBe(false);
    expect(n.refund).toBe(true);
    expect(n.gift).toBe(true);
    expect(n.reaction).toBe(false);
    expect(n.stargiftUpgrade).toBe(true);
    expect(n.stargiftResale).toBe(true);
    expect(n.stargiftPrepaidUpgrade).toBe(true);
    expect(n.offer).toBe(true);
    expect(n.businessTransfer).toBe(true);
    expect(n.msgId).toBe(999);
    expect(n.stargift?.giftId).toBe("88");
    expect(n.stargift?.giftSlug).toBe("bored-ape");
    expect(n.stargift?.giftNum).toBe(5);
    expect(n.transactionDate).toBe(1699999999);
    expect(n.transactionUrl).toBe("https://fragment.com/...");
    expect(n.title).toBe("My Gift");
    expect(n.description).toBe("desc");
  });

  it("throws on missing transaction id", () => {
    const tx = new Api.StarsTransaction({
      amount: makeStarsAmount(5n),
      date: 1,
      peer: new Api.StarsTransactionPeerAPI(),
    });
    expect(() => normalizeStarsTransaction(tx, "unknown")).toThrow(/required id/);
  });

  it("flags default to false when absent", () => {
    const n = normalizeStarsTransaction(makeTx(), "unknown");
    expect(n.gift).toBe(false);
    expect(n.pending).toBe(false);
    expect(n.failed).toBe(false);
    expect(n.refund).toBe(false);
    expect(n.msgId).toBeUndefined();
    expect(n.stargift).toBeUndefined();
  });
});

// -- Page primitive ---------------------------------------------------------

describe("getStarsTransactionsPage", () => {
  it("single page: offset '' - no nextOffset - hasMore=false", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "t1" })], balance: makeStarsAmount(7n, 500000000) }),
    ]);

    const page = await getStarsTransactionsPage(client, {});
    expect(client.invoke).toHaveBeenCalledTimes(1);
    const req = client.invoke.mock.calls[0][0] as Api.payments.GetStarsTransactions;
    expect(req.offset).toBe("");
    expect(page.transactions).toHaveLength(1);
    expect(page.nextOffset).toBeUndefined();
    expect(page.hasMore).toBe(false);
    expect(page.balance.decimal).toBe("7.5");
    expect(page.fetchedCount).toBe(1);
  });

  it("passes nextOffset and continues", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "t1" })], nextOffset: "page2" }),
      makeStatus({ history: [makeTx({ id: "t2" })] }),
    ]);

    const p1 = await getStarsTransactionsPage(client, {});
    const p2 = await getStarsTransactionsPage(client, { offset: p1.nextOffset });

    expect(p1.nextOffset).toBe("page2");
    expect(p1.hasMore).toBe(true);
    const req2 = client.invoke.mock.calls[1][0] as Api.payments.GetStarsTransactions;
    expect(req2.offset).toBe("page2");
    expect(p2.transactions[0].id).toBe("t2");
    expect(p2.hasMore).toBe(false);
  });

  it("inbound/outbound mutually exclusive - throws before invoke", async () => {
    const client = makeClient([]);
    await expect(
      getStarsTransactionsPage(client, { inbound: true, outbound: true })
    ).rejects.toThrow(/mutually exclusive/);
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it("inbound=true - request inbound; outbound=true - request outbound", async () => {
    const inClient = makeClient([makeStatus({ history: [] })]);
    await getStarsTransactionsPage(inClient, { inbound: true });
    const inReq = inClient.invoke.mock.calls[0][0] as Api.payments.GetStarsTransactions;
    expect(inReq.inbound).toBe(true);
    expect(inReq.outbound).toBeUndefined();

    const outClient = makeClient([makeStatus({ history: [] })]);
    await getStarsTransactionsPage(outClient, { outbound: true });
    const outReq = outClient.invoke.mock.calls[0][0] as Api.payments.GetStarsTransactions;
    expect(outReq.outbound).toBe(true);
    expect(outReq.inbound).toBeUndefined();
  });

  it("invalid limit throws", async () => {
    const client = makeClient([]);
    await expect(getStarsTransactionsPage(client, { limit: 0 })).rejects.toThrow();
    await expect(getStarsTransactionsPage(client, { limit: -5 })).rejects.toThrow();
    await expect(getStarsTransactionsPage(client, { limit: Number.NaN })).rejects.toThrow();
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it("direction unknown when neither filter set", async () => {
    const client = makeClient([makeStatus({ history: [makeTx()] })]);
    const page = await getStarsTransactionsPage(client, {});
    expect(page.transactions[0].direction).toBe("unknown");
  });
});

// -- Multi-page scan --------------------------------------------------------

describe("scanStarsTransactions", () => {
  it("A: one page, no nextOffset - complete/history_end", async () => {
    const client = makeClient([makeStatus({ history: [makeTx({ id: "t1" })] })]);
    const r = await scanStarsTransactions(client, {});
    expect(r.transactions.map((t) => t.id)).toEqual(["t1"]);
    expect(r.complete).toBe(true);
    expect(r.stopReason).toBe("history_end");
    expect(r.pages).toBe(1);
  });

  it("B: three pages, all transactions, correct offsets", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "b" })], nextOffset: "p3" }),
      makeStatus({ history: [makeTx({ id: "c" })] }),
    ]);
    const r = await scanStarsTransactions(client, {});
    expect(r.transactions.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(r.complete).toBe(true);
    expect(r.stopReason).toBe("history_end");
    expect(r.pages).toBe(3);
    expect((client.invoke.mock.calls[1][0] as Api.payments.GetStarsTransactions).offset).toBe("p2");
    expect((client.invoke.mock.calls[2][0] as Api.payments.GetStarsTransactions).offset).toBe("p3");
  });

  it("C: duplicate transaction across page boundary is deduped", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" }), makeTx({ id: "b" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "b" }), makeTx({ id: "c" })] }),
    ]);
    const r = await scanStarsTransactions(client, {});
    expect(r.transactions.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(r.complete).toBe(true);
  });

  it("D: repeated nextOffset - stop, complete=false", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "b" })], nextOffset: "p2" }),
    ]);
    const r = await scanStarsTransactions(client, {});
    expect(r.stopReason).toBe("repeated_offset");
    expect(r.complete).toBe(false);
    expect(client.invoke).toHaveBeenCalledTimes(2);
  });

  it("E: maxPages reached - complete=false", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "b" })], nextOffset: "p3" }),
    ]);
    const r = await scanStarsTransactions(client, { maxPages: 2 });
    expect(r.stopReason).toBe("max_pages");
    expect(r.complete).toBe(false);
    expect(r.pages).toBe(2);
  });

  it("F: maxTransactions reached - complete=false", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" }), makeTx({ id: "b" })], nextOffset: "p2" }),
    ]);
    const r = await scanStarsTransactions(client, { maxTransactions: 2 });
    expect(r.stopReason).toBe("max_transactions");
    expect(r.complete).toBe(false);
    expect(r.transactions).toHaveLength(2);
  });
});

// -- pollNewTransactions ----------------------------------------------------

describe("pollNewTransactions", () => {
  it("G: sinceId on first page - only newer transactions", async () => {
    const client = makeClient([
      makeStatus({
        history: [makeTx({ id: "new1" }), makeTx({ id: "new2" }), makeTx({ id: "since" })],
      }),
    ]);
    const r = await pollNewTransactions(client, "since", {});
    expect(r.transactions.map((t) => t.id)).toEqual(["new1", "new2"]);
    expect(r.cursorFound).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.stopReason).toBe("cursor_found");
  });

  it("H: sinceId on second page - real second request", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "n1" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "n2" }), makeTx({ id: "since" })] }),
    ]);
    const r = await pollNewTransactions(client, "since", {});
    expect(client.invoke).toHaveBeenCalledTimes(2);
    expect(r.transactions.map((t) => t.id)).toEqual(["n1", "n2"]);
    expect(r.cursorFound).toBe(true);
  });

  it("I: sinceId on fourth page - multi-page gap", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "n1" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "n2" })], nextOffset: "p3" }),
      makeStatus({ history: [makeTx({ id: "n3" })], nextOffset: "p4" }),
      makeStatus({ history: [makeTx({ id: "n4" }), makeTx({ id: "since" })] }),
    ]);
    const r = await pollNewTransactions(client, "since", {});
    expect(r.transactions.map((t) => t.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(r.cursorFound).toBe(true);
    expect(r.complete).toBe(true);
    expect(client.invoke).toHaveBeenCalledTimes(4);
  });

  it("J: sinceId absent, history ended - cursorFound=false, complete=true", async () => {
    const client = makeClient([makeStatus({ history: [makeTx({ id: "a" })] })]);
    const r = await pollNewTransactions(client, "missing", {});
    expect(r.cursorFound).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.stopReason).toBe("history_end");
  });

  it("K: sinceId absent, maxPages reached - complete=false", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "a" })], nextOffset: "p2" }),
      makeStatus({ history: [makeTx({ id: "b" })], nextOffset: "p3" }),
    ]);
    const r = await pollNewTransactions(client, "missing", { maxPages: 2 });
    expect(r.cursorFound).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.stopReason).toBe("max_pages");
  });

  it("L: sinceId transaction itself is not included", async () => {
    const client = makeClient([
      makeStatus({ history: [makeTx({ id: "new" }), makeTx({ id: "since" })], nextOffset: "p2" }),
    ]);
    const r = await pollNewTransactions(client, "since", {});
    expect(r.transactions.map((t) => t.id)).toEqual(["new"]);
  });

  it("sinceId null - scans with documented truncation", async () => {
    const client = makeClient([makeStatus({ history: [makeTx({ id: "a" })], nextOffset: "p2" })]);
    const r = await pollNewTransactions(client, null, { maxPages: 1 });
    expect(r.cursorFound).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.stopReason).toBe("max_pages");
  });
});

// -- transactionKey ---------------------------------------------------------

describe("transactionKey", () => {
  it("scoped by self ledger", () => {
    const tx = normalizeStarsTransaction(makeTx({ id: "xyz" }), "inbound");
    expect(transactionKey(tx)).toBe("stars:self:xyz");
  });
});
