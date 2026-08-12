import { createLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

const log = createLogger("OutgoingTracker");

/**
 * Lifecycle of one programmatic outgoing send:
 *
 *   RESERVED → SENDING → ACKNOWLEDGED → OBSERVED
 *                  ↘ AMBIGUOUS (network failure, may still be retried with the same randomId)
 *
 * Records are removed on definite failure (Telegram responded with an error —
 * the message was never sent) and expired by TTL on stale/ambiguous states.
 * ACKNOWLEDGED/OBSERVED records are retained briefly so duplicate outgoing
 * updates are still classified as programmatic.
 */
export type PendingSendState = "RESERVED" | "SENDING" | "ACKNOWLEDGED" | "OBSERVED" | "AMBIGUOUS";

export interface PendingSend {
  chatId: string;
  randomId: bigint;
  state: PendingSendState;
  telegramMessageId?: number;
  reservedAt: number;
  stateUpdatedAt: number;
  attempts: number;
  lastError?: string;
}

/** A send that never reaches an acknowledgement within this window is dead. */
const RESERVED_TTL_MS = 60_000;
/** Keep acknowledged/observed records to dedupe replayed outgoing updates. */
const OBSERVED_RETENTION_MS = 120_000;
/** Ambiguous network failures keep the correlation available longer. */
const AMBIGUOUS_TTL_MS = 300_000;
/** Cleanup sweep interval. */
const CLEANUP_INTERVAL_MS = 30_000;
/** Bounded wait for an exact ack when classifying an outgoing self-event. */
const OUTGOING_ACK_WAIT_MS = 500;
const OUTGOING_ACK_POLL_MS = 25;

function messageKey(chatId: string, telegramMessageId: number): string {
  return `${chatId}:${telegramMessageId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Authoritative correlation store for programmatic outgoing messages.
 *
 * Classification is EXACT ONLY:
 * - randomId is the MTProto correlation primitive;
 * - (chatId, telegramMessageId) is the exact observed-message key.
 *
 * There is deliberately no chat/text/time heuristic fallback: an outgoing
 * message without an exact binding is always creator_manual.
 */
export class OutgoingTracker {
  private byRandomId = new Map<string, PendingSend>();
  private byMessageKey = new Map<string, PendingSend>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  /** Register a correlation BEFORE the network call. */
  reserve(chatId: string, randomId: bigint): void {
    const key = randomId.toString();
    if (this.byRandomId.has(key)) {
      log.warn(
        { chatId, randomId: key },
        "outgoing_correlation_mismatch: randomId already reserved"
      );
      return;
    }
    const now = Date.now();
    this.byRandomId.set(key, {
      chatId,
      randomId,
      state: "RESERVED",
      reservedAt: now,
      stateUpdatedAt: now,
      attempts: 0,
    });
    log.debug({ chatId, randomId: key, state: "RESERVED" }, "outgoing_reserved");
  }

  /** Transition to SENDING before the network attempt. Safe to call on retries. */
  markSending(randomId: bigint): void {
    const record = this.byRandomId.get(randomId.toString());
    if (!record) return;
    record.state = "SENDING";
    record.attempts += 1;
    record.stateUpdatedAt = Date.now();
  }

  /**
   * Bind randomId → telegramMessageId from an authoritative source
   * (RPC result UpdateMessageID or raw update stream).
   *
   * Idempotent: a repeated acknowledgement with the same values is a no-op.
   * A chatId mismatch is a suspicious correlation mismatch: the record is
   * preserved untouched and false is returned.
   */
  acknowledge(randomId: bigint, telegramMessageId: number, chatId?: string): boolean {
    const key = randomId.toString();
    const record = this.byRandomId.get(key);
    if (!record) {
      log.debug(
        { randomId: key, telegramMessageId },
        "outgoing_rpc_ack: no pending record (late or foreign acknowledgement)"
      );
      return false;
    }

    if (chatId !== undefined && record.chatId !== chatId) {
      log.warn(
        {
          randomId: key,
          telegramMessageId,
          expectedChatId: record.chatId,
          actualChatId: chatId,
        },
        "outgoing_correlation_mismatch"
      );
      return false;
    }

    if (record.telegramMessageId !== undefined) {
      if (record.telegramMessageId === telegramMessageId) {
        return true; // duplicate ack of an already bound send — no-op
      }
      log.warn(
        {
          randomId: key,
          boundMessageId: record.telegramMessageId,
          conflictingMessageId: telegramMessageId,
        },
        "outgoing_correlation_mismatch"
      );
      return false;
    }

    record.telegramMessageId = telegramMessageId;
    record.state = "ACKNOWLEDGED";
    record.stateUpdatedAt = Date.now();
    this.byMessageKey.set(messageKey(record.chatId, telegramMessageId), record);
    log.debug(
      { chatId: record.chatId, randomId: key, telegramMessageId, state: "ACKNOWLEDGED" },
      "outgoing_rpc_ack"
    );
    return true;
  }

  /** Non-mutating exact lookup of an observed message. */
  peek(chatId: string, telegramMessageId: number): PendingSend | undefined {
    return this.byMessageKey.get(messageKey(chatId, telegramMessageId));
  }

  /**
   * Exact observation of an outgoing message. Only a record bound via
   * acknowledge() is ever classified programmatic — nothing else.
   * Idempotent: repeated observation of the same message stays programmatic.
   */
  observe(chatId: string, telegramMessageId: number): "programmatic" | "creator_manual" {
    const record = this.byMessageKey.get(messageKey(chatId, telegramMessageId));
    if (!record) {
      return "creator_manual";
    }
    if (record.state === "ACKNOWLEDGED") {
      record.state = "OBSERVED";
      record.stateUpdatedAt = Date.now();
    }
    log.debug(
      { chatId, telegramMessageId, randomId: record.randomId.toString() },
      "outgoing_observed_programmatic"
    );
    return "programmatic";
  }

  /**
   * Classify an outgoing self-event. Exact matching only, with a short
   * bounded wait for the acknowledgement when the outgoing update raced
   * ahead of the RPC result. Never guesses from chat/text/time.
   */
  async classifyOutgoing(
    chatId: string,
    telegramMessageId: number,
    opts?: { waitMs?: number; pollMs?: number }
  ): Promise<"programmatic" | "creator_manual"> {
    const immediate = this.observe(chatId, telegramMessageId);
    if (immediate === "programmatic") return immediate;

    const waitMs = opts?.waitMs ?? OUTGOING_ACK_WAIT_MS;
    const pollMs = opts?.pollMs ?? OUTGOING_ACK_POLL_MS;
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (this.peek(chatId, telegramMessageId)) {
        return this.observe(chatId, telegramMessageId);
      }
    }

    log.debug({ chatId, telegramMessageId }, "outgoing_observed_manual");
    return "creator_manual";
  }

  /** Definite failure: Telegram rejected the request, the message was never sent. */
  markDefiniteFailure(randomId: bigint, error: unknown): void {
    const key = randomId.toString();
    const record = this.byRandomId.get(key);
    if (!record) return;

    this.byRandomId.delete(key);
    if (record.telegramMessageId !== undefined) {
      this.byMessageKey.delete(messageKey(record.chatId, record.telegramMessageId));
    }
    log.debug(
      { chatId: record.chatId, randomId: key, state: "FAILED", error: getErrorMessage(error) },
      "outgoing_send_failed"
    );
  }

  /**
   * Ambiguous failure: the request may or may not have reached Telegram.
   * The record (and its randomId) is kept so a retry can reuse the SAME
   * correlation primitive and a late acknowledgement can still bind.
   */
  markAmbiguousFailure(randomId: bigint, error: unknown): void {
    const record = this.byRandomId.get(randomId.toString());
    if (!record) return;

    record.state = "AMBIGUOUS";
    record.stateUpdatedAt = Date.now();
    record.lastError = getErrorMessage(error);
    log.debug(
      {
        chatId: record.chatId,
        randomId: randomId.toString(),
        state: "AMBIGUOUS",
        error: record.lastError,
      },
      "outgoing_send_failed"
    );
  }

  getByRandomId(randomId: bigint): PendingSend | undefined {
    return this.byRandomId.get(randomId.toString());
  }

  /** Expire stale records. Returns the number of records removed. */
  cleanupStale(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, record] of this.byRandomId) {
      const age = now - record.stateUpdatedAt;
      let expired = false;

      if (record.state === "RESERVED" || record.state === "SENDING") {
        expired = age > RESERVED_TTL_MS;
      } else if (record.state === "AMBIGUOUS") {
        expired = age > AMBIGUOUS_TTL_MS;
      } else {
        expired = age > OBSERVED_RETENTION_MS;
      }

      if (expired) {
        if (record.telegramMessageId !== undefined) {
          this.byMessageKey.delete(messageKey(record.chatId, record.telegramMessageId));
        }
        this.byRandomId.delete(key);
        removed += 1;
        log.debug(
          { chatId: record.chatId, randomId: key, state: record.state },
          "outgoing_correlation_expired"
        );
      }
    }
    return removed;
  }

  /** Start the periodic cleanup sweep. Timer is unref'd so it never blocks exit. */
  startCleanup(intervalMs: number = CLEANUP_INTERVAL_MS): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupStale();
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  clear(): void {
    this.byRandomId.clear();
    this.byMessageKey.clear();
  }

  get pendingCount(): number {
    return this.byRandomId.size;
  }
}

/** Singleton tracker shared across all send operations in this process. */
export const outgoingTracker = new OutgoingTracker();
