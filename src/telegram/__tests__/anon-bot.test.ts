import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Api } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import { diagnoseAnonBotUpdate } from "../anon-diag";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock TelegramUserClient used by GramJSUserBridge.
const mockClient = {
  addUpdateMessageIdHandler: vi.fn(),
  addEditedMessageHandler: vi.fn(),
  addRawUpdateHandler: vi.fn(),
  addNewMessageHandler: vi.fn(),
  addServiceMessageHandler: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  getMe: vi.fn(() => ({ id: 222n, username: "creator", firstName: "Creator", isBot: false })),
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
    addEditedMessageHandler = mockClient.addEditedMessageHandler;
    addRawUpdateHandler = mockClient.addRawUpdateHandler;
    addNewMessageHandler = mockClient.addNewMessageHandler;
    addServiceMessageHandler = mockClient.addServiceMessageHandler;
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
import type { TelegramMessage } from "../bridge-interface.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";

function makeInlineButtons(): Api.ReplyInlineMarkup {
  return new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButtonCallback({ text: "Search", data: Buffer.from("search") }),
          new Api.KeyboardButtonUrl({ text: "Site", url: "https://example.com" }),
        ],
      }),
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButtonSwitchInline({ text: "Share", query: "invite", samePeer: true }),
        ],
      }),
    ],
  });
}

function makeReplyKeyboard(): Api.ReplyKeyboardMarkup {
  return new Api.ReplyKeyboardMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButton({ text: "🔍 Search" }),
          new Api.KeyboardButton({ text: "Stop" }),
        ],
      }),
    ],
  });
}

describe("anonymous bot transport primitives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onEditedMessage", () => {
    it("edited bot message reaches the boundary with the SAME message id and isEdited=true", async () => {
      // An edited message must keep the original message id, not a new one.
      const editedMsg = new Api.Message({
        id: 42,
        date: 1700000000,
        message: "updated text",
        editDate: 1700000100,
        peerId: new Api.PeerUser({ userId: toLong(555n) }),
        out: false,
      });

      const handler = vi.fn();
      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      bridge.onEditedMessage(handler);

      const registered = mockClient.addEditedMessageHandler.mock.calls[0][0];
      await registered({ message: editedMsg, chatId: "555" });

      const parsed = handler.mock.calls[0][0] as TelegramMessage;
      expect(parsed.id).toBe(42);
      expect(parsed.isEdited).toBe(true);
      expect(parsed.text).toBe("updated text");
    });
  });

  describe("onRawUpdate", () => {
    it("subscribes typed Api.TypeUpdate events via the narrow seam", async () => {
      const handler = vi.fn();
      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      bridge.onRawUpdate(handler);
      const registered = mockClient.addRawUpdateHandler.mock.calls[0][0];

      const update = new Api.UpdateNewMessage({
        message: new Api.Message({
          id: 1,
          date: 1,
          peerId: new Api.PeerUser({ userId: toLong(555n) }),
        }),
        pts: 1,
        ptsCount: 0,
      });
      await registered(update);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBe(update);
    });
  });

  describe("button extraction", () => {
    function captureParsedMessage(): Promise<TelegramMessage> {
      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });
      const handler = vi.fn();
      bridge.onNewMessage(handler);

      const newMsgHandler = mockClient.addNewMessageHandler.mock.calls[0][0];
      return new Promise((resolve) => {
        handler.mockImplementation((msg: TelegramMessage) => resolve(msg));
        void newMsgHandler({
          message: new Api.Message({
            id: 7,
            date: 1,
            peerId: new Api.PeerUser({ userId: toLong(555n) }),
            replyMarkup: makeInlineButtons(),
          }),
        } as NewMessageEvent);
      });
    }

    it("extracts callback/url/switch_inline buttons from inline markup", async () => {
      const msg = await captureParsedMessage();
      expect(msg.buttons).toHaveLength(2);
      expect(msg.buttons![0][0]).toMatchObject({ text: "Search", type: "callback" });
      expect(msg.buttons![0][0].data).toEqual(Buffer.from("search"));
      expect(msg.buttons![0][1]).toMatchObject({
        text: "Site",
        type: "url",
        url: "https://example.com",
      });
      expect(msg.buttons![1][0]).toMatchObject({
        text: "Share",
        type: "switch_inline",
        query: "invite",
        samePeer: true,
      });
    });

    it("treats only plain reply keyboard buttons as commands", async () => {
      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });
      const handler = vi.fn();
      bridge.onNewMessage(handler);

      const newMsgHandler = mockClient.addNewMessageHandler.mock.calls[0][0];
      await newMsgHandler({
        message: new Api.Message({
          id: 8,
          date: 1,
          peerId: new Api.PeerUser({ userId: toLong(555n) }),
          replyMarkup: new Api.ReplyKeyboardMarkup({
            rows: [
              new Api.KeyboardButtonRow({
                buttons: [
                  new Api.KeyboardButton({ text: "Search" }),
                  new Api.KeyboardButtonRequestPhone({ text: "Share phone" }),
                ],
              }),
            ],
          }),
        }),
      } as NewMessageEvent);

      const msg = handler.mock.calls[0][0] as TelegramMessage;
      expect(msg.buttons![0][0]).toMatchObject({
        text: "Search",
        command: "Search",
        type: "command",
      });
      expect(msg.buttons![0][1]).toMatchObject({ text: "Share phone", type: "unknown" });
      expect(msg.buttons![0][1].command).toBeUndefined();

      const ok = await bridge.clickButton("555", 8, msg.buttons![0][1]);
      expect(ok).toBe(false);
      expect(mockClient.sendMessageLowLevel).not.toHaveBeenCalled();
    });
  });

  describe("clickButton", () => {
    it("callback button invokes GetBotCallbackAnswer with the exact data", async () => {
      const rawClient = {
        invoke: vi.fn().mockResolvedValue(new Api.messages.BotCallbackAnswer({})),
      };
      mockClient.getClient.mockReturnValue(rawClient);

      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      const ok = await bridge.clickButton("555", 42, {
        text: "Search",
        data: Buffer.from("search"),
        type: "callback",
      });

      expect(ok).toBe(true);
      expect(rawClient.invoke).toHaveBeenCalledTimes(1);
      const req = rawClient.invoke.mock.calls[0][0] as Api.messages.GetBotCallbackAnswer;
      expect(req).toBeInstanceOf(Api.messages.GetBotCallbackAnswer);
      expect(req.msgId).toBe(42);
      expect(req.data).toEqual(Buffer.from("search"));
    });

    it("command button sends the literal text", async () => {
      const rawClient = {
        invoke: vi.fn().mockResolvedValue(new Api.messages.BotCallbackAnswer({})),
      };
      mockClient.getClient.mockReturnValue(rawClient);
      const sendLowLevel = mockClient.sendMessageLowLevel as ReturnType<typeof vi.fn>;
      sendLowLevel.mockImplementation(async (_peer: unknown, opts: { randomId: bigint }) => {
        return new Api.Updates({
          updates: [
            new Api.UpdateMessageID({ id: 100, randomId: opts.randomId }),
            new Api.UpdateNewMessage({
              message: new Api.Message({
                id: 100,
                date: 1,
                peerId: new Api.PeerUser({ userId: toLong(555n) }),
              }),
              pts: 1,
              ptsCount: 0,
            }),
          ],
          users: [],
          chats: [],
          date: 1,
          seq: 0,
        });
      });

      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      const ok = await bridge.clickButton("555", 42, {
        text: "🔍 Search",
        command: "🔍 Search",
        type: "command",
      });

      expect(ok).toBe(true);
      expect(sendLowLevel).toHaveBeenCalledTimes(1);
      expect(sendLowLevel.mock.calls[0][1].message).toBe("🔍 Search");
    });

    it("malformed/unsupported button does NOT trigger any action", async () => {
      const rawClient = { invoke: vi.fn() };
      mockClient.getClient.mockReturnValue(rawClient);

      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      const ok = await bridge.clickButton("555", 42, {
        text: "Mystery",
        type: "unknown",
      });

      expect(ok).toBe(false);
      expect(rawClient.invoke).not.toHaveBeenCalled();
      expect(mockClient.sendMessageLowLevel).not.toHaveBeenCalled();
    });

    it("url button is NOT clicked (no safe MTProto action)", async () => {
      const rawClient = { invoke: vi.fn() };
      mockClient.getClient.mockReturnValue(rawClient);

      const bridge = new GramJSUserBridge({
        apiId: 1,
        apiHash: "hash",
        phone: "123",
        sessionPath: "/tmp/fake",
      });

      const ok = await bridge.clickButton("555", 42, {
        text: "Site",
        type: "url",
      });

      expect(ok).toBe(false);
      expect(rawClient.invoke).not.toHaveBeenCalled();
    });
  });

  describe("diagnostic capture", () => {
    it("does not throw on a NewMessage update", () => {
      const update = new Api.UpdateNewMessage({
        message: new Api.Message({
          id: 9,
          date: 1,
          message: "hello",
          peerId: new Api.PeerUser({ userId: toLong(555n) }),
          replyMarkup: makeReplyKeyboard(),
        }),
        pts: 1,
        ptsCount: 0,
      });
      expect(() => diagnoseAnonBotUpdate(update)).not.toThrow();
    });
  });
});
