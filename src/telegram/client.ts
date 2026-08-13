import { TelegramClient, Api, client as gramjsClientModule } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline";
import { markdownToTelegramHtml } from "./formatting.js";
import { toLong } from "../utils/gramjs-bigint.js";

import { createLogger } from "../utils/logger.js";

const log = createLogger("Telegram");

function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export interface TelegramClientConfig {
  apiId: number;
  apiHash: string;
  phone: string;
  sessionPath: string;
  connectionRetries?: number;
  retryDelay?: number;
  autoReconnect?: boolean;
  floodSleepThreshold?: number;
  /** If false, connect() will NOT prompt on stdin when the session is missing/invalid. Default: true. */
  interactive?: boolean;
}

export type AuthState = "uninitialized" | "connecting" | "ready" | "auth_required" | "error";

export interface AuthStatus {
  state: AuthState;
  reason?: string;
}

export interface TelegramUser {
  id: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  isBot: boolean;
}

export class TelegramUserClient {
  private client: TelegramClient;
  private config: TelegramClientConfig;
  private connected = false;
  private me?: TelegramUser;
  private authState: AuthState = "uninitialized";

  constructor(config: TelegramClientConfig) {
    this.config = config;

    const sessionString = this.loadSession();
    const session = new StringSession(sessionString);

    const logger = new Logger(LogLevel.NONE);
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: config.connectionRetries ?? 5,
      retryDelay: config.retryDelay ?? 1000,
      autoReconnect: config.autoReconnect ?? true,
      floodSleepThreshold: config.floodSleepThreshold ?? 60,
      baseLogger: logger,
    });
  }

  private loadSession(): string {
    try {
      if (existsSync(this.config.sessionPath)) {
        return readFileSync(this.config.sessionPath, "utf-8").trim();
      }
    } catch (error) {
      log.warn({ err: error }, "Failed to load session");
    }
    return "";
  }

  private saveSession(): void {
    try {
      const sessionString = this.client.session.save() as string | undefined;
      if (typeof sessionString !== "string" || !sessionString) {
        log.warn("No session string to save");
        return;
      }
      const dir = dirname(this.config.sessionPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.config.sessionPath, sessionString, { encoding: "utf-8", mode: 0o600 });
      log.info("Session saved");
    } catch (error) {
      log.error({ err: error }, "Failed to save session");
    }
  }

  getAuthState(): AuthState {
    return this.authState;
  }

  getAuthStatus(): AuthStatus {
    return {
      state: this.authState,
      reason:
        this.authState === "auth_required"
          ? "Session missing, expired, or invalid. Run 'anonka creator login' to authenticate."
          : undefined,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) {
      log.info("Already connected");
      return;
    }

    const interactive = this.config.interactive !== false; // default true

    try {
      this.authState = "connecting";
      const hasSession = existsSync(this.config.sessionPath);

      if (hasSession) {
        await this.client.connect();
      } else if (interactive) {
        log.info("Starting authentication flow...");
        const phone = this.config.phone || (await promptInput("Phone number: "));

        await this.client.connect();

        const sendResult = await this.client.invoke(
          new Api.auth.SendCode({
            phoneNumber: phone,
            apiId: this.config.apiId,
            apiHash: this.config.apiHash,
            settings: new Api.CodeSettings({}),
          })
        );

        if (sendResult instanceof Api.auth.SentCodeSuccess) {
          log.info("Authenticated (SentCodeSuccess)");
          this.saveSession();
        } else if (sendResult instanceof Api.auth.SentCode) {
          const phoneCodeHash = sendResult.phoneCodeHash;

          if (sendResult.type instanceof Api.auth.SentCodeTypeFragmentSms) {
            const url = sendResult.type.url;
            if (url) {
              log.info({ fragmentUrl: url }, "Anonymous number — open this URL to get your code");
              process.stdout.write(`\n  Open this URL to get your code:\n  ${url}\n\n`);
            }
          }

          let authenticated = false;
          const maxAttempts = 3;

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const code = await promptInput("Verification code: ");

            try {
              await this.client.invoke(
                new Api.auth.SignIn({
                  phoneNumber: phone,
                  phoneCodeHash,
                  phoneCode: code,
                })
              );
              authenticated = true;
              break;
            } catch (error: unknown) {
              const errObj = error as Record<string, string>;
              if (errObj.errorMessage === "PHONE_CODE_INVALID") {
                const remaining = maxAttempts - attempt - 1;
                if (remaining > 0) {
                  log.warn({ attemptsRemaining: remaining }, "Invalid authentication code");
                } else {
                  throw new Error("Authentication failed: too many invalid code attempts");
                }
              } else if (errObj.errorMessage === "SESSION_PASSWORD_NEEDED") {
                const pwd = await promptInput("2FA password: ");
                const { computeCheck } = await import("telegram/Password.js");
                const srpResult = await this.client.invoke(new Api.account.GetPassword());
                const srpCheck = await computeCheck(srpResult, pwd);
                await this.client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
                authenticated = true;
                break;
              } else {
                throw error;
              }
            }
          }

          if (!authenticated) {
            throw new Error("Authentication failed");
          }

          log.info("Authenticated");
          this.saveSession();
        } else {
          throw new Error("Unexpected auth response: payment required or unknown type");
        }
      } else {
        // Non-interactive mode: no session file, report AUTH_REQUIRED
        this.authState = "auth_required";
        log.warn("Session file not found and interactive auth is disabled — AUTH_REQUIRED");
        return;
      }

      const me = (await this.client.getMe()) as Api.User;
      this.me = {
        id: BigInt(me.id.toString()),
        username: me.username,
        firstName: me.firstName,
        lastName: me.lastName,
        phone: me.phone,
        isBot: me.bot ?? false,
      };

      this.connected = true;
      this.authState = "ready";
    } catch (error) {
      const errObj = error as Record<string, string>;

      if (!interactive && this.authState !== "auth_required") {
        // Non-interactive mode: session existed but failed to connect (expired/revoked)
        this.authState = "auth_required";
        log.warn(
          { err: error },
          "Session exists but connection failed in non-interactive mode — AUTH_REQUIRED"
        );
        try {
          await this.client.disconnect();
        } catch {
          // best effort
        }
        return;
      }

      this.authState = "error";
      log.error({ err: error }, "Connection error");

      // Preserve known auth-related error info
      if (
        errObj.errorMessage === "AUTH_KEY_UNREGISTERED" ||
        errObj.errorMessage === "SESSION_REVOKED" ||
        errObj.errorMessage === "SESSION_EXPIRED" ||
        errObj.errorMessage === "AUTH_KEY_DUPLICATED"
      ) {
        if (!interactive) {
          this.authState = "auth_required";
          log.warn(
            `Session invalid (${errObj.errorMessage}) in non-interactive mode — AUTH_REQUIRED`
          );
          return;
        }
      }

      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.disconnect();
      this.connected = false;
      log.info("Disconnected");
    } catch (error) {
      log.error({ err: error }, "Disconnect error");
    }
  }

  getMe(): TelegramUser | undefined {
    return this.me;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): TelegramClient {
    return this.client;
  }

  addNewMessageHandler(
    handler: (event: NewMessageEvent) => void | Promise<void>,
    filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
      fromUsers?: number[];
      pattern?: RegExp;
    }
  ): void {
    const wrappedHandler = async (event: NewMessageEvent) => {
      if (process.env.DEBUG) {
        const chatId = event.message.chatId?.toString() ?? "unknown";
        const isGroup = chatId.startsWith("-");
        log.debug(
          { chatId, isGroup, messageLength: event.message.message?.length ?? 0 },
          "RAW EVENT"
        );
      }
      await handler(event);
    };
    this.client.addEventHandler(
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
      wrappedHandler,
      new NewMessage(filters ?? {})
    );
  }

  addServiceMessageHandler(handler: (msg: Api.MessageService) => Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
    this.client.addEventHandler(async (update) => {
      if (
        (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) &&
        update.message instanceof Api.MessageService
      ) {
        await handler(update.message as Api.MessageService);
      }
    });
  }

  addCallbackQueryHandler(handler: (event: unknown) => Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
    this.client.addEventHandler(async (update) => {
      if (
        update.className === "UpdateBotCallbackQuery" ||
        update.className === "UpdateInlineBotCallbackQuery"
      ) {
        await handler(update);
      }
    });
  }

  addEditedMessageHandler(
    handler: (event: { message: Api.Message; chatId: string }) => void | Promise<void>
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
    this.client.addEventHandler(async (update) => {
      let msg: Api.Message | undefined;
      let chatId = "unknown";

      if (update instanceof Api.UpdateEditMessage) {
        msg = update.message as Api.Message;
        chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
      } else if (update instanceof Api.UpdateEditChannelMessage) {
        msg = update.message as Api.Message;
        chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
      }

      if (msg) {
        await handler({ message: msg, chatId });
      }
    });
  }

  async answerCallbackQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS BigInteger queryId
    queryId: any,
    options?: {
      message?: string;
      alert?: boolean;
      url?: string;
    }
  ): Promise<boolean> {
    try {
      await this.client.invoke(
        new Api.messages.SetBotCallbackAnswer({
          queryId: queryId,
          message: options?.message,
          alert: options?.alert,
          url: options?.url,
        })
      );
      return true;
    } catch (error) {
      log.error({ err: error }, "Error answering callback query");
      return false;
    }
  }

  async sendMessage(
    entity: string | Api.TypePeer,
    options: {
      message: string;
      replyTo?: number;
      silent?: boolean;
      parseMode?: "html" | "md" | "md2" | "none";
    }
  ): Promise<Api.Message> {
    const parseMode = options.parseMode ?? "html";
    const formattedMessage =
      parseMode === "html" ? markdownToTelegramHtml(options.message) : options.message;

    return this.client.sendMessage(entity, {
      message: formattedMessage,
      replyTo: options.replyTo,
      silent: options.silent,
      parseMode: parseMode === "none" ? undefined : parseMode,
      linkPreview: false,
    });
  }

  /**
   * Low-level text send that carries OUR random_id into the MTProto request.
   * Mirrors the formatting behaviour of sendMessage() (markdown→HTML for
   * "html" mode, linkPreview disabled) but returns the raw Updates result so
   * the caller can extract the authoritative random_id → message_id mapping.
   */
  async sendMessageLowLevel(
    entity: string | Api.TypePeer,
    options: {
      message: string;
      randomId: bigint;
      replyTo?: number;
      silent?: boolean;
      parseMode?: "html" | "md" | "md2" | "none";
      linkPreview?: boolean;
      replyMarkup?: Api.TypeReplyMarkup;
    }
  ): Promise<Api.TypeUpdates> {
    const inputPeer = await this.client.getInputEntity(entity);
    const parseMode = options.parseMode ?? "html";
    const formattedMessage =
      parseMode === "html" ? markdownToTelegramHtml(options.message) : options.message;

    const [parsedMessage, entities] = await gramjsClientModule.messageParse._parseMessageText(
      this.client,
      formattedMessage,
      parseMode === "none" ? false : parseMode
    );

    if (!parsedMessage) {
      throw new Error("The message cannot be empty unless a file is provided");
    }

    const replyTo =
      options.replyTo !== undefined
        ? new Api.InputReplyToMessage({ replyToMsgId: options.replyTo })
        : undefined;

    const request = new Api.messages.SendMessage({
      peer: inputPeer,
      message: parsedMessage,
      entities,
      randomId: toLong(options.randomId),
      replyTo,
      silent: options.silent,
      noWebpage: options.linkPreview === false ? true : undefined,
      replyMarkup: options.replyMarkup,
    });

    return this.client.invoke(request);
  }

  /**
   * Low-level media send carrying OUR random_id. The caller builds the
   * InputMedia (upload happens outside) and receives the raw Updates result.
   */
  async sendMediaLowLevel(
    entity: string | Api.TypePeer,
    options: {
      media: Api.TypeInputMedia;
      message?: string;
      randomId: bigint;
      replyTo?: number;
      silent?: boolean;
      replyMarkup?: Api.TypeReplyMarkup;
    }
  ): Promise<Api.TypeUpdates> {
    const inputPeer = await this.client.getInputEntity(entity);

    const replyTo =
      options.replyTo !== undefined
        ? new Api.InputReplyToMessage({ replyToMsgId: options.replyTo })
        : undefined;

    const request = new Api.messages.SendMedia({
      peer: inputPeer,
      media: options.media,
      message: options.message ?? "",
      randomId: toLong(options.randomId),
      replyTo,
      silent: options.silent,
      replyMarkup: options.replyMarkup,
    });

    return this.client.invoke(request);
  }

  /**
   * Build an InputMedia from a file, uploading it if necessary.
   * The upload itself happens before any SendMedia request, so an upload
   * failure is a definite failure (no message was created).
   */
  async buildInputMedia(options: {
    file: string | Buffer;
    forceDocument?: boolean;
    attributes?: Api.TypeDocumentAttribute[];
    videoNote?: boolean;
    supportsStreaming?: boolean;
    mimeType?: string;
  }): Promise<Api.TypeInputMedia> {
    const { media } = await gramjsClientModule.uploads._fileToMedia(this.client, {
      file: options.file,
      forceDocument: options.forceDocument ?? false,
      attributes: options.attributes,
      videoNote: options.videoNote ?? false,
      supportsStreaming: options.supportsStreaming ?? false,
      mimeType: options.mimeType,
    });

    if (!media) {
      throw new Error(
        `Cannot use ${typeof options.file === "string" ? options.file : "buffer"} as file.`
      );
    }

    return media;
  }

  /** Low-level forward carrying OUR random_ids. */
  async forwardMessagesLowLevel(
    fromPeer: string | Api.TypePeer,
    toPeer: string | Api.TypePeer,
    ids: number[],
    randomIds: bigint[]
  ): Promise<Api.TypeUpdates> {
    const request = new Api.messages.ForwardMessages({
      fromPeer,
      toPeer,
      id: ids,
      randomId: randomIds.map((id) => toLong(id)),
    });

    return this.client.invoke(request);
  }

  /**
   * Raw update hook for Api.UpdateMessageID — the authoritative
   * random_id → message_id acknowledgement Telegram pushes for sends.
   */
  addUpdateMessageIdHandler(handler: (update: Api.UpdateMessageID) => void | Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
    this.client.addEventHandler(async (update) => {
      if (update instanceof Api.UpdateMessageID) {
        await handler(update);
      }
    });
  }

  /**
   * Narrow raw-update escape hatch for the future AnonAdapter.
   *
   * Receives typed Api.TypeUpdate objects (not arbitrary raw Telegram API)
   * so an adapter can observe protocol signals that do not fit the DTO.
   */
  addRawUpdateHandler(handler: (update: Api.TypeUpdate) => void | Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- GramJS event handler accepts async
    this.client.addEventHandler(async (update) => {
      await handler(update as Api.TypeUpdate);
    });
  }

  async getMessages(
    entity: string | Api.TypePeer,
    options?: {
      limit?: number;
      offsetId?: number;
      search?: string;
    }
  ): Promise<Api.Message[]> {
    const messages = await this.client.getMessages(entity, {
      limit: options?.limit ?? 100,
      offsetId: options?.offsetId,
      search: options?.search,
    });
    return messages;
  }

  async getDialogs(): Promise<
    Array<{
      id: bigint;
      title: string;
      isGroup: boolean;
      isChannel: boolean;
    }>
  > {
    const dialogs = await this.client.getDialogs({});
    return dialogs.map((d) => ({
      id: BigInt(d.id?.toString() ?? "0"),
      title: d.title ?? "Unknown",
      isGroup: d.isGroup,
      isChannel: d.isChannel,
    }));
  }

  async setTyping(entity: string): Promise<void> {
    try {
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: entity,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch {
      // setTyping() is cosmetic — ignore FloodWait, permission errors, etc.
    }
  }

  async getEntity(entity: string): Promise<Api.TypeUser | Api.TypeChat> {
    return await this.client.getEntity(entity);
  }
}
