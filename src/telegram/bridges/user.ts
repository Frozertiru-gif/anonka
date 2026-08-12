import { TelegramUserClient, type TelegramClientConfig } from "../client.js";
import { Api } from "telegram";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { createLogger } from "../../utils/logger.js";
import { withFloodRetry } from "../flood-retry.js";
import { randomLong } from "../../utils/gramjs-bigint.js";
import { classifyMedia } from "../bridge-interface.js";
import { outgoingTracker } from "../outgoing-tracker.js";
import { extractSentMessageResult, isDefiniteSendFailure } from "../send-result.js";
import { formatGiftEventText, giftSenderPeer, parseGiftServiceAction } from "../gift-parser.js";
import type {
  ITelegramBridge,
  TelegramMessage,
  InlineButton, // eslint-disable-line @typescript-eslint/no-unused-vars -- re-exported for backward compat
  ParsedButton,
  SendMessageOptions,
  SentMessage,
  EditMessageOptions,
  ReplyContext,
  BotInfo,
  ChatInfo,
} from "../bridge-interface.js";
import { logGiftEvent } from "../gift-log.js";

export type { TelegramMessage, InlineButton, SendMessageOptions } from "../bridge-interface.js";

const log = createLogger("Telegram");

/** Max time to wait for getSender() before giving up (deleted accounts, timeouts). */
const SENDER_RESOLVE_TIMEOUT_MS = 5000;

export class GramJSUserBridge implements ITelegramBridge {
  private client: TelegramUserClient;
  private ownUserId?: bigint;
  private ownUsername?: string;
  private peerCache: Map<string, Api.TypePeer> = new Map();

  constructor(config: TelegramClientConfig) {
    this.client = new TelegramUserClient(config);

    // Authoritative acknowledgement stream: whenever Telegram pushes an
    // UpdateMessageID for one of our sends (raw update stream), bind the
    // random_id → message_id mapping BEFORE the outgoing NewMessage event
    // reaches the regular handler pipeline.
    this.client.addUpdateMessageIdHandler((update) => {
      if (update.randomId === undefined) return;
      outgoingTracker.acknowledge(BigInt(update.randomId.toString()), update.id);
    });
  }

  /** Cache a chat's peer for later resolution, evicting the oldest past a cap. */
  private cachePeer(chatId: string, peer: Api.TypePeer): void {
    this.peerCache.set(chatId, peer);
    if (this.peerCache.size > 5000) {
      const oldest = this.peerCache.keys().next().value;
      if (oldest !== undefined) this.peerCache.delete(oldest);
    }
  }

  getMode(): "user" | "bot" {
    return "user";
  }

  requiresOffsetDedup(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const me = this.client.getMe();
    if (me) {
      this.ownUserId = me.id;
      this.ownUsername = me.username?.toLowerCase();
    }

    outgoingTracker.startCleanup();

    try {
      await this.getDialogs();
    } catch (error) {
      log.warn({ err: error }, "Could not load dialogs");
    }
  }

  async disconnect(): Promise<void> {
    outgoingTracker.stopCleanup();
    outgoingTracker.clear();
    await this.client.disconnect();
  }

  isAvailable(): boolean {
    return this.client.isConnected();
  }

  getOwnUserId(): bigint | undefined {
    return this.ownUserId;
  }

  getUsername(): string | undefined {
    const me = this.client.getMe();
    return me?.username;
  }

  async getMe(): Promise<BotInfo | undefined> {
    const me = this.client.getMe();
    if (!me) return undefined;
    return {
      id: Number(me.id),
      username: me.username,
      firstName: me.firstName ?? "Unknown",
      isBot: me.isBot,
    };
  }

  async getMessages(chatId: string, limit: number = 50): Promise<TelegramMessage[]> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;
      const messages = await this.client.getMessages(peer, { limit });
      const results = await Promise.allSettled(messages.map((msg) => this.parseMessage(msg)));
      return results
        .filter((r): r is PromiseFulfilledResult<TelegramMessage> => r.status === "fulfilled")
        .map((r) => r.value);
    } catch (error) {
      log.error({ err: error }, "Error getting messages");
      return [];
    }
  }

  /**
   * Resolve the transport random_id for a logical send.
   *
   * - Without an explicit correlation: generate + reserve a fresh randomId.
   * - With an explicit correlation (retry-aware caller, e.g. the Phase 1
   *   Outbox): reuse the existing tracker record if it is RESERVED/SENDING/
   *   AMBIGUOUS (never create a conflicting duplicate record). If the old
   *   record was lost (expired/cleanup), re-reserve the SAME randomId so the
   *   retry still uses the same MTProto random_id.
   */
  private resolveTransportRandomId(chatId: string, transportRandomId?: bigint): bigint {
    if (transportRandomId === undefined) {
      const randomId = randomLong();
      outgoingTracker.reserve(chatId, randomId);
      return randomId;
    }

    const existing = outgoingTracker.getByRandomId(transportRandomId);
    if (existing) {
      if (existing.chatId !== chatId) {
        throw new Error(
          `transportRandomId ${transportRandomId} belongs to chat ${existing.chatId}, cannot reuse for ${chatId}`
        );
      }
      if (existing.state === "ACKNOWLEDGED" || existing.state === "OBSERVED") {
        throw new Error(
          `transportRandomId ${transportRandomId} is already acknowledged (message ${existing.telegramMessageId})`
        );
      }
      return transportRandomId;
    }

    outgoingTracker.reserve(chatId, transportRandomId);
    return transportRandomId;
  }

  /**
   * Run a tracked send: one logical send, one transport randomId.
   *
   * The randomId is generated by the caller BEFORE any network activity and
   * reused verbatim by every flood-retry attempt, so a retry of the same
   * logical send is idempotent at the MTProto level (Telegram dedupes by
   * random_id within its window).
   *
   * The record is marked inFlight for the whole operation so cleanup can
   * never expire an active send, and released in every exit path.
   */
  private async runTrackedSend(
    chatId: string,
    randomId: bigint,
    sendFn: () => Promise<Api.TypeUpdates>
  ): Promise<SentMessage> {
    outgoingTracker.beginOperation(randomId);
    outgoingTracker.markSending(randomId);
    try {
      const result = await withFloodRetry(sendFn, undefined, undefined, chatId);
      const sent = extractSentMessageResult(result, randomId);
      if (!sent) {
        // Telegram accepted the request but we could not extract the
        // message id — the correlation is ambiguous, keep it for recovery.
        const error = new Error(
          "Send completed but no message id could be extracted from the RPC result"
        );
        outgoingTracker.markAmbiguousFailure(randomId, error);
        throw error;
      }
      outgoingTracker.acknowledge(randomId, sent.messageId, chatId);
      return { id: sent.messageId, date: sent.date, chatId, randomId };
    } catch (error) {
      if (isDefiniteSendFailure(error)) {
        outgoingTracker.markDefiniteFailure(randomId, error);
      } else {
        outgoingTracker.markAmbiguousFailure(randomId, error);
      }
      throw error;
    } finally {
      outgoingTracker.endOperation(randomId);
    }
  }

  async sendMessage(
    options: SendMessageOptions & { _rawPeer?: Api.TypePeer; transportRandomId?: bigint }
  ): Promise<SentMessage> {
    const peer = options._rawPeer || this.peerCache.get(options.chatId) || options.chatId;
    const randomId = this.resolveTransportRandomId(options.chatId, options.transportRandomId);

    const inlineKeyboard = options.inlineKeyboard;
    const hasKeyboard = !!inlineKeyboard && inlineKeyboard.length > 0;
    const replyMarkup = hasKeyboard ? this.buildInlineMarkup(inlineKeyboard) : undefined;

    // Formatting parity with the pre-correlation bridge:
    // - keyboard path historically sent RAW text with default link preview;
    // - plain path historically applied markdown→HTML parsing and disabled
    //   link previews (TelegramUserClient.sendMessage wrapper).
    const parseMode = hasKeyboard ? "none" : "html";
    const linkPreview = hasKeyboard ? true : false;

    return this.runTrackedSend(options.chatId, randomId, () =>
      this.client.sendMessageLowLevel(peer, {
        message: options.text,
        randomId,
        replyTo: options.replyToId,
        replyMarkup,
        parseMode,
        linkPreview,
      })
    );
  }

  /** Build a GramJS inline-keyboard markup from the bridge's button rows. */
  private buildInlineMarkup(
    inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>
  ): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
      rows: inlineKeyboard.map(
        (row) =>
          new Api.KeyboardButtonRow({
            buttons: row.map(
              (btn) =>
                new Api.KeyboardButtonCallback({
                  text: btn.text,
                  data: Buffer.from(btn.callback_data),
                })
            ),
          })
      ),
    });
  }

  async editMessage(options: EditMessageOptions): Promise<SentMessage> {
    try {
      const peer = this.peerCache.get(options.chatId) || options.chatId;

      let buttons: Api.ReplyInlineMarkup | undefined;
      if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
        buttons = this.buildInlineMarkup(options.inlineKeyboard);
      }

      const gramJsClient = this.client.getClient();
      const result = await withFloodRetry(
        () =>
          gramJsClient.invoke(
            new Api.messages.EditMessage({
              peer,
              id: options.messageId,
              message: options.text,
              replyMarkup: buttons,
            })
          ),
        undefined,
        undefined,
        options.chatId
      );

      let msg: Api.Message | undefined;
      if (result instanceof Api.Updates) {
        const messageUpdate = result.updates.find(
          (u) => u.className === "UpdateEditMessage" || u.className === "UpdateEditChannelMessage"
        );
        if (messageUpdate && "message" in messageUpdate) {
          msg = messageUpdate.message as Api.Message;
        }
      }

      if (msg) {
        return { id: msg.id, date: msg.date, chatId: options.chatId };
      }
      return { id: options.messageId, date: Math.floor(Date.now() / 1000), chatId: options.chatId };
    } catch (error) {
      log.error({ err: error }, "Error editing message");
      throw error;
    }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const gramJsClient = this.client.getClient();
      const isChannel = chatId.startsWith("-100");

      if (isChannel) {
        const channel = await gramJsClient.getEntity(chatId);
        await gramJsClient.invoke(
          new Api.channels.DeleteMessages({
            channel,
            id: [messageId],
          })
        );
      } else {
        await gramJsClient.invoke(
          new Api.messages.DeleteMessages({
            id: [messageId],
            revoke: true,
          })
        );
      }
      return true;
    } catch (error) {
      log.error({ err: error }, "Error deleting message");
      return false;
    }
  }

  async forwardMessage(
    fromChatId: string,
    toChatId: string,
    messageId: number,
    transportRandomId?: bigint
  ): Promise<SentMessage> {
    const randomId = this.resolveTransportRandomId(toChatId, transportRandomId);

    return this.runTrackedSend(toChatId, randomId, () =>
      this.client.forwardMessagesLowLevel(fromChatId, toChatId, [messageId], [randomId])
    );
  }

  async sendPhoto(
    chatId: string,
    photo: string | Buffer,
    caption?: string,
    replyToId?: number,
    transportRandomId?: bigint
  ): Promise<SentMessage> {
    // Upload FIRST, reserve AFTER: the upload can take a long time and does
    // not create a Telegram message, so no send correlation should exist (or
    // be able to go stale) while it runs. An upload failure is a plain error
    // with nothing to clean up.
    const media = await this.client.buildInputMedia({ file: photo });

    const randomId = this.resolveTransportRandomId(chatId, transportRandomId);

    return this.runTrackedSend(chatId, randomId, () =>
      this.client.sendMediaLowLevel(chatId, {
        media,
        message: caption,
        randomId,
        replyTo: replyToId,
      })
    );
  }

  async sendVideo(
    chatId: string,
    video: string | Buffer,
    opts?: {
      caption?: string;
      replyToId?: number;
      duration?: number;
      width?: number;
      height?: number;
      transportRandomId?: bigint;
    }
  ): Promise<SentMessage> {
    // Upload before reserve — see sendPhoto().
    const media = await this.client.buildInputMedia({
      file: video,
      forceDocument: false,
      supportsStreaming: true,
      attributes: [
        new Api.DocumentAttributeVideo({
          roundMessage: false,
          supportsStreaming: true,
          duration: opts?.duration ?? 0,
          w: opts?.width ?? 0,
          h: opts?.height ?? 0,
        }),
      ],
    });

    const randomId = this.resolveTransportRandomId(chatId, opts?.transportRandomId);

    return this.runTrackedSend(chatId, randomId, () =>
      this.client.sendMediaLowLevel(chatId, {
        media,
        message: opts?.caption,
        randomId,
        replyTo: opts?.replyToId,
      })
    );
  }

  async sendVideoNote(
    chatId: string,
    videoNote: string | Buffer,
    opts?: {
      caption?: string;
      replyToId?: number;
      duration?: number;
      transportRandomId?: bigint;
    }
  ): Promise<SentMessage> {
    // Upload before reserve — see sendPhoto().
    const media = await this.client.buildInputMedia({
      file: videoNote,
      forceDocument: false,
      videoNote: true,
      attributes: [
        new Api.DocumentAttributeVideo({
          roundMessage: true,
          duration: opts?.duration ?? 0,
          w: 0,
          h: 0,
        }),
      ],
    });

    const randomId = this.resolveTransportRandomId(chatId, opts?.transportRandomId);

    return this.runTrackedSend(chatId, randomId, () =>
      this.client.sendMediaLowLevel(chatId, {
        media,
        message: opts?.caption,
        randomId,
        replyTo: opts?.replyToId,
      })
    );
  }

  async copyMessage(
    fromChatId: string,
    toChatId: string,
    messageId: number,
    transportRandomId?: bigint
  ): Promise<SentMessage> {
    const gramJsClient = this.client.getClient();

    // Fetch/download/upload BEFORE reserving the correlation — none of these
    // create a Telegram message, so an active send correlation should not
    // exist (or go stale) during this phase.
    const messages = await gramJsClient.getMessages(fromChatId, { ids: [messageId] });
    if (!messages || messages.length === 0 || !messages[0]) {
      throw new Error(`Message ${messageId} not found in chat ${fromChatId}`);
    }

    const sourceMsg = messages[0];

    if (!sourceMsg.media) {
      // Text-only source: ONE logical send, ONE correlation.
      // Formatting parity: the pre-correlation copyMessage delegated to
      // sendMessage(), i.e. markdown→HTML parsing with link preview disabled.
      const randomId = this.resolveTransportRandomId(toChatId, transportRandomId);
      return this.runTrackedSend(toChatId, randomId, () =>
        this.client.sendMessageLowLevel(toChatId, {
          message: sourceMsg.message ?? "",
          randomId,
          parseMode: "html",
          linkPreview: false,
        })
      );
    }

    const buffer = await gramJsClient.downloadMedia(sourceMsg, {});
    if (!buffer) {
      throw new Error(`Failed to download media from message ${messageId}`);
    }

    const media = await this.client.buildInputMedia({
      file: Buffer.isBuffer(buffer)
        ? buffer
        : typeof buffer === "string"
          ? Buffer.from(buffer)
          : Buffer.from(buffer as unknown as ArrayBuffer),
    });

    const randomId = this.resolveTransportRandomId(toChatId, transportRandomId);

    return this.runTrackedSend(toChatId, randomId, () =>
      this.client.sendMediaLowLevel(toChatId, {
        media,
        message: sourceMsg.message ?? undefined,
        randomId,
      })
    );
  }

  async clickButton(chatId: string, messageId: number, button: ParsedButton): Promise<boolean> {
    try {
      const gramJsClient = this.client.getClient();

      if (button.type === "callback" && button.data) {
        const peer = this.peerCache.get(chatId) || chatId;

        await gramJsClient.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: messageId,
            data: button.data,
          })
        );
        return true;
      }

      if (button.type === "command" && button.command) {
        await this.sendMessage({ chatId, text: button.command });
        return true;
      }

      log.warn({ chatId, messageId, button }, "Unsupported button type for clickButton");
      return false;
    } catch (error) {
      log.error({ err: error, chatId, messageId }, "Error clicking button");
      return false;
    }
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.client.setTyping(chatId);
    } catch (error) {
      log.error({ err: error }, "Error setting typing");
    }
  }

  async sendReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;

      await withFloodRetry(
        () =>
          this.client.getClient().invoke(
            new Api.messages.SendReaction({
              peer,
              msgId: messageId,
              reaction: [
                new Api.ReactionEmoji({
                  emoticon: emoji,
                }),
              ],
            })
          ),
        undefined,
        undefined,
        chatId
      );
    } catch (error) {
      log.error({ err: error }, "Error sending reaction");
      throw error;
    }
  }

  async pinMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const gramJsClient = this.client.getClient();
      await gramJsClient.invoke(
        new Api.messages.UpdatePinnedMessage({
          peer: chatId,
          id: messageId,
        })
      );
      return true;
    } catch (error) {
      log.error({ err: error }, "Error pinning message");
      return false;
    }
  }

  async sendDice(chatId: string, emoji?: string, transportRandomId?: bigint): Promise<SentMessage> {
    const randomId = this.resolveTransportRandomId(chatId, transportRandomId);

    return this.runTrackedSend(chatId, randomId, () =>
      this.client.sendMediaLowLevel(chatId, {
        media: new Api.InputMediaDice({ emoticon: emoji ?? "🎲" }),
        message: "",
        randomId,
      })
    );
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    const gramJsClient = this.client.getClient();
    const entity = await gramJsClient.getEntity(chatId);

    if (entity instanceof Api.User) {
      return {
        id: chatId,
        title: [entity.firstName, entity.lastName].filter(Boolean).join(" ") || undefined,
        type: "private",
        username: entity.username,
      };
    }

    if (entity instanceof Api.Channel) {
      const isSupergroup = entity.megagroup ?? false;
      return {
        id: chatId,
        title: entity.title,
        type: isSupergroup ? "supergroup" : "channel",
        memberCount: entity.participantsCount ?? undefined,
        username: entity.username,
      };
    }

    if (entity instanceof Api.Chat) {
      return {
        id: chatId,
        title: entity.title,
        type: "group",
        memberCount: entity.participantsCount ?? undefined,
      };
    }

    return { id: chatId, type: "private" };
  }

  onNewMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
    }
  ): void {
    this.client.addNewMessageHandler(
      async (event: NewMessageEvent) => {
        const message = await this.parseMessage(event.message);
        if (message.isOutgoing) {
          message.outgoingOrigin = await outgoingTracker.classifyOutgoing(
            message.chatId,
            message.id
          );
        }
        await handler(message);
      },
      {
        incoming: filters?.incoming,
        outgoing: filters?.outgoing,
        chats: filters?.chats,
      }
    );
  }

  onEditedMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    _filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
    }
  ): void {
    this.client.addEditedMessageHandler(async (event) => {
      const message = await this.parseMessage(event.message);
      message.isEdited = true;
      if (message.isOutgoing) {
        message.outgoingOrigin = await outgoingTracker.classifyOutgoing(message.chatId, message.id);
      }
      await handler(message);
    });
  }

  async fetchReplyContext(rawMsg: unknown): Promise<ReplyContext | null> {
    try {
      const msg = rawMsg as Api.Message;
      const replyMsg = await Promise.race([
        msg.getReplyMessage(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (!replyMsg) return null;

      let senderName: string | undefined;
      try {
        const sender = await Promise.race([
          replyMsg.getSender(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
        ]);
        if (sender && "firstName" in sender) {
          senderName = (sender.firstName as string) ?? undefined;
        }
        if (sender && "username" in sender && !senderName) {
          senderName = (sender.username as string) ?? undefined;
        }
      } catch {
        // Non-critical
      }

      const replyMsgSenderId = replyMsg.senderId ? BigInt(replyMsg.senderId.toString()) : undefined;
      const isAgent = this.ownUserId !== undefined && replyMsgSenderId === this.ownUserId;

      return {
        text: replyMsg.message || undefined,
        senderName,
        isAgent,
      };
    } catch {
      return null;
    }
  }

  getPeer(chatId: string): Api.TypePeer | undefined {
    return this.peerCache.get(chatId);
  }

  // --- Non-interface methods (user-bridge specific) ---

  /** The GramJS client wrapper. Reach it through the isUserBridge type guard. */
  getClient(): TelegramUserClient {
    return this.client;
  }

  async getDialogs(): Promise<
    Array<{
      id: string;
      title: string;
      isGroup: boolean;
      isChannel: boolean;
    }>
  > {
    try {
      const dialogs = await this.client.getDialogs();
      return dialogs.map((d) => ({
        id: d.id.toString(),
        title: d.title,
        isGroup: d.isGroup,
        isChannel: d.isChannel,
      }));
    } catch (error) {
      log.error({ err: error }, "Error getting dialogs");
      return [];
    }
  }

  onServiceMessage(handler: (message: TelegramMessage) => void | Promise<void>): void {
    this.client.addServiceMessageHandler(async (msg: Api.MessageService) => {
      const message = await this.parseServiceMessage(msg);
      if (message) {
        await handler(message);
      }
    });
  }

  /** Resolve sender username/firstName/bot flag with a timeout; non-fatal on failure. */
  private async resolveSender(
    msg: Api.Message | Api.MessageService
  ): Promise<{ senderUsername?: string; senderFirstName?: string; isBot: boolean }> {
    let senderUsername: string | undefined;
    let senderFirstName: string | undefined;
    let isBot = false;
    try {
      const sender = await Promise.race([
        msg.getSender(),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), SENDER_RESOLVE_TIMEOUT_MS)
        ),
      ]);
      if (sender && "username" in sender) {
        senderUsername = sender.username ?? undefined;
      }
      if (sender && "firstName" in sender) {
        senderFirstName = sender.firstName ?? undefined;
      }
      if (sender instanceof Api.User) {
        isBot = sender.bot ?? false;
      }
    } catch {
      // getSender() can fail on deleted accounts, timeouts, etc. — non-critical
    }
    return { senderUsername, senderFirstName, isBot };
  }

  /** Extract structured buttons from a message's reply markup. */
  private extractButtons(msg: Api.Message): ParsedButton[][] {
    const markup = (msg as unknown as { replyMarkup?: Api.TypeReplyMarkup }).replyMarkup;
    if (!markup) return [];

    try {
      if (markup instanceof Api.ReplyInlineMarkup) {
        return markup.rows.map((row: Api.KeyboardButtonRow) =>
          row.buttons.map((btn) => {
            if (btn instanceof Api.KeyboardButtonCallback) {
              return {
                text: btn.text,
                data: btn.data,
                type: "callback" as const,
              };
            }
            if (btn instanceof Api.KeyboardButtonUrl) {
              return {
                text: btn.text,
                type: "url" as const,
              };
            }
            if (btn instanceof Api.KeyboardButtonSwitchInline) {
              return {
                text: btn.text,
                type: "switch_inline" as const,
              };
            }
            return {
              text: (btn as { text?: string }).text ?? "?",
              type: "unknown" as const,
            };
          })
        );
      }

      if (markup instanceof Api.ReplyKeyboardMarkup) {
        return markup.rows.map((row: Api.KeyboardButtonRow) =>
          row.buttons.map((btn) => {
            const text = (btn as { text?: string }).text ?? "?";
            return {
              text,
              command: text.startsWith("/") ? text : `/${text.toLowerCase().replace(/\s+/g, "_")}`,
              type: "command" as const,
            };
          })
        );
      }

      return [];
    } catch {
      return [];
    }
  }

  private async parseMessage(msg: Api.Message): Promise<TelegramMessage> {
    const chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
    const senderIdBig = msg.senderId ? BigInt(msg.senderId.toString()) : BigInt(0);
    const senderId = Number(senderIdBig);

    let mentionsMe = msg.mentioned ?? false;
    if (!mentionsMe && this.ownUsername && msg.message) {
      mentionsMe = msg.message.toLowerCase().includes(`@${this.ownUsername}`);
    }

    const isChannel = msg.post ?? false;
    const isGroup = !isChannel && chatId.startsWith("-");

    if (msg.peerId) this.cachePeer(chatId, msg.peerId);

    const { senderUsername, senderFirstName, isBot } = await this.resolveSender(msg);

    const { hasMedia, mediaType } = classifyMedia({
      photo: msg.photo,
      video: msg.video,
      audio: msg.audio,
      voice: msg.voice,
      sticker: msg.sticker,
      video_note: (msg as unknown as { videoNote?: unknown }).videoNote ?? msg.videoNote,
      document: msg.document,
    });

    const replyToMsgId = msg.replyToMsgId;

    const buttons = this.extractButtons(msg);

    let text = msg.message ?? "";
    if (!text && msg.media) {
      if (msg.media.className === "MessageMediaDice") {
        const dice = msg.media as Api.MessageMediaDice;
        text = `[Dice: ${dice.emoticon} = ${dice.value}]`;
      } else if (msg.media.className === "MessageMediaGame") {
        const game = msg.media as Api.MessageMediaGame;
        text = `[Game: ${game.game.title}]`;
      } else if (msg.media.className === "MessageMediaPoll") {
        const poll = msg.media as Api.MessageMediaPoll;
        text = `[Poll: ${poll.poll.question.text}]`;
      } else if (msg.media.className === "MessageMediaContact") {
        const contact = msg.media as Api.MessageMediaContact;
        text = `[Contact: ${contact.firstName} ${contact.lastName || ""} - ${contact.phoneNumber}]`;
      } else if (
        msg.media.className === "MessageMediaGeo" ||
        msg.media.className === "MessageMediaGeoLive"
      ) {
        text = `[Location shared]`;
      }
    }

    const senderRank = (msg as unknown as { fromRank?: string }).fromRank || undefined;

    return {
      id: msg.id,
      chatId,
      senderId,
      senderUsername,
      senderFirstName,
      senderRank,
      text,
      isGroup,
      isChannel,
      isBot,
      mentionsMe,
      timestamp: new Date(msg.date * 1000),
      _rawPeer: msg.peerId,
      hasMedia,
      mediaType,
      replyToId: replyToMsgId,
      buttons: buttons.length > 0 ? buttons : undefined,
      isEdited: (msg as unknown as { editDate?: number }).editDate !== undefined,
      isOutgoing: msg.out === true,
      _rawMessage: hasMedia || !!replyToMsgId || buttons.length > 0 ? msg : undefined,
    };
  }

  /**
   * Resolve display identity (username/firstName) for a known Gift sender
   * peer. Timeout-guarded and non-fatal — display data is never a source of
   * truth. Never called for anonymous gifts.
   */
  private async resolvePeerDisplay(
    peer: Api.TypePeer
  ): Promise<{ senderUsername?: string; senderFirstName?: string; isBot: boolean }> {
    try {
      const entity = await Promise.race([
        this.client.getClient().getEntity(peer),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), SENDER_RESOLVE_TIMEOUT_MS)
        ),
      ]);

      let senderUsername: string | undefined;
      let senderFirstName: string | undefined;
      let isBot = false;

      if (entity) {
        if ("username" in entity) {
          senderUsername = entity.username ?? undefined;
        }
        if ("firstName" in entity) {
          senderFirstName = entity.firstName ?? undefined;
        }
        if (entity instanceof Api.User) {
          isBot = entity.bot ?? false;
        }
      }
      return { senderUsername, senderFirstName, isBot };
    } catch {
      return { isBot: false };
    }
  }

  private async parseServiceMessage(msg: Api.MessageService): Promise<TelegramMessage | null> {
    const action = msg.action;
    if (!action) return null;
    if (msg.out) return null;

    const chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
    const timestamp = new Date(msg.date * 1000);

    // Authoritative, deterministic parse. Display text is built FROM this.
    const giftEvent = parseGiftServiceAction(action, {
      chatId,
      msgId: msg.id,
      receivedAt: timestamp,
      msgSenderPeer: msg.fromId,
      msgPeer: msg.peerId,
    });

    if (!giftEvent) return null;

    // Resolve display identity only for KNOWN senders. An anonymous gift's
    // sender identity must never be resolved or published.
    let isBot = false;
    if (!giftEvent.fromAnonymous) {
      const senderPeer = giftSenderPeer(action, msg.fromId);
      if (senderPeer) {
        const display = await this.resolvePeerDisplay(senderPeer);
        giftEvent.senderUsername = display.senderUsername;
        giftEvent.senderFirstName = display.senderFirstName;
        isBot = display.isBot;
      }
    }

    if (msg.peerId) this.cachePeer(chatId, msg.peerId);

    logGiftEvent(giftEvent);

    // Outer message identity: anonymous gifts must not leak a resolved sender.
    // senderId is a legacy number field; the canonical identity is GiftEvent.senderId.
    const senderId = giftEvent.senderId !== undefined ? Number(giftEvent.senderId) : 0;

    return {
      id: msg.id,
      chatId,
      senderId,
      senderUsername: giftEvent.fromAnonymous ? undefined : giftEvent.senderUsername,
      senderFirstName: giftEvent.fromAnonymous ? undefined : giftEvent.senderFirstName,
      text: formatGiftEventText(giftEvent),
      isGroup: false,
      isChannel: false,
      isBot,
      mentionsMe: true,
      timestamp,
      hasMedia: false,
      _rawPeer: msg.peerId,
      giftEvent,
    };
  }
}
