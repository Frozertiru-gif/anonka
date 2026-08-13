import { loadConfig } from "../../config/loader.js";
import { TelegramUserClient } from "../../telegram/client.js";
import { resolveCreatorSessionPath } from "../../telegram/creator-session.js";
import {
  TELEGRAM_CONNECTION_RETRIES,
  TELEGRAM_FLOOD_SLEEP_THRESHOLD,
} from "../../constants/limits.js";

/**
 * The only CLI path allowed to request Telegram credentials over stdin.
 * Workers use the same session path but always connect non-interactively.
 */
export async function creatorLoginCommand(creatorId: string, configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const { api_id: apiId, api_hash: apiHash, phone } = config.telegram;
  if (config.telegram.mode !== "user" || !apiId || !apiHash || !phone) {
    throw new Error("Creator login requires telegram.mode: user.");
  }

  const client = new TelegramUserClient({
    apiId,
    apiHash,
    phone,
    sessionPath: resolveCreatorSessionPath(config.telegram, creatorId),
    connectionRetries: TELEGRAM_CONNECTION_RETRIES,
    autoReconnect: true,
    floodSleepThreshold: TELEGRAM_FLOOD_SLEEP_THRESHOLD,
    interactive: true,
  });

  try {
    await client.connect();
    if (client.getAuthState() !== "ready") {
      throw new Error("Telegram authentication did not complete.");
    }
    process.stdout.write(`Creator '${creatorId}' Telegram session saved.\n`);
  } finally {
    await client.disconnect();
  }
}
