import type { GiftSenderResolver } from "../domain/commerce/gift-ledger.js";

/**
 * Resolve the known conversation user for a chat, reusing the Telegram
 * chatId convention already used across the project (see handlers.ts
 * `isGroup` detection and the user bridge `parseMessage`).
 *
 * In Telegram a private chat's id IS the peer user's id (a non-negative
 * number), so for a DM the conversation user is simply `chatId`. Groups and
 * channels (negative ids) have no single conversation user.
 */
export function createConversationSenderResolver(): GiftSenderResolver {
  return (chatId: string): string | undefined => {
    if (chatId.startsWith("-")) return undefined;
    return chatId;
  };
}
