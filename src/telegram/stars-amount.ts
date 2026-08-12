import { Api } from "telegram";
import {
  formatStarsDecimal,
  splitMinimalUnits,
  type NormalizedStarsAmount,
} from "../domain/commerce/stars-amount.js";

export type { NormalizedStarsAmount } from "../domain/commerce/stars-amount.js";

/**
 * Normalize a Telegram StarsAmount / StarsTonAmount into an exact amount.
 *
 * - StarsAmount: `amount` is whole Stars, `nanos` is the nanostar fraction.
 * - StarsTonAmount: `amount` is MINIMAL UNITS (1e-9 TON), so it is split into
 *   whole TON + nanoton fraction via bigint.
 */
export function normalizeStarsAmount(amount: Api.TypeStarsAmount): NormalizedStarsAmount {
  if (amount instanceof Api.StarsAmount) {
    const units = amount.amount.toString();
    const nanos = amount.nanos;
    return {
      asset: "stars",
      units,
      nanos,
      decimal: formatStarsDecimal(units, nanos),
    };
  }
  if (amount instanceof Api.StarsTonAmount) {
    const raw = BigInt(amount.amount.toString());
    const { units, nanos, decimal } = splitMinimalUnits(raw);
    return { asset: "ton", units, nanos, decimal };
  }
  // Monetary corruption is worse than a hard failure.
  throw new Error(
    `Unsupported StarsAmount constructor: ${(amount as { className?: string }).className}`
  );
}
