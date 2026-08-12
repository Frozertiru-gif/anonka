import { Api, errors } from "telegram";

export interface SentMessageResult {
  messageId: number;
  date: number;
}

export type SendFailureClass = "definite" | "ambiguous";

/**
 * Telegram RPC error codes where the request was definitively rejected
 * BEFORE any message was created:
 * - 303 migrate (must be repeated on another DC; not executed here);
 * - 400 bad request / validation;
 * - 401 unauthorized (session rejected);
 * - 403 forbidden / permission;
 * - 404 not found;
 * - 406 auth-key;
 * - 420 FLOOD (FLOOD_WAIT / SLOWMODE_WAIT — rejected before send).
 */
const DEFINITE_REJECTION_CODES = new Set([303, 400, 401, 403, 404, 406, 420]);

/**
 * Definite vs ambiguous send failure.
 *
 * "definite" = we are confident Telegram rejected the request and NO message
 * was created. Only then may the pending correlation be dropped.
 *
 * "ambiguous" = we cannot prove the message was not accepted (5xx, INTERNAL*,
 * TIMEOUT-like server errors, RANDOM_ID_DUPLICATE, transport/network errors,
 * unknown errors). The correlation MUST be preserved and a retry must reuse
 * the same random_id — a false "definite" would otherwise produce a duplicate
 * message on retry.
 *
 * Conservative default: doubt → ambiguous.
 */
export function classifySendFailure(error: unknown): SendFailureClass {
  if (!(error instanceof errors.RPCError)) {
    // Non-RPC errors: FLOOD_WAIT-shaped plain errors from flood-retry.ts are
    // definite (server explicitly rejected); everything else is ambiguous.
    const err = error as { seconds?: unknown; message?: unknown };
    if (typeof err.seconds === "number") return "definite";
    if (typeof err.message === "string" && err.message.startsWith("FLOOD_WAIT")) {
      return "definite";
    }
    return "ambiguous";
  }

  // RANDOM_ID_DUPLICATE means "this random_id is already known" — the previous
  // attempt may already have been accepted. Never treat it as definite.
  if (error.errorMessage === "RANDOM_ID_DUPLICATE") return "ambiguous";

  const code = error.code;

  // Server-side / transient failures: cannot prove the message was not created.
  // Includes positive 5xx and witnessed negative codes (-500, -503).
  if (code !== undefined && (code >= 500 || code < 0)) return "ambiguous";

  // Known client-side rejection codes: message was definitely not created.
  if (code !== undefined && DEFINITE_REJECTION_CODES.has(code)) return "definite";

  // Unknown or missing code: conservative default.
  return "ambiguous";
}

/** Convenience wrapper: true only for proven rejection. */
export function isDefiniteSendFailure(error: unknown): boolean {
  return classifySendFailure(error) === "definite";
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
