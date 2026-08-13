import { join } from "node:path";
import type { TelegramConfig } from "../config/schema.js";

const CREATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Resolves a session path without allowing a creator id to alter the directory
 * layout. Creator sessions are deliberately isolated from the legacy default
 * user session and from one another.
 */
export function resolveCreatorSessionPath(
  config: Pick<TelegramConfig, "session_path" | "session_name">,
  creatorId?: string
): string {
  if (!creatorId) {
    return join(config.session_path, `${config.session_name}.txt`);
  }

  if (!CREATOR_ID_PATTERN.test(creatorId)) {
    throw new Error("Creator id must contain only letters, numbers, underscores, or hyphens");
  }

  return join(config.session_path, "creators", creatorId, "telegram_session.txt");
}
