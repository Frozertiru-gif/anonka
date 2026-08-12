import { Api, errors } from "telegram";

export interface SentMessageResult {
  messageId: number;
  date: number;
}

/**
 * Definite vs ambiguous send failure.
 *
 * A Telegram RPC error means the server received and REJECTED the request —
 * the message was never sent, so the pending correlation can be dropped and
 * a retry may safely generate fresh state. FLOOD_WAIT is also definite
 * (server rejected; the message was not accepted), including the plain
 * "FLOOD_WAIT ... exceeds max" Error thrown by flood-retry.ts.
 *
 * Everything else (ECONNRESET, socket hang up, timeouts, transport errors)
 * is ambiguous: the request may have reached Telegram. The correlation must
 * be preserved and any retry must reuse the same random_id.
 */
export function isDefiniteSendFailure(error: unknown): boolean {
  if (error instanceof errors.RPCError) return true;

  const err = error as { seconds?: unknown; message?: unknown };
  if (typeof err.seconds === "number") return true;
  if (typeof err.message === "string" && err.message.startsWith("FLOOD_WAIT")) return true;

  return false;
}

/**
 * Collect all random_id → message_id mappings from an Updates RPC result.
 * Uses the typed `Api.UpdateMessageID` constructor, which is the
 * authoritative Telegram acknowledgement primitive.
 */
export function extractMessageIdMappings(result: Api.TypeUpdates): Map<string, number> {
  const mappings = new Map<string, number>();

  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    for (const update of result.updates) {
      if (update instanceof Api.UpdateMessageID && update.randomId !== undefined) {
        mappings.set(update.randomId.toString(), update.id);
      }
    }
  } else if (result instanceof Api.UpdateShort) {
    const update = result.update;
    if (update instanceof Api.UpdateMessageID && update.randomId !== undefined) {
      mappings.set(update.randomId.toString(), update.id);
    }
  }

  return mappings;
}

/**
 * Resolve the sent message for our specific randomId from an Updates result.
 *
 * Handles every result shape `messages.SendMessage` / `messages.SendMedia` /
 * `messages.ForwardMessages` can return in GramJS 2.32:
 *
 * - `Updates` / `UpdatesCombined`: UpdateMessageID + UpdateNewMessage entries.
 * - `UpdateShortSentMessage`: a direct single-message response — the message
 *   id belongs to our send by construction (the response is our RPC result).
 * - `UpdateShortMessage` / `UpdateShortChatMessage` with `out=true`: direct
 *   single-message responses to our request.
 *
 * Returns undefined only when the mapping cannot be extracted — callers must
 * treat that as an ambiguous state, never as a guess.
 */
export function extractSentMessageResult(
  result: Api.TypeUpdates,
  randomId: bigint
): SentMessageResult | undefined {
  if (result instanceof Api.UpdateShortSentMessage) {
    return { messageId: result.id, date: result.date };
  }

  if (result instanceof Api.UpdateShortMessage) {
    if (result.out) {
      return { messageId: result.id, date: result.date };
    }
    return undefined;
  }

  if (result instanceof Api.UpdateShortChatMessage) {
    if (result.out) {
      return { messageId: result.id, date: result.date };
    }
    return undefined;
  }

  const mappings = extractMessageIdMappings(result);
  const messageId = mappings.get(randomId.toString());
  if (messageId === undefined) {
    return undefined;
  }

  let date = Math.floor(Date.now() / 1000);
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    for (const update of result.updates) {
      if (
        (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) &&
        update.message instanceof Api.Message &&
        update.message.id === messageId
      ) {
        date = update.message.date;
        break;
      }
    }
  }

  return { messageId, date };
}
