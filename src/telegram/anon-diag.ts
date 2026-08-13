import { Api } from "telegram";
import { createLogger } from "../utils/logger.js";

const log = createLogger("AnonBotDiag");

/**
 * Minimal diagnostic capture for an unknown anonymous-chat bot protocol.
 *
 * Safely logs only non-sensitive structural facts (update type, message id,
 * text, button kinds) so a future adapter can be built from real protocol
 * observations without leaking secrets or private data.
 *
 * This is opt-in: wire it manually via `onRawUpdate(diagnoseAnonBotUpdate)`.
 * It never sends anything and never performs a button click.
 */
export function diagnoseAnonBotUpdate(update: Api.TypeUpdate): void {
  if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
    const msg = update.message;
    if (!(msg instanceof Api.Message)) return;
    log.info(
      {
        updateType: update.className,
        messageId: msg.id,
        text: truncate(msg.message ?? ""),
        buttonKinds: summarizeButtons(msg),
      },
      "AnonBot update"
    );
    return;
  }

  if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
    const msg = update.message;
    if (!(msg instanceof Api.Message)) return;
    log.info(
      {
        updateType: update.className,
        messageId: msg.id,
        text: truncate(msg.message ?? ""),
        buttonKinds: summarizeButtons(msg),
      },
      "AnonBot edited update"
    );
    return;
  }

  log.info({ updateType: update.className }, "AnonBot other update");
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeButtons(msg: Api.Message): string[] {
  const markup = (msg as unknown as { replyMarkup?: Api.TypeReplyMarkup }).replyMarkup;
  if (!markup) return [];

  try {
    if (markup instanceof Api.ReplyInlineMarkup) {
      return markup.rows.map((row) =>
        row.buttons.map((btn) => (btn as { className?: string }).className ?? "button").join(",")
      );
    }
    if (markup instanceof Api.ReplyKeyboardMarkup) {
      return markup.rows.map((row) =>
        row.buttons.map((btn) => (btn as { className?: string }).className ?? "button").join(",")
      );
    }
    return [];
  } catch {
    return [];
  }
}
