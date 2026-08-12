import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Api } from "telegram";
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
});
