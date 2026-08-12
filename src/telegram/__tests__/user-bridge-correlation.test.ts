import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Api, errors } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import { outgoingTracker } from "../outgoing-tracker";

// Mock the TelegramUserClient module used by GramJSUserBridge.
const mockClient = {
  addUpdateMessageIdHandler: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  getMe: vi.fn(() => ({
    id: 222n,
    username: "creator",
    firstName: "Creator",
    isBot: false,
  })),
  getClient: vi.fn(),
  sendMessageLowLevel: vi.fn(),
  sendMediaLowLevel: vi.fn(),
  buildInputMedia: vi.fn(),
  forwardMessagesLowLevel: vi.fn(),
  getMessages: vi.fn(),
  addServiceMessageHandler: vi.fn(),
  getEntity: vi.fn(),
};

vi.mock("../client.js", () => {
  class MockTelegramUserClient {
    addUpdateMessageIdHandler = mockClient.addUpdateMessageIdHandler;
    connect = mockClient.connect;
    disconnect = mockClient.disconnect;
    isConnected = mockClient.isConnected;
    getMe = mockClient.getMe;
    getClient = mockClient.getClient;
    sendMessageLowLevel = mockClient.sendMessageLowLevel;
    sendMediaLowLevel = mockClient.sendMediaLowLevel;
    buildInputMedia = mockClient.buildInputMedia;
    forwardMessagesLowLevel = mockClient.forwardMessagesLowLevel;
    getMessages = mockClient.getMessages;
    addServiceMessageHandler = mockClient.addServiceMessageHandler;
    getEntity = mockClient.getEntity;
  }
  return { TelegramUserClient: MockTelegramUserClient };
});

import { GramJSUserBridge } from "../bridges/user.js";

function makeUpdatesResult(randomId: bigint, messageId: number, date = 1000): Api.Updates {
  const message = new Api.Message({
    id: messageId,
    date,
    message: "hi",
    peerId: new Api.PeerUser({ userId: toLong(222n) }),
    out: true,
  });
  return new Api.Updates({
    updates: [
      new Api.UpdateMessageID({ id: messageId, randomId: toLong(randomId) }),
      new Api.UpdateNewMessage({ message, pts: 1, ptsCount: 0 }),
    ],
    users: [],
    chats: [],
    date,
    seq: 0,
  });
}

describe("GramJSUserBridge — outgoing correlation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outgoingTracker.clear();
  });

  afterEach(() => {
    outgoingTracker.clear();
  });

  it("L: copyMessage text branch — one sent message = ONE correlation record", async () => {
    // The source message has no media → text branch.
    const sourceMsg = new Api.Message({ id: 5, date: 900, message: "hello" });
    mockClient.getClient.mockReturnValue({
      getMessages: vi.fn(async () => [sourceMsg]),
      downloadMedia: vi.fn(),
    });

    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      return makeUpdatesResult(options.randomId, 100);
    });

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    const sent = await bridge.copyMessage("111", "222", 5);

    expect(sent.id).toBe(100);
    // Exactly one correlation record must exist for the whole logical send.
    expect(outgoingTracker.pendingCount).toBe(1);
    // And the RPC request carried the SAME randomId the tracker reserved.
    const record = outgoingTracker.getByRandomId(sent.randomId as bigint);
    expect(record).toBeDefined();
    expect(record?.telegramMessageId).toBe(100);

    const sendCalls = sendLowLevel.mock.calls;
    expect(sendCalls.length).toBe(1);
    expect(String(sendCalls[0][1].randomId)).toBe(String(sent.randomId));

    // The outgoing message classifies as programmatic.
    expect(await outgoingTracker.classifyOutgoing("222", 100, { waitMs: 0 })).toBe("programmatic");
  });

  it("M: media send uses exactly the randomId the tracker reserved in the MTProto request", async () => {
    const sendLowLevel = mockClient.sendMediaLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      return makeUpdatesResult(options.randomId, 200);
    });

    const buildInputMedia = mockClient.buildInputMedia as ReturnType<typeof vi.fn>;
    buildInputMedia.mockResolvedValue(new Api.InputMediaDice({ emoticon: "🎲" }));

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    const sent = await bridge.sendDice("222");

    // The MTProto request must have used the tracker's reserved randomId,
    // not some independently generated one.
    const requestRandomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    expect(String(requestRandomId)).toBe(String(sent.randomId));

    const record = outgoingTracker.getByRandomId(requestRandomId);
    expect(record).toBeDefined();
    expect(record?.telegramMessageId).toBe(200);

    expect(await outgoingTracker.classifyOutgoing("222", 200, { waitMs: 0 })).toBe("programmatic");
  });

  it("sendMessage: manual outgoing in the same chat is NOT stolen by a pending send", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    // The send is slow: resolve later so we can check pending state mid-flight.
    sendLowLevel.mockImplementation(
      (_chatId: string, options: { randomId: bigint }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(makeUpdatesResult(options.randomId, 300)), 50);
        })
    );

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    const sendPromise = bridge.sendMessage({ chatId: "222", text: "programmatic" });

    // While the AI send is pending, a manual outgoing message (id 299) arrives.
    const manual = await outgoingTracker.classifyOutgoing("222", 299, { waitMs: 20, pollMs: 5 });
    expect(manual).toBe("creator_manual");

    const sent = await sendPromise;
    expect(sent.id).toBe(300);
    expect(await outgoingTracker.classifyOutgoing("222", 300, { waitMs: 20, pollMs: 5 })).toBe(
      "programmatic"
    );
  });

  it("ambiguous failure (ECONNRESET) keeps correlation; retry reuses the SAME randomId in the real MTProto request", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    let attempt = 0;
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("ECONNRESET");
      }
      return makeUpdatesResult(options.randomId, 400);
    });

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    // First attempt fails ambiguously.
    await expect(bridge.sendMessage({ chatId: "222", text: "retry me" })).rejects.toThrow(
      "ECONNRESET"
    );

    // The correlation survives with the SAME randomId.
    expect(outgoingTracker.pendingCount).toBe(1);
    const firstRandomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    const record = outgoingTracker.getByRandomId(firstRandomId);
    expect(record).toBeDefined();
    expect(record?.state).toBe("AMBIGUOUS");

    // Retry-aware caller reuses the transport randomId.
    const sent = await bridge.sendMessage({
      chatId: "222",
      text: "retry me",
      transportRandomId: firstRandomId,
    });

    // The SECOND MTProto request carried the SAME random_id.
    const secondRandomId = sendLowLevel.mock.calls[1][1].randomId as bigint;
    expect(String(secondRandomId)).toBe(String(firstRandomId));

    // No second tracker record was created.
    expect(outgoingTracker.pendingCount).toBe(1);
    expect(sent.randomId?.toString()).toBe(firstRandomId.toString());

    expect(await outgoingTracker.classifyOutgoing("222", 400, { waitMs: 0 })).toBe("programmatic");
  });

  it("retry with an existing AMBIGUOUS record does not create a duplicate correlation", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockRejectedValueOnce(new Error("ECONNRESET"));
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      return makeUpdatesResult(options.randomId, 500);
    });

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    await expect(bridge.sendMessage({ chatId: "222", text: "x" })).rejects.toThrow("ECONNRESET");
    const randomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    expect(outgoingTracker.pendingCount).toBe(1);

    await bridge.sendMessage({ chatId: "222", text: "x", transportRandomId: randomId });

    expect(outgoingTracker.pendingCount).toBe(1);
    const record = outgoingTracker.getByRandomId(randomId);
    expect(record?.telegramMessageId).toBe(500);
  });

  it("RANDOM_ID_DUPLICATE keeps the correlation ambiguous (not deleted)", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockRejectedValue(
      new errors.RPCError("RANDOM_ID_DUPLICATE", new Api.messages.GetChats({}), 500)
    );

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    await expect(bridge.sendMessage({ chatId: "222", text: "dup" })).rejects.toThrow();

    // The correlation must survive — a previous attempt may have been accepted.
    expect(outgoingTracker.pendingCount).toBe(1);
    const randomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    const record = outgoingTracker.getByRandomId(randomId);
    expect(record?.state).toBe("AMBIGUOUS");
  });

  it("RPC 500 does NOT destroy the correlation", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockRejectedValue(
      new errors.RPCError("INTERNAL", new Api.messages.GetChats({}), 500)
    );

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    await expect(bridge.sendMessage({ chatId: "222", text: "500" })).rejects.toThrow();

    expect(outgoingTracker.pendingCount).toBe(1);
    const randomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    expect(outgoingTracker.getByRandomId(randomId)?.state).toBe("AMBIGUOUS");
  });

  it("definite RPC 400 removes the correlation", async () => {
    const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockRejectedValue(
      new errors.RPCError("PEER_ID_INVALID", new Api.messages.GetChats({}), 400)
    );

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    await expect(bridge.sendMessage({ chatId: "222", text: "invalid" })).rejects.toThrow();

    expect(outgoingTracker.pendingCount).toBe(0);
  });

  it("media upload happens BEFORE reserve — no stale correlation during long upload", async () => {
    const buildInputMedia = mockClient.buildInputMedia as ReturnType<typeof vi.fn>;
    let releaseUpload: (() => void) | undefined;
    buildInputMedia.mockImplementation(
      () =>
        new Promise<Api.TypeInputMedia>((resolve) => {
          releaseUpload = () => resolve(new Api.InputMediaDice({ emoticon: "🎲" }));
        })
    );

    const sendLowLevel = mockClient.sendMediaLowLevel as ReturnType<typeof vi.fn>;
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      return makeUpdatesResult(options.randomId, 600);
    });

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    const sendPromise = bridge.sendPhoto("222", Buffer.from("slow"));

    // While the upload is in flight, no send correlation exists yet — it
    // cannot go stale before the actual SendMedia.
    expect(outgoingTracker.pendingCount).toBe(0);

    releaseUpload?.();
    const sent = await sendPromise;

    expect(sent.id).toBe(600);
    expect(outgoingTracker.pendingCount).toBe(1);
    const requestRandomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    expect(outgoingTracker.getByRandomId(requestRandomId)).toBeDefined();
  });

  it("media retry with transportRandomId sends the SAME random_id", async () => {
    const buildInputMedia = mockClient.buildInputMedia as ReturnType<typeof vi.fn>;
    buildInputMedia.mockResolvedValue(new Api.InputMediaDice({ emoticon: "🎲" }));

    const sendLowLevel = mockClient.sendMediaLowLevel as ReturnType<typeof vi.fn>;
    let attempt = 0;
    sendLowLevel.mockImplementation(async (_chatId: string, options: { randomId: bigint }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("socket closed");
      }
      return makeUpdatesResult(options.randomId, 700);
    });

    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    await expect(bridge.sendDice("222")).rejects.toThrow("socket closed");

    const firstRandomId = sendLowLevel.mock.calls[0][1].randomId as bigint;
    expect(outgoingTracker.getByRandomId(firstRandomId)?.state).toBe("AMBIGUOUS");

    const sent = await bridge.sendDice("222", undefined, firstRandomId);

    const secondRandomId = sendLowLevel.mock.calls[1][1].randomId as bigint;
    expect(String(secondRandomId)).toBe(String(firstRandomId));
    expect(sent.id).toBe(700);
    expect(outgoingTracker.pendingCount).toBe(1);
  });

  it("O: anonymous gift does not leak sender identity through the outer message", async () => {
    // A service message whose message-level sender is resolvable, but whose
    // Gift action has NO fromId (truly anonymous). The outer TelegramMessage
    // must not publish the resolvable sender as an authenticated Gift source.
    const msgSender = new Api.PeerUser({ userId: toLong(123n) });
    const msgPeer = new Api.PeerUser({ userId: toLong(222n) });

    const gift = new Api.StarGift({
      id: toLong(42n),
      stars: toLong(50n),
      convertStars: toLong(45n),
      title: "Delicious Cake",
      sticker: new Api.Document({ id: toLong(1n) }),
    });

    const serviceMsg = new Api.MessageService({
      id: 10,
      date: 1700000000,
      fromId: msgSender,
      peerId: msgPeer,
      action: new Api.MessageActionStarGift({
        gift,
        fromId: undefined,
        nameHidden: false,
      }),
    });

    const handler = vi.fn();
    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    bridge.onServiceMessage(handler);

    const registered = (mockClient.addServiceMessageHandler as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    await registered(serviceMsg);

    const message = handler.mock.calls[0][0] as import("../bridge-interface").TelegramMessage;
    expect(message.giftEvent?.fromAnonymous).toBe(true);
    expect(message.giftEvent?.senderId).toBeUndefined();
    expect(message.senderId).toBe(0);
    expect(message.senderUsername).toBeUndefined();
    expect(message.senderFirstName).toBeUndefined();
  });

  it("O2: nameHidden=true with known sender keeps identity (no over-anonymization)", async () => {
    const msgSender = new Api.PeerUser({ userId: toLong(123n) });
    const msgPeer = new Api.PeerUser({ userId: toLong(222n) });

    const gift = new Api.StarGift({
      id: toLong(42n),
      stars: toLong(50n),
      convertStars: toLong(45n),
      title: "Delicious Cake",
      sticker: new Api.Document({ id: toLong(1n) }),
    });

    const serviceMsg = new Api.MessageService({
      id: 11,
      date: 1700000000,
      fromId: msgSender,
      peerId: msgPeer,
      action: new Api.MessageActionStarGift({
        gift,
        fromId: msgSender,
        nameHidden: true,
      }),
    });

    const handler = vi.fn();
    const bridge = new GramJSUserBridge({
      apiId: 1,
      apiHash: "hash",
      phone: "123",
      sessionPath: "/tmp/fake",
    });

    bridge.onServiceMessage(handler);

    const registered = (mockClient.addServiceMessageHandler as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    await registered(serviceMsg);

    const message = handler.mock.calls[0][0] as import("../bridge-interface").TelegramMessage;
    expect(message.giftEvent?.fromAnonymous).toBe(false);
    expect(message.giftEvent?.nameHidden).toBe(true);
    expect(message.giftEvent?.senderId).toBe("123");
  });
});
