import { createLogger } from "../utils/logger.js";

const log = createLogger("OutgoingTracker");

interface PendingSend {
  chatId: string;
  randomId: bigint;
  timestamp: number;
}

/**
 * In-memory outgoing correlation tracker.
 *
 * Phase 0 spike: tracks pending sends by randomId so we can distinguish
 * programmatic outgoing messages from manual creator messages when
 * the outgoing update arrives back from Telegram.
 *
 * Phase 1 replacement: durable Outbox table in creator.db.
 */
export class OutgoingTracker {
  /** Pending sends, keyed by randomId string for fast lookup. */
  private pending = new Map<string, PendingSend>();
  /** Maximum age for a pending entry before eviction (ms). */
  private maxAgeMs: number;
  /** Cleanup timer interval. */
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(maxAgeMs = 30_000) {
    this.maxAgeMs = maxAgeMs;
  }

  /** Record a pending send before the network call. */
  record(chatId: string, randomId: bigint): void {
    const key = randomId.toString();
    this.pending.set(key, {
      chatId,
      randomId,
      timestamp: Date.now(),
    });
    log.debug(`Tracked pending send: ${chatId}:${key}`);
  }

  /** Check and consume a pending send match. Returns true if found. */
  consume(chatId: string, randomId: bigint): boolean {
    const key = randomId.toString();
    const entry = this.pending.get(key);
    if (!entry) return false;

    const match = entry.chatId === chatId;
    this.pending.delete(key);
    if (match) {
      log.debug(`Matched outgoing: ${chatId}:${key}`);
    }
    return match;
  }

  /**
   * Heuristic check: is there any recent pending send for this chat?
   * Used when the randomId isn't directly available on the update.
   * Consumes the oldest matching entry if found.
   */
  consumeByChat(chatId: string): { matched: boolean; randomId?: bigint } {
    let oldest: PendingSend | undefined;
    let oldestKey: string | undefined;

    for (const [key, entry] of this.pending) {
      if (entry.chatId !== chatId) continue;
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = entry;
        oldestKey = key;
      }
    }

    if (oldest && oldestKey) {
      this.pending.delete(oldestKey);
      log.debug(`Matched outgoing by chat: ${chatId}`);
      return { matched: true, randomId: oldest.randomId };
    }

    return { matched: false };
  }

  /** Check if this outgoing message is programmatic (has a pending send). Does NOT consume. */
  isProgrammatic(chatId: string, randomId: bigint): boolean {
    const key = randomId.toString();
    const entry = this.pending.get(key);
    return entry !== undefined && entry.chatId === chatId;
  }

  /** Start periodic cleanup of stale entries. */
  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs);
    this.cleanupInterval.unref?.();
  }

  /** Stop cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Remove entries older than maxAgeMs. */
  private cleanup(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    let removed = 0;
    for (const [key, entry] of this.pending) {
      if (entry.timestamp < cutoff) {
        this.pending.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      log.debug(`Cleaned up ${removed} stale pending sends`);
    }
  }

  /** Number of currently pending entries. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Clear all pending entries (for shutdown). */
  clear(): void {
    this.pending.clear();
  }
}

/** Singleton tracker shared across all send operations. */
export const outgoingTracker = new OutgoingTracker();
